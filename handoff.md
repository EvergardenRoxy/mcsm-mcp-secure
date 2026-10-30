# handoff.md — context for AI assistants

Read this before changing the code. Human-facing status and risks: `checklist.md`. User docs: `README.md` (English) and `README_zh.md` (Chinese); keep the two in sync.

## 1. What this is
- `mcsm-mcp-secure`: a single-file MCP stdio server (`server.mjs`, Node ≥18, ESM) that lets any MCP client supporting stdio servers (e.g. Claude Desktop, Claude Code, other `mcpServers`-style clients) manage MCSManager **V10** instances through the panel HTTP API.
- Version: 0.3.0. Dependencies: `@modelcontextprotocol/sdk`, `zod` (v3). No build step.
- Primary goal: least privilege + secret isolation. The API key must never reach the MCP client config, tool output, errors, stderr, or `audit.log`.

## 2. File map
| Path | Role |
| --- | --- |
| `server.mjs` | Entire server: config load/validation → HTTP client `api()` → redaction → tool registration → stdio transport |
| `config.example.json` | Template for `config.json` (address, instances, `allow` switches). Never holds the key |
| `test/mock-mcsm.mjs` | Strict mock of the V10 panel. Mirrors real panel/daemon quirks (see §4) |
| `test/run-tests.mjs` | End-to-end tests: spawns `server.mjs` over stdio with the MCP SDK client. Groups A–O + Z (leak sweep) |
| `checklist.md` | Bilingual status and risk list (IDs S1–S15). README links to its anchors `#s1`… |
| `handoff.md` | This file |

## 3. Invariants — do not break
1. Key sources: `MCSM_API_KEY` env var, or file `api_key_file` (default `api-key`) next to `config.json`. If `config.json` contains `api_key`, the server exits.
2. POSIX: config and key files must not be group/other readable (`mode & 0o077 === 0`) unless `MCSM_MCP_ALLOW_LOOSE_PERMS=1`. Skipped on `win32`.
3. Non-loopback `base_url` must be https unless `allow_insecure_http: true`. `base_url` must have no credentials, query, or hash.
4. `fetch(..., { redirect: 'error' })`, so the key is never sent to a redirect target.
5. Every tool result and error passes through `redact()` (key, encoded key, panel origin, non-loopback host). Unknown exceptions return only `e.name`.
6. Write tools (`write_file`, `edit_file`, `send_command`, `start/stop/restart_instance`, `kill_instance`) are **registered only if** the matching `allow.*` flag is true. Do not register them and then check the flag at call time. `allow.write_files` defaults to false, independently of `read_files`.
7. `get_instance_info` must not return `config.startCommand` (it may contain secrets).
8. `list_files` must not print `absolutePath` (host path). `discover_instances` must not print node IP/port.
9. `safePath()` rejects `..` segments and NUL. `send_command` rejects `\r`, `\n`, `\0`.
10. The BOM strip in `loadConfig` must stay the escaped regex `/^﻿/`. Some edit tools turn the escape into a literal BOM character; if you edit near it, verify with `grep -c 'replace(/^\\uFEFF/' server.mjs` → `1`.
11. stdout belongs to the MCP protocol. Log only to stderr (`log()`).

