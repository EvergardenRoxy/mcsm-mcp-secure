// End-to-end tests: spawns server.mjs over stdio (like an MCP client would) against a strict V10 mock.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startMock, ABS_PATH } from './mock-mcsm.mjs';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');
const KEY = 'k3y-SECRET-9f8a7b6c5d4e3f2a';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  <-- ' + detail}`);
  if (!cond) failures++;
}
const leakStrings = (mock) => [KEY, encodeURIComponent(KEY), mock.url, `127.0.0.1:${mock.port}`, '10.9.8.7', ABS_PATH];
const txt = (r) => (r.content ?? []).map((c) => c.text).join('\n');

const allOutputs = []; // every string the server ever gave us (tool results + stderr), for the leak sweep

function writeCfg(dir, mock, over = {}, { keyMode = 0o600, cfgMode = 0o600, writeKey = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const cfg = {
    base_url: mock.url,
    api_key_file: 'api-key',
    default_instance: 'survival',
    instances: { survival: { uuid: mock.uuid, daemon_id: mock.daemon, description: '生存服' } },
    ...over,
  };
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: cfgMode });
  fs.chmodSync(cfgPath, cfgMode);
  if (writeKey) {
    const kp = path.join(dir, 'api-key');
    fs.writeFileSync(kp, KEY + '\n', { mode: keyMode });
    fs.chmodSync(kp, keyMode);
  }
  return cfgPath;
}

async function connect(cfgPath, env = {}) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER],
    env: { MCSM_MCP_CONFIG: cfgPath, ...env },
    stderr: 'pipe',
  });
  const stderr = [];
  transport.stderr?.on('data', (d) => stderr.push(String(d)));
  const client = new Client({ name: 'test', version: '0' });
  const protocolErrors = [];
  client.onerror = (e) => protocolErrors.push(String(e?.message ?? e));
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    allOutputs.push(txt(r));
    return r;
  };
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  return { client, call, tools, stderr, protocolErrors, close: () => client.close() };
}

function expectStartupFailure(name, cfgPath, expect, env = {}) {
  const r = spawnSync('node', [SERVER], { env: { ...process.env, MCSM_MCP_CONFIG: cfgPath, ...env }, input: '', encoding: 'utf8', timeout: 15000 });
  allOutputs.push(r.stderr, r.stdout);
  check(`拒绝启动: ${name}`, r.status !== 0 && r.stderr.includes(expect), `status=${r.status} stderr=${r.stderr.slice(0, 200)}`);
  check(`  └ 报错信息不含密钥: ${name}`, !r.stderr.includes(KEY) && !r.stdout.includes(KEY));
}

// POSIX file modes don't exist on Windows (the server skips the check there), so those assertions are skipped.
const POSIX = process.platform !== 'win32';
if (!POSIX) console.log('Windows：跳过文件权限（chmod 600）相关测试');

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'mcsm-test-'));
const mock = await startMock({ key: KEY });

