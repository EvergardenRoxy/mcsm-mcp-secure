#!/usr/bin/env node
/**
 * mcsm-mcp-secure — least-privilege MCP server for MCSManager V10.
 *
 * Security model
 *  - The panel address, instance IDs and permissions live in config.json;
 *    the API key lives in a SEPARATE file (api-key) or the MCSM_API_KEY env var.
 *    The MCP client config (e.g. claude_desktop_config.json) only needs the
 *    PATH to config.json, so no secret or address ends up in it.
 *  - Both files must be unreadable by group/others (chmod 600) or the server refuses to start.
 *  - Public panels must use https. Plain http is only accepted for loopback hosts
 *    (or when allow_insecure_http is set explicitly).
 *  - Only instances listed in config.json are reachable; arbitrary UUIDs are impossible.
 *  - Write-capable tools are NOT registered unless enabled in config.json -> the model cannot even see them.
 *  - The key and panel origin are scrubbed from every tool result and error message.
 *  - Redirects are never followed (so the key can't be forwarded to another host).
 *  - stdout is reserved for the MCP protocol; all logging goes to stderr.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// ---------------------------------------------------------------- logging --
const log = (...a) => console.error('[mcsm-mcp]', ...a);
function fatal(msg) {
  console.error('[mcsm-mcp] 启动失败: ' + msg);
  process.exit(1);
}

// ----------------------------------------------------------------- config --
const HOME_DIR = process.env.MCSM_MCP_HOME || path.join(os.homedir(), '.config', 'mcsm-mcp');
const CONFIG_PATH = path.resolve(process.env.MCSM_MCP_CONFIG || path.join(HOME_DIR, 'config.json'));
const CONFIG_DIR = path.dirname(CONFIG_PATH);
const AUDIT_PATH = path.resolve(process.env.MCSM_MCP_AUDIT || path.join(CONFIG_DIR, 'audit.log'));

const ConfigSchema = z
  .object({
    base_url: z.string().min(1),
    api_key_file: z.string().optional(),
    allow_insecure_http: z.boolean().default(false),
    default_instance: z.string().optional(),
    instances: z
      .record(
        z.object({
          uuid: z.string().min(1),
          daemon_id: z.string().min(1),
          description: z.string().optional(),
        }).strict(),
      )
      .default({}),
    // Opt-in "wildcard" mode: no need to list instances one by one. The server discovers every
    // node/instance the key can see (needs an ADMIN key) and lets tools address them by nickname or UUID.
    wildcard: z
      .object({
        enabled: z.boolean().default(false),
        allowed_daemons: z.array(z.string()).default([]), // [] = all nodes; otherwise only these node UUIDs
      })
      .strict()
      .default({}),
    allow: z
      .object({
        read_files: z.boolean().default(true),
        write_files: z.boolean().default(false),
        send_command: z.boolean().default(false),
        power: z.boolean().default(false),
        kill: z.boolean().default(false),
      })
      .strict()
      .default({}),
    blocked_command_prefixes: z.array(z.string()).default(['stop', 'op ', 'deop ', 'save-off']),
    rate_limit_per_minute: z.number().int().min(1).max(600).default(60),
    max_output_chars: z.number().int().min(500).max(100000).default(8000),
    request_timeout_ms: z.number().int().min(1000).max(120000).default(20000),
  })
  .strict()
  .refine((c) => c.wildcard.enabled || Object.keys(c.instances).length > 0, {
    message: '至少需要配置一个实例（或启用 wildcard）',
    path: ['instances'],
  });

function checkPerms(file, label) {
  if (process.platform === 'win32') return; // POSIX modes don't apply
  const mode = fs.statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0 && process.env.MCSM_MCP_ALLOW_LOOSE_PERMS !== '1') {
    fatal(`${label} (${file}) 权限过宽 (${mode.toString(8)})，其他用户可读。请执行: chmod 600 "${file}"`);
  }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) fatal(`找不到配置文件 ${CONFIG_PATH}，请参考 config.example.json`);
  checkPerms(CONFIG_PATH, '配置文件');

  let raw;
  try {
    // Strip a UTF-8 BOM: Windows Notepad / PowerShell "-Encoding UTF8" often add one.
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    // Deliberately no parser message: it could quote file content.
    fatal('配置文件不是合法 JSON（请检查逗号、引号）');
  }
  if (raw && typeof raw === 'object' && 'api_key' in raw) {
    fatal('配置文件中不允许直接写 api_key。请把密钥放进单独的密钥文件（api_key_file）或环境变量 MCSM_API_KEY');
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    fatal('配置无效: ' + parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
  }
  const cfg = parsed.data;

  if (cfg.default_instance && !cfg.instances[cfg.default_instance]) {
    fatal(`default_instance "${cfg.default_instance}" 不在 instances 中`);
  }

  // --- API key: env var, or a separate file ---
  let key = process.env.MCSM_API_KEY?.trim();
  if (!key) {
    const keyFile = path.resolve(CONFIG_DIR, cfg.api_key_file ?? 'api-key');
    if (!fs.existsSync(keyFile)) fatal(`找不到密钥文件 ${keyFile}（或设置环境变量 MCSM_API_KEY）`);
    checkPerms(keyFile, '密钥文件');
    key = fs.readFileSync(keyFile, 'utf8').trim();
  }
  if (!key || /\s/.test(key)) fatal('API 密钥为空或包含空白字符');

  // --- panel address ---
  let u;
  try {
    u = new URL(cfg.base_url);
  } catch {
    fatal('base_url 不是有效的 URL');
  }
  if (!['http:', 'https:'].includes(u.protocol)) fatal('base_url 只支持 http(s)');
  if (u.username || u.password) fatal('base_url 不能包含账号密码');
  if (u.search || u.hash) fatal('base_url 不能包含查询参数或锚点（密钥由程序自动附加）');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol === 'http:' && !loopback && !cfg.allow_insecure_http) {
    fatal('非本机地址必须使用 https，否则 API 密钥会以明文在公网传输。（确需内网 http，请显式设置 allow_insecure_http: true）');
  }
  return {
    cfg,
    key,
    base: { origin: u.origin, prefix: u.pathname.replace(/\/+$/, ''), host: u.hostname, loopback },
  };
}

const { cfg: CFG, key: KEY, base: BASE } = loadConfig();

// ------------------------------------------------------------ redaction ----
const SECRETS = [BASE.origin, KEY, encodeURIComponent(KEY), ...(BASE.loopback ? [] : [BASE.host])].filter(
  (s) => s && s.length >= 4,
);
function redact(s) {
  let out = String(s);
  for (const x of SECRETS) out = out.split(x).join('<redacted>');
  return out;
}

// ------------------------------------------------------------ http client --
class McsmError extends Error {}
const STATUS_HINT = { 400: '（请求参数错误）', 403: '（权限不足或密钥无效）', 500: '（面板内部错误）' };

const hits = [];
function rateLimit() {
  const now = Date.now();
  while (hits.length && now - hits[0] > 60_000) hits.shift();
  if (hits.length >= CFG.rate_limit_per_minute) {
    throw new McsmError(`触发本地限流（每分钟最多 ${CFG.rate_limit_per_minute} 次请求），请稍后再试`);
  }
  hits.push(now);
}

async function api(method, endpoint, { query = {}, body } = {}) {
  rateLimit();
  const url = new URL(BASE.origin + BASE.prefix + endpoint);
  url.searchParams.set('apikey', KEY);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'X-Requested-With': 'XMLHttpRequest', // required by the MCSM API
        'Content-Type': 'application/json; charset=utf-8',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error', // never forward the key to a redirect target
      signal: AbortSignal.timeout(CFG.request_timeout_ms),
    });
  } catch (e) {
    const reason = e?.name === 'TimeoutError' ? '请求超时' : e?.cause?.code || '网络错误或收到重定向（已拒绝跟随）';
    throw new McsmError(`无法连接面板: ${reason}`);
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new McsmError(`面板返回了非 JSON 内容 (HTTP ${res.status})，请检查 base_url 是否指向 MCSManager 面板`);
  }
  // MCSM puts its own status code in the JSON body (a number).
  if (Number(json?.status) !== 200) {
    const detail = typeof json?.data === 'string' ? json.data : JSON.stringify(json?.data ?? '');
    throw new McsmError(`面板返回 status=${json?.status}${STATUS_HINT[json?.status] ?? ''}: ${detail.slice(0, 300)}`);
  }
  return json.data;
}

// ---------------------------------------------------------------- helpers --
const ANSI = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const clean = (s) => String(s ?? '').replace(ANSI, '').replace(/\r\n?/g, '\n');
function limitText(s, keep = 'tail') {
  if (s.length <= CFG.max_output_chars) return s;
  if (keep === 'head') return s.slice(0, CFG.max_output_chars) + `\n…（已截断，仅显示开头 ${CFG.max_output_chars} 字符）`;
  return `…（已截断，仅显示末尾 ${CFG.max_output_chars} 字符）\n` + s.slice(-CFG.max_output_chars);
}
const ok = (t) => ({ content: [{ type: 'text', text: redact(t) }] });
function fail(e) {
  if (!(e instanceof McsmError)) log('内部错误:', redact(e?.stack || e));
  const msg = e instanceof McsmError ? e.message : `内部错误: ${e?.name || 'Error'}`;
  return { isError: true, content: [{ type: 'text', text: redact(msg) }] };
}
const wrap = (fn) => async (args) => {
  try {
    return await fn(args ?? {});
  } catch (e) {
    return fail(e);
  }
};

function audit(tool, instance, detail, outcome) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), tool, instance, detail: redact(detail), outcome });
    fs.appendFileSync(AUDIT_PATH, line + '\n', { mode: 0o600 });
  } catch {
    log('审计日志写入失败');
  }
}

// ---- wildcard discovery (only used when wildcard.enabled) ----
const WILD = CFG.wildcard;
let discovered = []; // [{ uuid, daemonId, nickname, node, status }]
let discoveredAt = 0;

async function discover() {
  const daemons = await api('GET', '/api/service/remote_services_list'); // admin-only on the panel
  const out = [];
  for (const d of Array.isArray(daemons) ? daemons : []) {
    if (WILD.allowed_daemons.length > 0 && !WILD.allowed_daemons.includes(d.uuid)) continue;
    if (!d.available) continue;
    let page = 1;
    let maxPage = 1;
    do {
      const r = await api('GET', '/api/service/remote_service_instances', {
        query: { daemonId: d.uuid, page, page_size: 50 },
      });
      maxPage = Number(r?.maxPage) || 1;
      for (const i of r?.data ?? []) {
        out.push({ uuid: i.instanceUuid, daemonId: d.uuid, nickname: String(i.config?.nickname ?? ''), node: String(d.remarks ?? ''), status: i.status });
      }
      page++;
    } while (page <= maxPage && page <= 20);
  }
  discovered = out;
  discoveredAt = Date.now();
  return out;
}

async function resolveInstance(alias) {
  const names = Object.keys(CFG.instances);
  const name = alias ?? CFG.default_instance ?? (names.length === 1 ? names[0] : undefined);

  // 1) explicitly configured alias always wins
  if (name && CFG.instances[name]) {
    const inst = CFG.instances[name];
    return { name, ref: { uuid: inst.uuid, daemonId: inst.daemon_id } };
  }

  // 2) wildcard: nickname or UUID of any discovered instance (within allowed_daemons)
  if (WILD.enabled) {
    const q = String(name ?? '').trim();
    if (!q) throw new McsmError('请通过 instance 参数指定实例（别名、昵称或 UUID），可先调用 discover_instances 查看');
    const find = () => discovered.filter((i) => i.uuid === q || i.nickname.toLowerCase() === q.toLowerCase());
    let hits = find();
    if (hits.length === 0 && Date.now() - discoveredAt > 5000) {
      await discover();
      hits = find();
    }
    if (hits.length === 1) {
      const h = hits[0];
      return { name: `${h.nickname || 'instance'}(${h.uuid.slice(0, 8)})`, ref: { uuid: h.uuid, daemonId: h.daemonId } };
    }
    if (hits.length > 1) throw new McsmError(`"${q}" 匹配到多个实例，请改用 UUID（可用 discover_instances 查看）`);
    throw new McsmError(`未找到实例 "${q}"（通配模式下仅限 allowed_daemons 范围内的实例）`);
  }

  if (!name) throw new McsmError(`请通过 instance 参数指定实例，可选: ${names.join(', ')}`);
  throw new McsmError(`未知实例 "${name}"，可选: ${names.join(', ')}`);
}

const BINARY_EXT = /\.(gz|zip|jar|7z|rar|tar|xz|bz2|png|jpe?g|gif|webp|ico|dat|dat_old|mca|mcr|nbt|schem|schematic|litematic|class|db|sqlite|exe|dll|so|dylib)$/i;

function safePath(p) {
  const s = String(p ?? '/');
  if (s.includes('\0') || s.split(/[\\/]+/).includes('..')) throw new McsmError('路径不能包含 ".."');
  return s.startsWith('/') ? s : '/' + s;
}

// Keep writes below the daemon's 5 MB read limit and preserve the exact UTF-8 text.
const MAX_WRITE_BYTES = 1024 * 1024;
function writableText(text) {
  if (typeof text !== 'string') throw new McsmError('面板返回的文件内容不是文本');
  if (/[\0\uFFFD]/.test(text)) throw new McsmError('文件内容包含 NUL 或无效 UTF-8 字符，拒绝修改可能的二进制文件');
  if (Buffer.byteLength(text, 'utf8') > MAX_WRITE_BYTES) throw new McsmError('文本文件修改上限为 1 MiB（按 UTF-8 字节计算）');
  return text;
}

async function modifyFile(toolName, instance, p, transform) {
  const { name, ref } = await resolveInstance(instance);
  let target;
  let outcome = 'error';
  try {
    target = safePath(p);
    if (target === '/' || /[\\/]$/.test(target)) throw new McsmError('请指定文件路径，不能是目录');
    if (BINARY_EXT.test(target)) throw new McsmError('二进制或压缩文件不能以文本修改');
    // Read without clean(), redaction, line slicing or output limits: those would corrupt saved text.
    const current = writableText(await api('PUT', '/api/files/', { query: ref, body: { target } }));
    const text = writableText(transform(current));
    await api('PUT', '/api/files/', { query: ref, body: { target, text } });
    outcome = 'ok';
    return ok(`已保存文件 "${target}"（${Buffer.byteLength(text, 'utf8')} 字节）。`);
  } finally {
    // Never include file contents or replacement strings in the audit log.
    audit(toolName, name, target ?? '(invalid path)', outcome);
  }
}

const STATUS_TEXT = { '-1': '忙碌', 0: '已停止', 1: '正在停止', 2: '正在启动', 3: '运行中' };

async function fetchLog(ref, sizeKb) {
  return clean(await api('GET', '/api/protected_instance/outputlog', { query: { ...ref, size: `${sizeKb}KB` } }));
}
function newOutput(before, after) {
  if (after.startsWith(before)) return after.slice(before.length);
  const anchor = before.slice(-300);
  if (anchor) {
    const i = after.lastIndexOf(anchor);
    if (i !== -1) return after.slice(i + anchor.length);
  }
  return null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----------------------------------------------------------------- server --
const server = new McpServer({ name: 'mcsm-mcp-secure', version: '0.2.1' });
const enabled = [];
const READ = { readOnlyHint: true, openWorldHint: true };
const instanceParam = z
  .string()
  .optional()
  .describe('实例别名（通配模式下也可用实例昵称或 UUID）；只配置了一个实例时可省略');

function tool(name, title, description, inputSchema, annotations, handler) {
  server.registerTool(name, { title, description, inputSchema, annotations }, wrap(handler));
  enabled.push(name);
}

// ---- read-only tools (always on) ----
tool('list_instances', '列出可管理的实例', '列出配置文件中允许管理的实例别名和说明（不含 UUID、地址或密钥）。', {}, READ, async () => {
  const lines = Object.entries(CFG.instances).map(
    ([n, i]) => `- ${n}${n === CFG.default_instance ? '（默认）' : ''}${i.description ? ': ' + i.description : ''}`,
  );
  if (WILD.enabled) {
    lines.push(
      `通配模式已开启${WILD.allowed_daemons.length ? `（限定 ${WILD.allowed_daemons.length} 个节点）` : '（所有节点）'}：` +
        '可用 discover_instances 查看全部实例，并用实例昵称或 UUID 作为 instance 参数。',
    );
  }
  return ok(lines.join('\n') || '(未配置固定实例)');
});

if (WILD.enabled) {
  tool(
    'discover_instances',
    '发现节点和实例',
    '列出面板上（允许范围内）所有节点的实例，返回昵称、状态、所属节点和 UUID。需要管理员权限的 API Key。',
    {},
    READ,
    async () => {
      const list = await discover();
      if (list.length === 0) return ok('没有发现可用实例（检查 Key 是否为管理员权限，或 allowed_daemons 是否填对）。');
      const lines = list.map(
        (i) => `- ${i.nickname || '(无名)'} | ${STATUS_TEXT[i.status] ?? '未知'} | 节点: ${i.node || '-'} | uuid: ${i.uuid}`,
      );
      return ok(limitText(`共 ${list.length} 个实例：\n${lines.join('\n')}`));
    },
  );
}

tool('get_instance_info', '查看实例状态', '查看实例的运行状态、资源占用和玩家信息。', { instance: instanceParam }, READ, async ({ instance }) => {
  const { ref } = await resolveInstance(instance);
  const d = await api('GET', '/api/instance', { query: ref });
  const summary = {
    nickname: d?.config?.nickname,
    type: d?.config?.type,
    status: d?.status,
    status_text: STATUS_TEXT[d?.status] ?? '未知',
    started: d?.started,
    process: d?.processInfo,
    info: d?.info,
    space: d?.space,
  };
  return ok(limitText(JSON.stringify(summary, null, 2)));
});

tool(
  'get_output_log',
  '读取终端输出日志',
  '读取实例终端输出的最后若干行（已去除颜色控制符）。用于排查崩溃、报错、插件冲突。',
  {
    instance: instanceParam,
    lines: z.number().int().min(1).max(1000).default(150).describe('返回最后多少行'),
    size_kb: z.number().int().min(1).max(512).default(64).describe('从面板拉取的最大日志体积 (KB)'),
  },
  READ,
  async ({ instance, lines = 150, size_kb = 64 }) => {
    const { ref } = await resolveInstance(instance);
    const text = await fetchLog(ref, size_kb);
    return ok(limitText(text.split('\n').slice(-lines).join('\n')));
  },
);

if (CFG.allow.read_files) {
  tool(
    'list_files',
    '列出实例目录文件',
    '列出实例目录下的文件和文件夹（d=目录，f=文件；目录在前，按名称排序）。',
    {
      instance: instanceParam,
      path: z.string().default('/').describe('目录路径，以 / 开头'),
      filter: z.string().max(100).default('').describe('只显示名称包含该字符串的项（不区分大小写），留空显示全部'),
      page: z.number().int().min(0).default(0).describe('页码，从 0 开始'),
      page_size: z.number().int().min(1).max(100).default(50),
    },
    READ,
    async ({ instance, path: p = '/', filter = '', page = 0, page_size = 50 }) => {
      const { ref } = await resolveInstance(instance);
      // file_name must always be sent: the panel does String(ctx.query.file_name), so omitting it
      // makes the daemon filter by the literal "undefined" and return an empty list.
      const d = await api('GET', '/api/files/list', {
        query: { ...ref, target: safePath(p), file_name: filter, page, page_size },
      });
      // Response: { items: [{ name, size, time, mode, type: 0=dir|1=file }], page, pageSize, total, absolutePath }.
      // absolutePath is the host path of the instance directory and is deliberately not shown.
      if (!Array.isArray(d?.items)) throw new McsmError('面板返回的文件列表格式无法识别');
      const items = d.items.map((i) => (i.type === 0 ? `d ${i.name}` : `f ${i.name} (${i.size} B)`));
      const total = Number(d.total) || 0;
      const pages = Math.max(1, Math.ceil(total / page_size));
      return ok(limitText(`${items.join('\n') || '(空)'}\n— 第 ${page} 页 / 共 ${pages} 页，共 ${total} 项`));
    },
  );

  tool(
    'read_file',
    '读取实例内的文本文件',
    '读取实例目录内的文本文件（只读），如 server.properties、logs/latest.log、crash-reports/*.txt。' +
      '压缩包、jar、图片、存档等二进制文件会被拒绝。面板每次都传输整个文件（守护进程上限 5MB），lines/from 只决定返回哪一部分。',
    {
      instance: instanceParam,
      path: z.string().describe('文件路径，如 /server.properties'),
      lines: z.number().int().min(1).max(5000).default(200).describe('最多返回多少行'),
      from: z.enum(['tail', 'head']).default('tail').describe('tail=返回末尾若干行（适合日志），head=返回开头若干行'),
    },
    READ,
    async ({ instance, path: p, lines = 200, from = 'tail' }) => {
      const target = safePath(p);
      if (BINARY_EXT.test(target)) {
        const hint = /\.log\.gz$/i.test(target) ? '历史日志是压缩包，请改读 /logs/latest.log 或 /crash-reports/ 下的文本报告。' : '';
        throw new McsmError(`"${target}" 是二进制或压缩文件，无法以文本读取。${hint}`);
      }
      const { ref } = await resolveInstance(instance);
      const data = await api('PUT', '/api/files/', { query: ref, body: { target } });
      const text = clean(typeof data === 'string' ? data : JSON.stringify(data));
      // The daemon decodes files as UTF-8: binary content shows up as NULs and U+FFFD replacement chars.
      const bad = (text.match(/[\0\uFFFD]/g) ?? []).length;
      if (bad > Math.max(8, text.length * 0.01)) throw new McsmError(`"${target}" 看起来是二进制文件，无法以文本读取`);
      const all = text.split('\n');
      if (all.length <= lines) return ok(limitText(text, from));
      const part = from === 'head' ? all.slice(0, lines) : all.slice(-lines);
      const note = `[共 ${all.length} 行，显示${from === 'head' ? '开头' : '末尾'} ${lines} 行]`;
      return ok(limitText(from === 'head' ? `${note}\n${part.join('\n')}` : `${part.join('\n')}\n${note}`, from));
    },
  );
}

// ---- write tools (opt-in) ----
if (CFG.allow.write_files) {
  const WRITE_FILE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  tool(
    'write_file',
    '覆盖实例内的文本文件',
    '用完整文本覆盖已有文件（不创建文件或目录），上限 1 MiB UTF-8；拒绝二进制文件。' +
      'text 必须包含完整内容，不要用 read_file 截断后的输出覆盖文件；局部修改优先用 edit_file。',
    {
      instance: instanceParam,
      path: z.string().min(1).describe('已有文本文件的路径，如 /server.properties'),
      text: z.string().max(MAX_WRITE_BYTES).describe('保存的完整 UTF-8 文本；空字符串会清空文件'),
    },
    WRITE_FILE,
    async ({ instance, path: p, text }) => {
      writableText(text);
      return modifyFile('write_file', instance, p, () => text);
    },
  );
  tool(
    'edit_file',
    '精确替换实例文本文件内容',
    '在完整文件中按字面文本替换，保留其余内容和换行。匹配数必须等于 expected_matches，否则不写入。' +
      '上限 1 MiB UTF-8；拒绝二进制文件。面板不支持原子条件写入，应避免同时编辑同一文件。',
    {
      instance: instanceParam,
      path: z.string().min(1).describe('已有文本文件的路径，如 /server.properties'),
      old_text: z.string().min(1).max(MAX_WRITE_BYTES).describe('要替换的原文（精确匹配，不使用正则）'),
      new_text: z.string().max(MAX_WRITE_BYTES).describe('替换后的文本；空字符串表示删除匹配内容'),
      expected_matches: z.number().int().min(1).max(MAX_WRITE_BYTES).default(1).describe('预期的非重叠匹配数，默认 1；多个匹配时须明确指定数量'),
    },
    WRITE_FILE,
    async ({ instance, path: p, old_text, new_text, expected_matches = 1 }) =>
      modifyFile('edit_file', instance, p, (current) => {
        const parts = current.split(old_text);
        const matches = parts.length - 1;
        if (matches !== expected_matches) throw new McsmError(`原文匹配 ${matches} 处，预期 ${expected_matches} 处；未修改文件`);
        return parts.join(new_text);
      }),
  );
}

if (CFG.allow.send_command) {
  tool(
    'send_command',
    '发送控制台命令',
    '向服务器控制台发送一条命令，并返回命令执行后新增的输出。部分危险命令前缀被配置禁止。',
    {
      instance: instanceParam,
      command: z.string().min(1).max(500).describe('控制台命令，如 list、say hello（前导 / 会被忽略）'),
      wait_ms: z.number().int().min(200).max(10000).default(1500).describe('发送后等待输出的毫秒数'),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async ({ instance, command, wait_ms = 1500 }) => {
      const { name, ref } = await resolveInstance(instance);
      if (/[\r\n\0]/.test(command)) throw new McsmError('命令不能包含换行');
      const norm = command.trim().replace(/^\/+/, '');
      if (!norm) throw new McsmError('命令为空');
      const low = norm.toLowerCase();
      for (const raw of CFG.blocked_command_prefixes) {
        const p = raw.toLowerCase();
        if (low === p.trim() || low.startsWith(p.endsWith(' ') ? p : p + ' ')) {
          audit('send_command', name, norm, 'blocked');
          throw new McsmError(`命令 "${p.trim()}" 被配置禁止（blocked_command_prefixes），请由管理员手动执行`);
        }
      }
      let outcome = 'error';
      try {
        const before = await fetchLog(ref, 32);
        await api('GET', '/api/protected_instance/command', { query: { ...ref, command: norm } });
        await sleep(wait_ms);
        const after = await fetchLog(ref, 32);
        outcome = 'ok';
        const added = newOutput(before, after);
        if (added === null) {
          return ok(limitText('命令已发送，但无法精确定位新输出，以下是最近的日志：\n' + after.split('\n').slice(-40).join('\n')));
        }
        return ok(limitText(added.trim() ? `命令已发送，新增输出：\n${added.trim()}` : '命令已发送，等待期间没有新输出（可增大 wait_ms 后用 get_output_log 查看）'));
      } finally {
        audit('send_command', name, norm, outcome);
      }
    },
  );
}

function powerTool(name, title, endpoint, destructive, verb) {
  tool(
    name,
    title,
    `${verb}实例。${destructive ? '这是破坏性操作，请先向用户确认。' : ''}`,
    { instance: instanceParam },
    { readOnlyHint: false, destructiveHint: destructive, idempotentHint: false, openWorldHint: true },
    async ({ instance }) => {
      const { name: alias, ref } = await resolveInstance(instance);
      let outcome = 'error';
      try {
        await api('GET', endpoint, { query: ref });
        outcome = 'ok';
        return ok(`已发送「${verb}」指令，请稍后用 get_instance_info 确认状态。`);
      } finally {
        audit(name, alias, '', outcome);
      }
    },
  );
}
if (CFG.allow.power) {
  powerTool('start_instance', '启动实例', '/api/protected_instance/open', false, '启动');
  powerTool('stop_instance', '停止实例', '/api/protected_instance/stop', true, '停止');
  powerTool('restart_instance', '重启实例', '/api/protected_instance/restart', true, '重启');
}
if (CFG.allow.kill) {
  powerTool('kill_instance', '强制终止实例', '/api/protected_instance/kill', true, '强制终止');
}

// ------------------------------------------------------------------ start --
const shutdown = () => process.exit(0);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
log(`就绪。实例: [${Object.keys(CFG.instances).join(', ')}]；工具: [${enabled.join(', ')}]`);
