// Loads and validates everything the server needs to start: config.json, the API key and the panel address.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/** A startup problem the user has to fix; the message never quotes file contents. */
export class ConfigError extends Error {}

const ConfigSchema = z
  .object({
    base_url: z.string().min(1),
    api_key_file: z.string().default('api-key'),
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

/** Secrets must not be readable by group/others. POSIX modes don't exist on Windows. */
function assertPrivateFile(file, label, env) {
  if (process.platform === 'win32' || env.MCSM_MCP_ALLOW_LOOSE_PERMS === '1') return;
  const mode = fs.statSync(file).mode & 0o777;
  if (mode & 0o077) {
    throw new ConfigError(`${label} (${file}) 权限过宽 (${mode.toString(8)})，其他用户可读。请执行: chmod 600 "${file}"`);
  }
}

function readConfigFile(configPath, env) {
  if (!fs.existsSync(configPath)) throw new ConfigError(`找不到配置文件 ${configPath}，请参考 config.example.json`);
  assertPrivateFile(configPath, '配置文件', env);

  let raw;
  try {
    // Strip a UTF-8 BOM: Windows Notepad / PowerShell "-Encoding UTF8" often add one.
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    // Deliberately no parser message: it could quote file content.
    throw new ConfigError('配置文件不是合法 JSON（请检查逗号、引号）');
  }
  if (raw && typeof raw === 'object' && 'api_key' in raw) {
    throw new ConfigError('配置文件中不允许直接写 api_key。请把密钥放进单独的密钥文件（api_key_file）或环境变量 MCSM_API_KEY');
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError('配置无效: ' + issues.join('; '));
  }
  const config = parsed.data;
  if (config.default_instance && !config.instances[config.default_instance]) {
    throw new ConfigError(`default_instance "${config.default_instance}" 不在 instances 中`);
  }
  return config;
}

/** The key comes from MCSM_API_KEY, or from a separate file next to config.json. */
function readApiKey(keyFile, env) {
  let key = env.MCSM_API_KEY?.trim();
  if (!key) {
    if (!fs.existsSync(keyFile)) throw new ConfigError(`找不到密钥文件 ${keyFile}（或设置环境变量 MCSM_API_KEY）`);
    assertPrivateFile(keyFile, '密钥文件', env);
    key = fs.readFileSync(keyFile, 'utf8').trim();
  }
  if (!key || /\s/.test(key)) throw new ConfigError('API 密钥为空或包含空白字符');
  return key;
}

function parsePanelAddress(baseUrl, allowInsecureHttp) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfigError('base_url 不是有效的 URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ConfigError('base_url 只支持 http(s)');
  if (url.username || url.password) throw new ConfigError('base_url 不能包含账号密码');
  if (url.search || url.hash) throw new ConfigError('base_url 不能包含查询参数或锚点（密钥由程序自动附加）');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !loopback && !allowInsecureHttp) {
    throw new ConfigError('非本机地址必须使用 https，否则 API 密钥会以明文在公网传输。（确需内网 http，请显式设置 allow_insecure_http: true）');
  }
  return { origin: url.origin, prefix: url.pathname.replace(/\/+$/, ''), host: url.hostname, loopback };
}

/**
 * @returns {{ config: z.infer<typeof ConfigSchema>, apiKey: string, auditPath: string,
 *             panel: { origin: string, prefix: string, host: string, loopback: boolean } }}
 * @throws {ConfigError}
 */
export function loadConfig(env = process.env) {
  const homeDir = env.MCSM_MCP_HOME || path.join(os.homedir(), '.config', 'mcsm-mcp');
  const configPath = path.resolve(env.MCSM_MCP_CONFIG || path.join(homeDir, 'config.json'));
  const configDir = path.dirname(configPath);

  const config = readConfigFile(configPath, env);
  return {
    config,
    apiKey: readApiKey(path.resolve(configDir, config.api_key_file), env),
    panel: parsePanelAddress(config.base_url, config.allow_insecure_http),
    auditPath: path.resolve(env.MCSM_MCP_AUDIT || path.join(configDir, 'audit.log')),
  };
}