## 4. MCSManager V10 API facts (checked against `MCSManager/MCSManager@18c80bf`, 2026-10-12)
- Auth: `?apikey=<key>` query parameter. Required headers: `X-Requested-With: XMLHttpRequest`, `Content-Type: application/json; charset=utf-8`.
- Envelope: `{ status: <number>, data, time }`. **Errors also come with HTTP 200**, so compare `Number(json.status) !== 200`.
- Endpoints used:
  | Tool | Request | Notes |
  | --- | --- | --- |
  | `get_instance_info` | `GET /api/instance?uuid&daemonId` | |
  | `get_output_log` | `GET /api/protected_instance/outputlog?uuid&daemonId&size=64KB` | `size` parsed by the panel; a `kb` suffix is accepted |
  | `send_command` | `GET /api/protected_instance/command?...&command=` | |
  | power tools | `GET /api/protected_instance/{open,stop,restart,kill}` | |
  | `list_files` | `GET /api/files/list?uuid&daemonId&target&page&page_size&file_name` | **`file_name` must always be sent.** Panel (`panel/src/app/routers/filemananger_router.ts`) does `String(ctx.query.file_name)`; if it is missing, the daemon (`daemon/src/service/system_file.ts` `list()`) filters by the literal `"undefined"`, so every directory looks empty. `page` is 0-based. `page_size` is clamped to 1..100. Response `{ items:[{name,size,time,mode,type}], page, pageSize, total, absolutePath }`, where `type` 0=dir and 1=file |
  | `read_file` | `PUT /api/files/?uuid&daemonId`, body `{ target }` | Never send `text` for reads. Daemon refuses files >5 MB and decodes as UTF-8. Panel side effect: every read is logged as `instance_file_update` (it compares the old text with `undefined`) |
  | `write_file` / `edit_file` | `PUT /api/files/?uuid&daemonId`, body `{ target, text }` | Read existing text first; no file creation. Local limit 1 MiB for both current/result text; reject NUL/U+FFFD and binary extensions. `edit_file` uses exact literal matching with `expected_matches` (default 1). Preserve raw text (no `clean`, truncation or redaction before save). Audit only path/outcome. No atomic conditional writes or backups. |
  | `discover_instances` | `GET /api/service/remote_services_list` then `GET /api/service/remote_service_instances?daemonId&page(1-based)&page_size` | Admin-only. Skip daemons with `available: false` |
- Daemon path check: a non-existent directory returns the error "Illegal access path" (status 500). That is expected behaviour.
- MCSM starts instances with `spawn` (no shell), so shell syntax like `"$@"` in a start command is passed literally.

## 5. Testing protocol
- `npm test` must print `全部通过` and exit 0. On Windows, the permission assertions are skipped (`POSIX` flag in `run-tests.mjs`). The suite has never been run on real Windows.
- When fixing an API mismatch: first change `test/mock-mcsm.mjs` so it reproduces the real panel's behaviour (cite the MCSManager source file), confirm the test fails on the old code, then fix `server.mjs`.
- After each change, run a **mutation check**: break the new logic on purpose (remove a param, invert a condition) and confirm at least one test fails; then restore.
- Test group Z scans all outputs for the key, mock URL, node IP and mock `ABS_PATH`. Add any new sensitive value to `leakStrings`.
- Cloud or sandbox sessions usually cannot reach the user's panel. Real-panel verification is done by the maintainer in their own MCP client; ask them to run specific tool calls and paste the outputs.

## 6. Open items (see `checklist.md` for full list)
- Not verified on a real panel: `write_file` / `edit_file`, power/kill tools, `allowed_daemons`, the 0.2.0 `read_file` changes.
- S4 command-blocklist bypasses: documented only, by maintainer decision. Do not present the blocklist as a security boundary.
- S5 `read_file` returns secrets in config files verbatim. A candidate improvement is a path deny-list or masking `password=` / `token=` lines; it needs the maintainer's approval first.

## 7. Working rules
- Never ask the user to paste an API key into chat. Never print, log, or commit real keys, panel URLs, instance UUIDs, or personal file paths.
- Ask the user before calling write tools (`send_command`, power, kill) against a real server. Prefer harmless commands (`list`) for tests.
- Windows users: use `npm.cmd`. PowerShell 5.1 `>` writes UTF-16 (key files must be written with `[IO.File]::WriteAllText`).
- Keep the code style: compact, Chinese user-facing messages, English code comments.
- Update `checklist.md` (status table + issues) and the version in `package.json`, `package-lock.json`, and the `McpServer` constructor when behaviour changes.