try {
  // ---------- A. default config: read-only tool set ----------
  console.log('\n# A. 默认配置（只读）');
  const dirA = path.join(tmp, 'a');
  const A = await connect(writeCfg(dirA, mock));
  check('只注册只读工具，写工具对模型不可见', JSON.stringify(A.tools) === JSON.stringify(['get_instance_info', 'get_output_log', 'list_files', 'list_instances', 'read_file']), A.tools.join(','));

  const li = txt(await A.call('list_instances'));
  check('list_instances 只显示别名，不含 UUID', li.includes('survival') && !li.includes(mock.uuid));

  const info = txt(await A.call('get_instance_info'));
  check('get_instance_info 解析数字 status=200 并给出状态', info.includes('运行中') && info.includes('Survival'), info);
  check('get_instance_info 不暴露 startCommand', !info.includes('secret-token-ARG'));

  const lg = txt(await A.call('get_output_log', { lines: 5 }));
  check('get_output_log 去除 ANSI 颜色码', lg.includes('Done (12.1s)') && !lg.includes('\u001b'), JSON.stringify(lg));

  const fl = txt(await A.call('list_files', { path: '/' }));
  check('list_files 正常', fl.includes('server.properties') && fl.includes('d world'), fl);
  const listReq = mock.requests.filter((r) => r.path === '/api/files/list').pop();
  check('list_files 显式发送空 file_name（否则面板会按 "undefined" 过滤）', listReq?.query.file_name === '', JSON.stringify(listReq?.query));
  const fLogs = txt(await A.call('list_files', { path: '/logs' }));
  check('list_files 子目录 /logs 正常', fLogs.includes('f latest.log (4096 B)'), fLogs);
  const fFilter = txt(await A.call('list_files', { path: '/', filter: 'PROPERTIES' }));
  check('list_files filter 按名称过滤（不区分大小写）', fFilter.includes('server.properties') && !fFilter.includes('world'), fFilter);
  const fPage = txt(await A.call('list_files', { path: '/', page: 1, page_size: 2 }));
  check('list_files 分页', fPage.includes('server.properties') && !fPage.includes('d logs') && fPage.includes('共 4 项'), fPage);
  const fMissing = await A.call('list_files', { path: '/nope' });
  check('list_files 不存在的目录返回错误', fMissing.isError === true, txt(fMissing));

  const rf = txt(await A.call('read_file', { path: '/server.properties' }));
  check('read_file 正常（PUT /api/files/）', rf.includes('motd=Hello'), rf);

  const nFiles = mock.requests.length;
  const gz = await A.call('read_file', { path: '/logs/2026-09-13-1.log.gz' });
  check('read_file 按扩展名拒绝 .log.gz 并提示改读 latest.log', gz.isError === true && txt(gz).includes('latest.log'), txt(gz));
  const jar = await A.call('read_file', { path: '/mods/Some-Mod.JAR' });
  check('read_file 扩展名判断不区分大小写（.JAR）', jar.isError === true && txt(jar).includes('二进制'), txt(jar));
  check('被扩展名拒绝的文件不会发请求', mock.requests.length === nFiles);
  const dis = await A.call('read_file', { path: '/disguised.txt' });
  check('read_file 拒绝伪装成 .txt 的二进制内容', dis.isError === true && txt(dis).includes('二进制'), txt(dis));
  const tail = txt(await A.call('read_file', { path: '/logs/latest.log' }));
  check('read_file 默认返回末尾 200 行并注明总行数', tail.includes('L0500') && tail.includes('L0301') && !tail.includes('L0300') && tail.includes('共 500 行'), tail.slice(0, 200));
  const head = txt(await A.call('read_file', { path: '/logs/latest.log', from: 'head', lines: 3 }));
  check('read_file from=head 返回开头若干行', head.includes('L0001') && head.includes('L0003') && !head.includes('L0004'), head);

  const trav = await A.call('read_file', { path: '/../etc/passwd' });
  check('read_file 拒绝 ".." 路径穿越', trav.isError === true && txt(trav).includes('..'), txt(trav));

  const unknownInst = await A.call('get_instance_info', { instance: 'nope' });
  check('未知实例别名被拒绝（无法访问任意 UUID）', unknownInst.isError === true);

  check('所有请求都带 X-Requested-With', mock.requests.length > 0 && mock.requests.every((r) => r.xrw === 'XMLHttpRequest'));
  check('apikey 作为查询参数发送且仅发往配置的地址', mock.requests.every((r) => r.query.apikey === KEY));
  check('A 组 stdout 干净（无协议错误）', A.protocolErrors.length === 0, A.protocolErrors.join(' | '));
  allOutputs.push(...A.stderr);
  await A.close();

  // ---------- B. write tools opted in ----------
  console.log('\n# B. 开启 send_command + power（不开 kill）');
  const dirB = path.join(tmp, 'b');
  const B = await connect(writeCfg(dirB, mock, { allow: { send_command: true, power: true } }));
  check('写工具按配置出现，kill 不出现', B.tools.includes('send_command') && B.tools.includes('restart_instance') && !B.tools.includes('kill_instance'), B.tools.join(','));

  const sc = txt(await B.call('send_command', { command: '/list', wait_ms: 300 }));
  check('send_command 返回命令新增输出', sc.includes('Steve') && sc.includes('新增输出'), sc);

  const before = mock.requests.length;
  for (const bad of ['stop', '/op Steve', 'OP Steve', 'deop x']) {
    const r = await B.call('send_command', { command: bad, wait_ms: 200 });
    check(`禁止命令被拦截: "${bad}"`, r.isError === true && txt(r).includes('被配置禁止'), txt(r));
  }
  check('被拦截的命令没有到达面板', mock.requests.length === before);

  const nl = await B.call('send_command', { command: 'say hi\nstop', wait_ms: 200 });
  check('命令中的换行被拒绝（防注入第二条命令）', nl.isError === true && txt(nl).includes('换行'));

  const allowedSay = txt(await B.call('send_command', { command: 'stopwatch start', wait_ms: 200 }));
  check('前缀匹配按词边界（stopwatch 不被 stop 误伤）', allowedSay.includes('已发送'), allowedSay);

  const rs = txt(await B.call('restart_instance'));
  check('restart_instance 正常', rs.includes('已发送'), rs);

  const boom = await B.call('send_command', { command: 'boom', wait_ms: 200 });
  check('上游错误被转成 isError', boom.isError === true && txt(boom).includes('status=500'), txt(boom));
  check('上游错误回显的 URL/密钥被脱敏', !txt(boom).includes(KEY) && !txt(boom).includes(mock.url) && txt(boom).includes('<redacted>'), txt(boom));

  const auditPath = path.join(dirB, 'audit.log');
  const auditRaw = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : '';
  check('审计日志已写入，包含执行与拦截记录', auditRaw.includes('"outcome":"ok"') && auditRaw.includes('"outcome":"blocked"'), auditRaw.slice(0, 200));
  check('审计日志不含密钥', !auditRaw.includes(KEY));
  if (POSIX) check('审计日志权限为 600', (fs.statSync(auditPath).mode & 0o777) === 0o600);
  check('B 组 stdout 干净（无协议错误）', B.protocolErrors.length === 0, B.protocolErrors.join(' | '));
  allOutputs.push(...B.stderr, auditRaw);
  await B.close();

  // ---------- C. kill + read_files off ----------
  console.log('\n# C. kill 开启 / read_files 关闭');
  const C = await connect(writeCfg(path.join(tmp, 'c'), mock, { allow: { power: true, kill: true, read_files: false } }));
  check('kill_instance 出现；文件工具消失', C.tools.includes('kill_instance') && !C.tools.includes('read_file') && !C.tools.includes('list_files'), C.tools.join(','));
  allOutputs.push(...C.stderr);
  await C.close();

  // ---------- D. refuse insecure setups ----------
  console.log('\n# D. 不安全配置拒绝启动');
  if (POSIX) {
    expectStartupFailure('密钥文件权限 644', writeCfg(path.join(tmp, 'd1'), mock, {}, { keyMode: 0o644 }), '权限过宽');
    expectStartupFailure('配置文件权限 644', writeCfg(path.join(tmp, 'd2'), mock, {}, { cfgMode: 0o644 }), '权限过宽');
  }
  expectStartupFailure('配置里内联 api_key', writeCfg(path.join(tmp, 'd3'), mock, { api_key: KEY }), '不允许直接写 api_key');
  expectStartupFailure('公网地址使用 http', writeCfg(path.join(tmp, 'd4'), mock, { base_url: 'http://panel.example.com' }), '必须使用 https');
  expectStartupFailure('base_url 含账号密码', writeCfg(path.join(tmp, 'd5'), mock, { base_url: 'https://u:p@panel.example.com' }), '账号密码');
  expectStartupFailure('找不到密钥文件', writeCfg(path.join(tmp, 'd6'), mock, {}, { writeKey: false }), '找不到密钥文件');
  expectStartupFailure('未知配置字段', writeCfg(path.join(tmp, 'd7'), mock, { alow: {} }), '配置无效');
  const badJson = path.join(tmp, 'd8', 'config.json');
  fs.mkdirSync(path.dirname(badJson), { recursive: true });
  fs.writeFileSync(badJson, `{"base_url": "${KEY}" oops`, { mode: 0o600 });
  expectStartupFailure('非法 JSON（报错不回显文件内容）', badJson, '不是合法 JSON');

  // ---------- E. key from env var ----------
  console.log('\n# E. 密钥走环境变量（无密钥文件）');
  const E = await connect(writeCfg(path.join(tmp, 'e'), mock, {}, { writeKey: false }), { MCSM_API_KEY: KEY });
  check('MCSM_API_KEY 可替代密钥文件', txt(await E.call('get_instance_info')).includes('运行中'));
  allOutputs.push(...E.stderr);
  await E.close();

  // ---------- F. wrong key ----------
  console.log('\n# F. 错误密钥');
  const dirF = path.join(tmp, 'f');
  const cfgF = writeCfg(dirF, mock);
  fs.writeFileSync(path.join(dirF, 'api-key'), 'wrong-key-0000', { mode: 0o600 });
  const F = await connect(cfgF);
  const bad = await F.call('get_instance_info');
  check('密钥错误时返回可读错误（status=403）', bad.isError === true && txt(bad).includes('403'), txt(bad));
  allOutputs.push(...F.stderr);
  await F.close();

  // ---------- G. rate limit ----------
  console.log('\n# G. 本地限流');
  const G = await connect(writeCfg(path.join(tmp, 'g'), mock, { rate_limit_per_minute: 3 }));
  const rs5 = [];
  for (let i = 0; i < 5; i++) rs5.push(await G.call('get_instance_info'));
  check('超过 rate_limit_per_minute 后被限流', rs5.slice(0, 3).every((r) => !r.isError) && rs5[4].isError === true && txt(rs5[4]).includes('限流'), rs5.map((r) => !!r.isError).join(','));
  allOutputs.push(...G.stderr);
  await G.close();

  // ---------- H. redirects are refused ----------
  console.log('\n# H. 不跟随重定向（防止密钥被转发）');
  const mock2 = await startMock({ key: KEY });
  const redirector = http.createServer((req, res) => {
    res.statusCode = 302;
    res.setHeader('Location', `${mock2.url}${req.url}`);
    res.end();
  });
  await new Promise((r) => redirector.listen(0, '127.0.0.1', r));
  const redirUrl = `http://127.0.0.1:${redirector.address().port}`;
  const H = await connect(writeCfg(path.join(tmp, 'h'), mock2, { base_url: redirUrl }));
  const hr = await H.call('get_instance_info');
  check('收到 302 时报错而不是跟随', hr.isError === true, txt(hr));
  check('重定向目标从未收到过密钥', mock2.requests.length === 0, `mock2 got ${mock2.requests.length} requests`);
  allOutputs.push(...H.stderr);
  await H.close();
  await new Promise((r) => redirector.close(r));
  await mock2.close();

  // ---------- I. Windows-style files ----------
  console.log('\n# I. Windows 风格文件（UTF-8 BOM + CRLF）');
  const dirI = path.join(tmp, 'i');
  const cfgI = writeCfg(dirI, mock);
  fs.writeFileSync(cfgI, '\uFEFF' + fs.readFileSync(cfgI, 'utf8').replace(/\n/g, '\r\n'));
  fs.writeFileSync(path.join(dirI, 'api-key'), '\uFEFF' + KEY + '\r\n');
  const I = await connect(cfgI);
  check('带 BOM/CRLF 的配置和密钥文件可正常使用', txt(await I.call('get_instance_info')).includes('运行中'));
  allOutputs.push(...I.stderr);
  await I.close();

  // ---------- J. wildcard mode ----------
  console.log('\n# J. 通配模式（wildcard）+ 全权限');
  const J = await connect(writeCfg(path.join(tmp, 'j'), mock, {
    instances: {},
    default_instance: undefined,
    wildcard: { enabled: true, allowed_daemons: [] },
    allow: { write_files: true, send_command: true, power: true, kill: true },
    blocked_command_prefixes: [],
  }));
  check('通配模式出现 discover_instances，全权限工具齐全', ['discover_instances', 'send_command', 'restart_instance', 'kill_instance'].every((t) => J.tools.includes(t)), J.tools.join(','));

  const disc = txt(await J.call('discover_instances'));
  check('discover_instances 列出实例昵称与 UUID', disc.includes('Survival') && disc.includes('inst-2-uuid') && disc.includes(mock.uuid), disc);
  check('只列出在线节点上的实例，且不泄露节点 IP', !disc.includes('10.9.8') && !disc.includes('down'), disc);

  const byNick = txt(await J.call('get_instance_info', { instance: 'survival' }));
  check('可按昵称（不区分大小写）操作实例，无需预先登记', byNick.includes('运行中'), byNick);
  const byUuid = txt(await J.call('get_instance_info', { instance: mock.uuid }));
  check('可按 UUID 操作实例', byUuid.includes('运行中'), byUuid);
  mock.textFiles['/wildcard.txt'] = 'mode=old';
  const wildEdit = await J.call('edit_file', { instance: 'Survival', path: '/wildcard.txt', old_text: 'mode=old', new_text: 'mode=new' });
  check('通配模式可按昵称修改发现的实例文件', !wildEdit.isError && mock.textFiles['/wildcard.txt'] === 'mode=new');

  const lenBefore = mock.requests.length;
  const other = await J.call('get_instance_info', { instance: 'inst-2-uuid' });
  const lastInfoReq = mock.requests.slice(lenBefore).filter((r) => r.path === '/api/instance').pop();
  check('按 UUID 指向另一个实例时，请求确实发往该 UUID', lastInfoReq?.query.uuid === 'inst-2-uuid' && other.isError === true, JSON.stringify(lastInfoReq?.query));

  const amb = await J.call('get_instance_info', { instance: 'Creative' });
  check('昵称重复（Creative / creative）时拒绝猜测', amb.isError === true && txt(amb).includes('多个实例'), txt(amb));
  const none = await J.call('get_instance_info', { instance: 'no-such' });
  check('未知名称被拒绝', none.isError === true && txt(none).includes('未找到实例'), txt(none));
  const scw = txt(await J.call('send_command', { command: 'stop', instance: 'survival', wait_ms: 200 }));
  check('黑名单置空后 stop 可发送（管理员档）', scw.includes('已发送'), scw);
  const auditJ = fs.readFileSync(path.join(tmp, 'j', 'audit.log'), 'utf8');
  check('通配模式审计日志记录实例昵称与 UUID 前缀', auditJ.includes('Survival(inst-uui'), auditJ.slice(0, 200));
  allOutputs.push(...J.stderr, auditJ);
  await J.close();

  // ---------- K. wildcard restricted by allowed_daemons ----------
  console.log('\n# K. 通配模式限定节点（allowed_daemons）');
  const K = await connect(writeCfg(path.join(tmp, 'k'), mock, {
    instances: {},
    default_instance: undefined,
    wildcard: { enabled: true, allowed_daemons: ['some-other-daemon'] },
    allow: { write_files: true },
  }));
  const dk = txt(await K.call('discover_instances'));
  check('限定到其他节点后，本节点实例不可见', dk.includes('没有发现'), dk);
  const lenK = mock.requests.length;
  const rk = await K.call('get_instance_info', { instance: mock.uuid });
  check('限定范围外的实例无法操作，且请求不会发往它', rk.isError === true && !mock.requests.slice(lenK).some((r) => r.path === '/api/instance'), txt(rk));
  const beforeWriteK = mock.requests.length;
  const blockedWrite = await K.call('write_file', { instance: mock.uuid, path: '/wildcard.txt', text: 'forbidden' });
  check('文件写入同样受 allowed_daemons 限制且不发请求', blockedWrite.isError === true && mock.requests.length === beforeWriteK && mock.textFiles['/wildcard.txt'] === 'mode=new');
  allOutputs.push(...K.stderr);
  await K.close();

  // ---------- L. wildcard disabled by default ----------
  console.log('\n# L. 默认（未开启通配）');
  const L = await connect(writeCfg(path.join(tmp, 'l'), mock));
  check('默认没有 discover_instances 工具', !L.tools.includes('discover_instances'), L.tools.join(','));
  const lenL = mock.requests.length;
  const rl = await L.call('get_instance_info', { instance: mock.uuid });
  check('默认下按 UUID 访问未登记实例被拒绝，且不发请求', rl.isError === true && mock.requests.length === lenL, txt(rl));
  allOutputs.push(...L.stderr);
  await L.close();

  expectStartupFailure('既无实例又未启用通配', writeCfg(path.join(tmp, 'm'), mock, { instances: {}, default_instance: undefined }), '至少需要配置一个实例');

  // ---------- N. opt-in text file modification ----------
  console.log('\n# N. 文件写入与精确替换');
  const dirN = path.join(tmp, 'n');
  const N = await connect(writeCfg(dirN, mock, { allow: { write_files: true }, max_output_chars: 500 }));
  check('write_files 单独注册文件写工具，不开启命令或电源工具', N.tools.includes('write_file') && N.tools.includes('edit_file') && !N.tools.includes('send_command') && !N.tools.includes('restart_instance'));
  const writes = () => mock.requests.filter((r) => r.path === '/api/files/' && Object.hasOwn(JSON.parse(r.body), 'text'));
  const original = `\uFEFFmotd=你好\r\nmax-players=20\r\nvalue=$& $1\r\nprivate=${KEY} ${mock.url}\r\n` + 'unchanged\r\n'.repeat(300);
  mock.textFiles['/editable.properties'] = original;
  const edited = await N.call('edit_file', { path: 'editable.properties', old_text: 'max-players=20', new_text: 'max-players=40' });
  check('edit_file 保存修改并保留 BOM、中文、CRLF 和超出输出上限的内容', !edited.isError && mock.textFiles['/editable.properties'] === original.replace('max-players=20', 'max-players=40'), txt(edited));
  const editReq = writes().at(-1);
  check('写入使用 PUT /api/files/、正确实例和 target/text 正文', editReq?.method === 'PUT' && editReq.query.uuid === mock.uuid && editReq.query.daemonId === mock.daemon && JSON.parse(editReq.body).target === '/editable.properties');
  await N.call('edit_file', { path: '/editable.properties', old_text: 'value=$& $1', new_text: 'value=$` $& $1' });
  check('精确替换不会展开美元符号或正则替换占位符', mock.textFiles['/editable.properties'].includes('value=$` $& $1\r\n'));
  const beforeMismatch = writes().length;
  const missing = await N.call('edit_file', { path: '/editable.properties', old_text: 'does-not-exist', new_text: 'x' });
  const ambiguous = await N.call('edit_file', { path: '/editable.properties', old_text: 'unchanged', new_text: 'x' });
  check('零匹配和重复匹配都拒绝写入', missing.isError === true && ambiguous.isError === true && writes().length === beforeMismatch, txt(ambiguous));
  const multiple = await N.call('edit_file', { path: '/editable.properties', old_text: 'unchanged', new_text: 'kept', expected_matches: 300 });
  check('明确预期匹配数后可替换多处', !multiple.isError && mock.textFiles['/editable.properties'].split('kept').length === 301);
  const removed = await N.call('edit_file', { path: '/editable.properties', old_text: 'motd=你好', new_text: '' });
  check('new_text 为空时可删除匹配内容', !removed.isError && !mock.textFiles['/editable.properties'].includes('motd='));
  const replacement = 'motd=新的配置\r\npassword=FILE_BODY_PRIVATE_SENTINEL\r\n';
  const written = await N.call('write_file', { path: '/editable.properties', text: replacement });
  check('write_file 按原样覆盖完整文本', !written.isError && mock.textFiles['/editable.properties'] === replacement, txt(written));
  check('保存结果不回显文件正文', !txt(written).includes('FILE_BODY_PRIVATE_SENTINEL'));
  const emptied = await N.call('write_file', { path: '/editable.properties', text: '' });
  check('空字符串确实清空文件（不是只读请求）', !emptied.isError && mock.textFiles['/editable.properties'] === '' && JSON.parse(writes().at(-1).body).text === '');

  for (const toolName of ['write_file', 'edit_file']) {
    const args = toolName === 'write_file' ? { text: 'x' } : { old_text: 'x', new_text: 'y' };
    const beforeUnsafe = mock.requests.length;
    for (const p of ['/../etc/passwd', '/logs/../../secret', '\\..\\secret', '/bad\0path', '/', '/logs/', '/mods/test.JAR']) {
      const result = await N.call(toolName, { path: p, ...args });
      check(`${toolName} 拒绝非法路径或二进制扩展名 ${JSON.stringify(p)}`, result.isError === true);
    }
    check(`${toolName} 被路径检查拦截时不访问面板`, mock.requests.length === beforeUnsafe);
    const beforeInvalid = writes().length;
    const disguised = await N.call(toolName, { path: '/disguised.txt', ...args });
    const unknown = await N.call(toolName, { instance: 'not-allowed', path: '/editable.properties', ...args });
    const nonexistent = await N.call(toolName, { path: '/not-found.txt', ...args });
    check(`${toolName} 拒绝伪装二进制、未知实例和不存在的文件`, disguised.isError === true && unknown.isError === true && nonexistent.isError === true && writes().length === beforeInvalid);
  }
  mock.textFiles['/readonly.txt'] = 'old';
  const denied = await N.call('write_file', { path: '/readonly.txt', text: 'new' });
  check('上游保存失败不报告成功，并脱敏错误', denied.isError === true && !txt(denied).includes(KEY) && !txt(denied).includes(mock.url) && mock.textFiles['/readonly.txt'] === 'old', txt(denied));
  const beforeInvalidText = writes().length;
  for (const text of ['bad\0text', 'bad\uFFFDtext', '中'.repeat(350000)]) {
    const invalid = await N.call('write_file', { path: '/editable.properties', text });
    check('拒绝二进制字符或超过 UTF-8 字节上限的输入', invalid.isError === true);
  }
  mock.textFiles['/limit.txt'] = 'a'.repeat(1024 * 1024);
  const enlarged = await N.call('edit_file', { path: '/limit.txt', old_text: 'a'.repeat(1024), new_text: 'b'.repeat(1025), expected_matches: 1024 });
  check('替换后超出字节上限时拒绝保存', enlarged.isError === true && writes().length === beforeInvalidText);
  const boundary = await N.call('write_file', { path: '/limit.txt', text: 'b'.repeat(1024 * 1024) });
  check('恰好 1 MiB 的文本可保存且不截断', !boundary.isError && mock.textFiles['/limit.txt'] === 'b'.repeat(1024 * 1024));
  const auditN = fs.readFileSync(path.join(dirN, 'audit.log'), 'utf8');
  const entriesN = auditN.trim().split('\n').map((line) => JSON.parse(line));
  check('文件审计记录工具、实例、路径和成功/失败', entriesN.some((e) => e.tool === 'write_file' && e.instance === 'survival' && e.detail === '/editable.properties' && e.outcome === 'ok') && entriesN.some((e) => e.tool === 'edit_file' && e.outcome === 'error'));
  check('文件审计不记录原文或替换正文', !auditN.includes('FILE_BODY_PRIVATE_SENTINEL') && !auditN.includes('max-players=') && !auditN.includes(KEY));
  if (POSIX) check('文件审计日志权限为 600', (fs.statSync(path.join(dirN, 'audit.log')).mode & 0o777) === 0o600);
  check('N 组 stdout 干净（无协议错误）', N.protocolErrors.length === 0, N.protocolErrors.join(' | '));
  allOutputs.push(...N.stderr, auditN);
  await N.close();

  const O = await connect(writeCfg(path.join(tmp, 'o'), mock, { allow: { read_files: false, write_files: true } }));
  check('读写开关独立，关闭读取工具后仍可写入', O.tools.includes('write_file') && O.tools.includes('edit_file') && !O.tools.includes('read_file') && !O.tools.includes('list_files'));
  mock.textFiles['/editable.properties'] = 'value=old';
  const editOnly = await O.call('edit_file', { path: '/editable.properties', old_text: 'value=old', new_text: 'value=new' });
  check('只开启写入权限时 edit_file 仍可工作', !editOnly.isError && mock.textFiles['/editable.properties'] === 'value=new');
  allOutputs.push(...O.stderr);
  await O.close();

  // ---------- Z. global leak sweep ----------
  console.log('\n# Z. 全局泄露扫描（所有工具输出 + 服务端 stderr + 审计日志）');
  const blob = allOutputs.join('\n');
  for (const s of leakStrings(mock)) {
    check(`输出中不含 "${s.length > 12 ? s.slice(0, 6) + '…' : s}"`, !blob.includes(s));
  }
} finally {
  await mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
