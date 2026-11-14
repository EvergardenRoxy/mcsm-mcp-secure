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
 *
 * This file is the entry point and the tool definitions. The rest lives in lib/:
 *  config.mjs (startup checks), panel.mjs (HTTP + redaction), instances.mjs (instance lookup),
 *  files.mjs (path and text rules), text.mjs (output shaping).
 */
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ConfigError, loadConfig } from './lib/config.mjs';
import { MAX_WRITE_BYTES, assertEditableText, isBinaryPath, normalizePath } from './lib/files.mjs';
import { createInstances } from './lib/instances.mjs';
import { McsmError, createPanel } from './lib/panel.mjs';
import { outputAddedSince, stripAnsi, truncate } from './lib/text.mjs';

const log = (...parts) => console.error('[mcsm-mcp]', ...parts);

// ---------------------------------------------------------------- startup --
let settings;
try {
  settings = loadConfig();
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  log('启动失败: ' + e.message);
  process.exit(1);
}
const { config, auditPath } = settings;
const panel = createPanel({
  apiKey: settings.apiKey,
  panel: settings.panel,
  rateLimitPerMinute: config.rate_limit_per_minute,
  timeoutMs: config.request_timeout_ms,
});
const instances = createInstances(config, panel);
const server = new McpServer({ name: 'mcsm-mcp-secure', version: '0.3.0' });

// ---------------------------------------------------------- tool plumbing --
const registeredTools = [];

/** Registers a tool whose handler returns plain text. Every result and error is redacted here. */
function addTool(name, spec, handler) {
  const reply = (text, isError) => ({ isError, content: [{ type: 'text', text: panel.redact(text) }] });
  server.registerTool(name, spec, async (args) => {
    try {
      return reply(await handler(args), false);
    } catch (e) {
      if (e instanceof McsmError) return reply(e.message, true);
      // Unexpected errors may carry anything, so the model only gets the error's name.
      log('内部错误:', panel.redact(e?.stack || e));
      return reply(`内部错误: ${e?.name || 'Error'}`, true);
    }
  });
  registeredTools.push(name);
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: true };
const writeAnnotations = (destructive) => ({
  readOnlyHint: false,
  destructiveHint: destructive,
  idempotentHint: false,
  openWorldHint: true,
});
const instanceParam = z
  .string()
  .optional()
  .describe('实例别名（通配模式下也可用实例昵称或 UUID）；只配置了一个实例时可省略');

const limit = (text, keep) => truncate(text, config.max_output_chars, keep);

function writeAudit(tool, instance, detail, outcome) {
  try {
    const entry = { ts: new Date().toISOString(), tool, instance, detail: panel.redact(detail), outcome };
    fs.appendFileSync(auditPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch {
    log('审计日志写入失败');
  }
}

/** Runs a state-changing action and records whether it succeeded. `detail` must not contain file contents. */
async function audited(tool, instance, detail, action) {
  let outcome = 'error';
  try {
    const result = await action();
    outcome = 'ok';
    return result;
  } finally {
    writeAudit(tool, instance, detail, outcome);
  }
}

// ----------------------------------------------------------- panel access --
const STATUS_TEXT = { '-1': '忙碌', 0: '已停止', 1: '正在停止', 2: '正在启动', 3: '运行中' };

async function fetchLog(address, sizeKb) {
  return stripAnsi(await panel.request('GET', '/api/protected_instance/outputlog', { query: { ...address, size: `${sizeKb}KB` } }));
}

/** Reads a whole file exactly as the daemon decoded it (the same endpoint saves when `text` is sent). */
async function readFileText(address, filePath) {
  const text = await panel.request('PUT', '/api/files/', { query: address, body: { target: filePath } });
  if (typeof text !== 'string') throw new McsmError('面板返回的文件内容不是文本');
  return text;
}

/** Loads a text file, applies `transform` to its full raw content and saves the result. */
async function modifyFile(tool, instance, path, transform) {
  const { name, address } = await instances.resolve(instance);
  return audited(tool, name, path, async () => {
    const filePath = normalizePath(path);
    if (filePath === '/' || /[\\/]$/.test(filePath)) throw new McsmError('请指定文件路径，不能是目录');
    if (isBinaryPath(filePath)) throw new McsmError('二进制或压缩文件不能以文本修改');
    // No stripAnsi, redaction or truncation on this path: any of them would corrupt the saved file.
    const current = assertEditableText(await readFileText(address, filePath));
    const text = assertEditableText(transform(current));
    await panel.request('PUT', '/api/files/', { query: address, body: { target: filePath, text } });
    return `已保存文件 "${filePath}"（${Buffer.byteLength(text, 'utf8')} 字节）。`;
  });
}

/** Returns the configured prefix that forbids this command, if any. Prefixes match whole words. */
function blockedPrefixOf(command) {
  const lower = command.toLowerCase();
  return config.blocked_command_prefixes
    .map((prefix) => prefix.toLowerCase())
    .find((prefix) => lower === prefix.trim() || lower.startsWith(prefix.endsWith(' ') ? prefix : prefix + ' '));
}

// ------------------------------------------------- read tools (always on) --
addTool(
  'list_instances',
  {
    title: '列出可管理的实例',
    description: '列出配置文件中允许管理的实例别名和说明（不含 UUID、地址或密钥）。',
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    const lines = Object.entries(config.instances).map(([alias, instance]) => {
      const isDefault = alias === config.default_instance ? '（默认）' : '';
      return `- ${alias}${isDefault}${instance.description ? ': ' + instance.description : ''}`;
    });
    if (config.wildcard.enabled) {
      const nodeCount = config.wildcard.allowed_daemons.length;
      lines.push(
        `通配模式已开启${nodeCount ? `（限定 ${nodeCount} 个节点）` : '（所有节点）'}：` +
          '可用 discover_instances 查看全部实例，并用实例昵称或 UUID 作为 instance 参数。',
      );
    }
    return lines.join('\n');
  },
);

if (config.wildcard.enabled) {
  addTool(
    'discover_instances',
    {
      title: '发现节点和实例',
      description: '列出面板上（允许范围内）所有节点的实例，返回昵称、状态、所属节点和 UUID。需要管理员权限的 API Key。',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const found = await instances.discover();
      if (found.length === 0) return '没有发现可用实例（检查 Key 是否为管理员权限，或 allowed_daemons 是否填对）。';
      const lines = found.map(
        (i) => `- ${i.nickname || '(无名)'} | ${STATUS_TEXT[i.status] ?? '未知'} | 节点: ${i.node || '-'} | uuid: ${i.uuid}`,
      );
      return limit(`共 ${found.length} 个实例：\n${lines.join('\n')}`);
    },
  );
}

addTool(
  'get_instance_info',
  {
    title: '查看实例状态',
    description: '查看实例的运行状态、资源占用和玩家信息。',
    inputSchema: { instance: instanceParam },
    annotations: READ_ONLY,
  },
  async ({ instance }) => {
    const { address } = await instances.resolve(instance);
    const detail = await panel.request('GET', '/api/instance', { query: address });
    // Picked field by field: config.startCommand may contain secrets and must not be returned.
    const summary = {
      nickname: detail.config.nickname,
      type: detail.config.type,
      status: detail.status,
      status_text: STATUS_TEXT[detail.status] ?? '未知',
      started: detail.started,
      process: detail.processInfo,
      info: detail.info,
      space: detail.space,
    };
    return limit(JSON.stringify(summary, null, 2));
  },
);

addTool(
  'get_output_log',
  {
    title: '读取终端输出日志',
    description: '读取实例终端输出的最后若干行（已去除颜色控制符）。用于排查崩溃、报错、插件冲突。',
    inputSchema: {
      instance: instanceParam,
      lines: z.number().int().min(1).max(1000).default(150).describe('返回最后多少行'),
      size_kb: z.number().int().min(1).max(512).default(64).describe('从面板拉取的最大日志体积 (KB)'),
    },
    annotations: READ_ONLY,
  },
  async ({ instance, lines, size_kb }) => {
    const { address } = await instances.resolve(instance);
    const text = await fetchLog(address, size_kb);
    return limit(text.split('\n').slice(-lines).join('\n'));
  },
);

// ------------------------------------------------- file tools (read: on by default, write: opt-in) --
if (config.allow.read_files) {
  addTool(
    'list_files',
    {
      title: '列出实例目录文件',
      description: '列出实例目录下的文件和文件夹（d=目录，f=文件；目录在前，按名称排序）。',
      inputSchema: {
        instance: instanceParam,
        path: z.string().default('/').describe('目录路径，以 / 开头'),
        filter: z.string().max(100).default('').describe('只显示名称包含该字符串的项（不区分大小写），留空显示全部'),
        page: z.number().int().min(0).default(0).describe('页码，从 0 开始'),
        page_size: z.number().int().min(1).max(100).default(50),
      },
      annotations: READ_ONLY,
    },
    async ({ instance, path, filter, page, page_size }) => {
      const { address } = await instances.resolve(instance);
      // file_name must always be sent: the panel does String(ctx.query.file_name), so omitting it
      // makes the daemon filter by the literal "undefined" and return an empty list.
      const listing = await panel.request('GET', '/api/files/list', {
        query: { ...address, target: normalizePath(path), file_name: filter, page, page_size },
      });
      // Response: { items: [{ name, size, time, mode, type: 0=dir|1=file }], page, pageSize, total, absolutePath }.
      // absolutePath is the host path of the instance directory and is deliberately not shown.
      if (!Array.isArray(listing?.items)) throw new McsmError('面板返回的文件列表格式无法识别');
      const entries = listing.items.map((i) => (i.type === 0 ? `d ${i.name}` : `f ${i.name} (${i.size} B)`));
      const total = Number(listing.total) || 0;
      const pageCount = Math.max(1, Math.ceil(total / page_size));
      return limit(`${entries.join('\n') || '(空)'}\n— 第 ${page} 页 / 共 ${pageCount} 页，共 ${total} 项`);
    },
  );

  addTool(
    'read_file',
    {
      title: '读取实例内的文本文件',
      description:
        '读取实例目录内的文本文件（只读），如 server.properties、logs/latest.log、crash-reports/*.txt。' +
        '压缩包、jar、图片、存档等二进制文件会被拒绝。面板每次都传输整个文件（守护进程上限 5MB），lines/from 只决定返回哪一部分。',
      inputSchema: {
        instance: instanceParam,
        path: z.string().describe('文件路径，如 /server.properties'),
        lines: z.number().int().min(1).max(5000).default(200).describe('最多返回多少行'),
        from: z.enum(['tail', 'head']).default('tail').describe('tail=返回末尾若干行（适合日志），head=返回开头若干行'),
      },
      annotations: READ_ONLY,
    },
    async ({ instance, path, lines, from }) => {
      const filePath = normalizePath(path);
      if (isBinaryPath(filePath)) {
        const hint = /\.log\.gz$/i.test(filePath) ? '历史日志是压缩包，请改读 /logs/latest.log 或 /crash-reports/ 下的文本报告。' : '';
        throw new McsmError(`"${filePath}" 是二进制或压缩文件，无法以文本读取。${hint}`);
      }
      const { address } = await instances.resolve(instance);
      const text = stripAnsi(await readFileText(address, filePath));
      // The daemon decodes files as UTF-8: binary content shows up as NULs and U+FFFD replacement chars.
      const undecodable = (text.match(/[\0\uFFFD]/g) ?? []).length;
      if (undecodable > Math.max(8, text.length * 0.01)) throw new McsmError(`"${filePath}" 看起来是二进制文件，无法以文本读取`);

      const allLines = text.split('\n');
      if (allLines.length <= lines) return limit(text, from);
      const fromHead = from === 'head';
      const shown = (fromHead ? allLines.slice(0, lines) : allLines.slice(-lines)).join('\n');
      const note = `[共 ${allLines.length} 行，显示${fromHead ? '开头' : '末尾'} ${lines} 行]`;
      return limit(fromHead ? `${note}\n${shown}` : `${shown}\n${note}`, from);
    },
  );
}

if (config.allow.write_files) {
  addTool(
    'write_file',
    {
      title: '覆盖实例内的文本文件',
      description:
        '用完整文本覆盖已有文件（不创建文件或目录），上限 1 MiB UTF-8；拒绝二进制文件。' +
        'text 必须包含完整内容，不要用 read_file 截断后的输出覆盖文件；局部修改优先用 edit_file。',
      inputSchema: {
        instance: instanceParam,
        path: z.string().min(1).describe('已有文本文件的路径，如 /server.properties'),
        text: z.string().max(MAX_WRITE_BYTES).describe('保存的完整 UTF-8 文本；空字符串会清空文件'),
      },
      annotations: writeAnnotations(true),
    },
    async ({ instance, path, text }) => modifyFile('write_file', instance, path, () => text),
  );

  addTool(
    'edit_file',
    {
      title: '精确替换实例文本文件内容',
      description:
        '在完整文件中按字面文本替换，保留其余内容和换行。匹配数必须等于 expected_matches，否则不写入。' +
        '上限 1 MiB UTF-8；拒绝二进制文件。面板不支持原子条件写入，应避免同时编辑同一文件。',
      inputSchema: {
        instance: instanceParam,
        path: z.string().min(1).describe('已有文本文件的路径，如 /server.properties'),
        old_text: z.string().min(1).max(MAX_WRITE_BYTES).describe('要替换的原文（精确匹配，不使用正则）'),
        new_text: z.string().max(MAX_WRITE_BYTES).describe('替换后的文本；空字符串表示删除匹配内容'),
        expected_matches: z.number().int().min(1).default(1).describe('预期的非重叠匹配数，默认 1；多个匹配时须明确指定数量'),
      },
      annotations: writeAnnotations(true),
    },
    async ({ instance, path, old_text, new_text, expected_matches }) =>
      modifyFile('edit_file', instance, path, (current) => {
        // split/join instead of replaceAll: replacement patterns like "$&" in new_text stay literal.
        const pieces = current.split(old_text);
        const matches = pieces.length - 1;
        if (matches !== expected_matches) throw new McsmError(`原文匹配 ${matches} 处，预期 ${expected_matches} 处；未修改文件`);
        return pieces.join(new_text);
      }),
  );
}

// ------------------------------------------------- console and power tools (opt-in) --
if (config.allow.send_command) {
  const LOG_SNAPSHOT_KB = 32;
  addTool(
    'send_command',
    {
      title: '发送控制台命令',
      description: '向服务器控制台发送一条命令，并返回命令执行后新增的输出。部分危险命令前缀被配置禁止。',
      inputSchema: {
        instance: instanceParam,
        command: z.string().min(1).max(500).describe('控制台命令，如 list、say hello（前导 / 会被忽略）'),
        wait_ms: z.number().int().min(200).max(10000).default(1500).describe('发送后等待输出的毫秒数'),
      },
      annotations: writeAnnotations(true),
    },
    async ({ instance, command: rawCommand, wait_ms }) => {
      const { name, address } = await instances.resolve(instance);
      if (/[\r\n\0]/.test(rawCommand)) throw new McsmError('命令不能包含换行');
      const command = rawCommand.trim().replace(/^\/+/, '');
      if (!command) throw new McsmError('命令为空');
      const blockedPrefix = blockedPrefixOf(command);
      if (blockedPrefix !== undefined) {
        writeAudit('send_command', name, command, 'blocked');
        throw new McsmError(`命令 "${blockedPrefix.trim()}" 被配置禁止（blocked_command_prefixes），请由管理员手动执行`);
      }

      // The panel does not return a command's output, so it is inferred from the console log before and after.
      const [before, after] = await audited('send_command', name, command, async () => {
        const logBefore = await fetchLog(address, LOG_SNAPSHOT_KB);
        await panel.request('GET', '/api/protected_instance/command', { query: { ...address, command } });
        await sleep(wait_ms);
        return [logBefore, await fetchLog(address, LOG_SNAPSHOT_KB)];
      });
      const added = outputAddedSince(before, after);
      if (added === null) {
        return limit('命令已发送，但无法精确定位新输出，以下是最近的日志：\n' + after.split('\n').slice(-40).join('\n'));
      }
      return added.trim()
        ? limit(`命令已发送，新增输出：\n${added.trim()}`)
        : '命令已发送，等待期间没有新输出（可增大 wait_ms 后用 get_output_log 查看）';
    },
  );
}

const POWER_TOOLS = [
  { name: 'start_instance', verb: '启动', action: 'open', destructive: false, permission: 'power' },
  { name: 'stop_instance', verb: '停止', action: 'stop', destructive: true, permission: 'power' },
  { name: 'restart_instance', verb: '重启', action: 'restart', destructive: true, permission: 'power' },
  { name: 'kill_instance', verb: '强制终止', action: 'kill', destructive: true, permission: 'kill' },
];
for (const { name, verb, action, destructive, permission } of POWER_TOOLS) {
  if (!config.allow[permission]) continue;
  addTool(
    name,
    {
      title: `${verb}实例`,
      description: `${verb}实例。${destructive ? '这是破坏性操作，请先向用户确认。' : ''}`,
      inputSchema: { instance: instanceParam },
      annotations: writeAnnotations(destructive),
    },
    async ({ instance }) => {
      const { name: instanceName, address } = await instances.resolve(instance);
      return audited(name, instanceName, '', async () => {
        await panel.request('GET', `/api/protected_instance/${action}`, { query: address });
        return `已发送「${verb}」指令，请稍后用 get_instance_info 确认状态。`;
      });
    },
  );
}

// ------------------------------------------------------------------ start --
await server.connect(new StdioServerTransport());
log(`就绪。实例: [${Object.keys(config.instances).join(', ')}]；工具: [${registeredTools.join(', ')}]`);
