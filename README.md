# mcsm-mcp-secure

**English** | [中文](README_zh.md)

[![AI Assisted](https://img.shields.io/badge/AI-Claude%20Opus%205.5%20%2B%20Claude%20Code-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](#ai-disclosure) [![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE) [![Node](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](#setup-guide)

A least-privilege MCP server (stdio) for **MCSManager V10** that works with any MCP-capable client. It lets an AI assistant check instance status and read logs and files. With the matching switches on, it can also modify text files, send console commands and start or stop instances. The API key and the panel address are stored separately, and the key never appears in the client config or in any output.

> [!NOTE]
> Verified on a real V10 panel: instance discovery, status, logs, file listing and reading, and `send_command`. File modification and start/stop/restart/kill have only been tested against a mock panel. See [checklist.md](checklist.md) for the full status and known issues.
>
> Tool output and error messages are in Chinese.

## Security design

- **Separated secrets**: the key lives in its own `api-key` file (or the `MCSM_API_KEY` environment variable). `config.json` holds only the address, instances and switches, and the MCP client config holds only the path to `config.json`. The server refuses to start if `config.json` contains `api_key`.
- **Unsafe setups are refused**: on Linux/macOS both files must be mode `600`; non-local addresses must use https; redirects are never followed.
- **Redacted output**: the key, panel address, node IPs and the instance's path on the host never appear in tool results, errors or logs.
- **Write tools are not registered by default**: file modification, `send_command`, start/stop/restart and kill must be enabled under `allow`. Until then, the model cannot see them.
- **Also**: paths containing `..` are rejected; commands containing line breaks are rejected; requests are limited to 60 per minute by default; write actions are recorded in `audit.log`.

> [!WARNING]
> The command blocklist can be bypassed and is not a security boundary ([S4](checklist.md#s4)). In-game chat and logs can carry prompt injection to the model ([S3](checklist.md#s3)). `read_file` passes passwords in config files to the model as-is ([S5](checklist.md#s5)). The real boundary is the panel account's permissions.

## Setup guide

Six steps: prepare the panel → install → write `config.json` → save the key → connect a client → verify. Each step has Linux (macOS is the same) and Windows instructions.

### Step 1. Prepare the panel

1. **Create an API key.** Log in to the panel, open the user menu in the top-right corner → **Profile** → **Generate New Key** in the API key section. Keep the dialog open; you will paste it in step 4. Do not save it in a notes file or chat.
2. **Find the instance IDs.** Open the instance's console page. The address contains `/instances/terminal?daemonId=…&instanceId=…`; write down both values.
   You can skip this if you use wildcard mode (it discovers every instance automatically, but **requires an admin key**).

> [!CAUTION]
> The key has exactly the permissions of the account that created it. Use a **dedicated low-privilege account** that only has the instances you need. Never paste the key into any chat.

### Step 2. Install

Requires Node.js ≥ 18 (check with `node -v`).

**Linux**

```bash
# Install Node.js from your package manager or https://nodejs.org if needed
git clone https://github.com/EvergardenRoxy/mcsm-mcp-secure.git ~/mcsm-mcp-secure
cd ~/mcsm-mcp-secure
npm install
npm test   # optional: end-to-end tests against a mock panel
```

**Windows (PowerShell)**

```powershell
winget install OpenJS.NodeJS.LTS   # if Node.js is not installed; reopen PowerShell afterwards
git clone https://github.com/EvergardenRoxy/mcsm-mcp-secure.git "$HOME\mcsm-mcp-secure"
# No git? Use "Code → Download ZIP" on GitHub and unzip it to the same folder.
cd "$HOME\mcsm-mcp-secure"
npm.cmd install   # use npm.cmd: PowerShell may block npm.ps1 by execution policy
```

### Step 3. Create `config.json`

The config lives outside the project folder, so updating the code never touches it.

**Linux**

```bash
mkdir -p ~/.config/mcsm-mcp && chmod 700 ~/.config/mcsm-mcp
cp ~/mcsm-mcp-secure/config.example.json ~/.config/mcsm-mcp/config.json
chmod 600 ~/.config/mcsm-mcp/config.json
nano ~/.config/mcsm-mcp/config.json
```

**Windows (PowerShell)**

```powershell
$dir = "$HOME\.config\mcsm-mcp"; New-Item -ItemType Directory -Force $dir | Out-Null
Copy-Item "$HOME\mcsm-mcp-secure\config.example.json" "$dir\config.json"
notepad "$dir\config.json"   # saving as UTF-8 (with or without BOM) is fine
```

Fill in the panel address and the IDs from step 1:

```json
{
  "base_url": "https://panel.example.com",
  "api_key_file": "api-key",
  "default_instance": "survival",
  "instances": {
    "survival": { "uuid": "<instanceId>", "daemon_id": "<daemonId>", "description": "Survival server" }
  },
  "allow": { "read_files": true, "write_files": false, "send_command": false, "power": false, "kill": false }
}
```

For wildcard mode, use `"instances": {}`, remove `default_instance`, and add `"wildcard": { "enabled": true }`. See [Configuration reference](#configuration-reference) for every field.

### Step 4. Save the API key

The key goes into a separate file named `api-key`, next to `config.json`. Both commands below read it without echoing it to the screen or shell history.

**Linux**

```bash
read -rs MCSM_KEY && printf '%s' "$MCSM_KEY" > ~/.config/mcsm-mcp/api-key && unset MCSM_KEY
chmod 600 ~/.config/mcsm-mcp/api-key
```

**Windows (PowerShell)**: do not use `>` or `Out-File`; PowerShell 5.1 writes UTF-16.

```powershell
$dir = "$HOME\.config\mcsm-mcp"
$k = Read-Host "API Key" -AsSecureString
[IO.File]::WriteAllText("$dir\api-key", [Net.NetworkCredential]::new('', $k).Password); Remove-Variable k
icacls "$dir\api-key" /inheritance:r /grant:r "${env:USERNAME}:F"   # only the current user can read it
```

Alternatively, provide the key through the `MCSM_API_KEY` environment variable instead of a file.

### Step 5. Connect an MCP client

Any client that supports stdio MCP servers works. It needs three things: the command `node`, the absolute path to `server.mjs`, and the environment variable `MCSM_MCP_CONFIG` pointing to `config.json`. The client config contains neither the key nor the panel address.

**`mcpServers` JSON format** (used by Claude Desktop's `claude_desktop_config.json` and many other clients; see your client's docs for the file location):

```json
{
  "mcpServers": {
    "mcsm": {
      "command": "node",
      "args": ["/home/<you>/mcsm-mcp-secure/server.mjs"],
      "env": { "MCSM_MCP_CONFIG": "/home/<you>/.config/mcsm-mcp/config.json" }
    }
  }
}
```

On Windows, use forward slashes (`C:/Users/<you>/mcsm-mcp-secure/server.mjs`) or doubled backslashes (`C:\\Users\\...`). A single `\` makes the JSON invalid.

**From the command line** (Claude Code as an example):

```bash
claude mcp add mcsm -e MCSM_MCP_CONFIG=$HOME/.config/mcsm-mcp/config.json -- node $HOME/mcsm-mcp-secure/server.mjs
```

### Step 6. Verify

1. **Test from a terminal first** (optional, but it shows startup errors clearly):
   ```bash
   # Linux
   MCSM_MCP_CONFIG=~/.config/mcsm-mcp/config.json node ~/mcsm-mcp-secure/server.mjs
   ```
   ```powershell
   # Windows
   $env:MCSM_MCP_CONFIG = "$HOME\.config\mcsm-mcp\config.json"; node "$HOME\mcsm-mcp-secure\server.mjs"
   ```
   A line starting with `[mcsm-mcp] 就绪` ("ready") means the config is valid. Press `Ctrl+C` to exit.
2. **Restart the MCP client completely** (on Windows/macOS, also quit it from the tray/menu bar), then ask the assistant to call `list_instances` and `get_instance_info`.

**Troubleshooting** (server messages are in Chinese):

| Message | Cause / fix |
| --- | --- |
| `找不到配置文件` | `MCSM_MCP_CONFIG` points to the wrong path |
| `权限过宽` | Linux/macOS: run `chmod 600` on the file named in the message |
| `配置文件不是合法 JSON` | Missing comma or quote, or single backslashes in a Windows path |
| `配置无效` | Unknown or mistyped field name; compare with `config.example.json` |
| `找不到密钥文件` | `api-key` is missing from the folder that holds `config.json` |
| `非本机地址必须使用 https` | Use an https panel address (see [Public panels](#public-panels)) |
| `无法连接面板` | Panel unreachable, wrong port, or the panel answered with a redirect (not followed on purpose) |
| `面板返回了非 JSON 内容` | `base_url` does not point to the MCSManager panel |
| `面板返回 status=403` | Wrong key, or the account lacks permission for that instance / admin API |

## Configuration reference

| Field | Meaning |
| --- | --- |
| `base_url` | Panel address, e.g. `https://panel.example.com` (a sub-path is fine) |
| `api_key_file` | Key file name, relative to `config.json` (default `api-key`) |
| `default_instance` | Alias used when a tool call omits `instance` |
| `instances` | Alias → `uuid` + `daemon_id` (+ optional `description`) |
| `wildcard` | `enabled: true` discovers every instance (**requires an admin key**); `allowed_daemons` limits it to certain node UUIDs |
| `allow` | `read_files` (on by default), `write_files`, `send_command`, `power`, `kill` (off by default) |
| `blocked_command_prefixes` | Forbidden command prefixes; default `stop`, `op `, `deop `, `save-off` |
| `rate_limit_per_minute` | Request limit (default 60) |
| `max_output_chars` | Maximum characters returned per tool call (default 8000) |
| `request_timeout_ms` | Panel request timeout (default 20000) |
| `allow_insecure_http` | Allow plain http to a non-local address (not recommended) |

## Tools

| Tool | Visible when | Description |
| --- | --- | --- |
| `list_instances` | always | Lists the configured instance aliases |
| `discover_instances` | `wildcard.enabled` | Lists instances on all nodes (nickname, status, UUID) |
| `get_instance_info` | always | Status, resource usage, player count (no start command) |
| `get_output_log` | always | Last N lines of console output, colour codes removed |
| `list_files` | `allow.read_files` | Lists a directory; `filter` matches names, `page` starts at 0 |
| `read_file` | `allow.read_files` | Reads a text file; `lines` + `from: tail/head` pick a part; binary and compressed files are refused |
| `write_file` | `allow.write_files` | Overwrites an existing text file with the complete `text`; empty text clears it |
| `edit_file` | `allow.write_files` | Replaces literal `old_text` with `new_text`; requires exactly `expected_matches` occurrences (default 1) |
| `send_command` | `allow.send_command` | Sends a console command and returns the new output |
| `start_instance` / `stop_instance` / `restart_instance` | `allow.power` | Start / stop / restart |
| `kill_instance` | `allow.kill` | Force kill |

In wildcard mode, the `instance` argument accepts an alias, an instance nickname (case-insensitive) or a UUID. Duplicate nicknames are rejected instead of guessed.

### Enable file modification

Set `allow.write_files` to `true` in your existing `config.json` and restart the MCP server/client connection. This switch is independent of `allow.read_files`; neither console-command nor power permissions are needed. Files must already exist and be accessible to the panel account; these tools do not create files or directories.

For a local change, call `edit_file` with:

```json
{"instance":"survival","path":"/server.properties","old_text":"max-players=20","new_text":"max-players=40"}
```

The entire file is read internally, so text outside `read_file`'s output limits is preserved, including CRLF, BOM and literal dollar signs. A missing or repeated match aborts the save; to replace multiple occurrences, explicitly set `expected_matches` to their count. `new_text: ""` deletes the matched text. Use `write_file` only when you have the complete replacement text; never overwrite a file with truncated or redacted `read_file` output.

Both the existing and resulting file must be valid UTF-8 text of at most **1 MiB**. Binary extensions, NUL and replacement characters are refused. Audit entries contain the tool, instance, path and outcome, without file contents. Saves overwrite the file without a backup; the panel offers no atomic conditional-write API, so avoid concurrent edits to the same file. Changes may require a reload or restart in the application.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `MCSM_MCP_CONFIG` | Path to `config.json` (default `~/.config/mcsm-mcp/config.json`) |
| `MCSM_API_KEY` | Supplies the key directly; takes priority over the key file |
| `MCSM_MCP_AUDIT` | Audit log path (default `audit.log` next to the config) |
| `MCSM_MCP_ALLOW_LOOSE_PERMS=1` | Skips the file permission check (not recommended) |

## Public panels

1. Serve the panel over https (reverse proxy + certificate). If it is mapped to localhost through a tunnel such as FRP, make sure the tunnel itself is encrypted ([S6](checklist.md#s6)).
2. MCSManager only accepts the key as a URL query parameter, so strip the query string from reverse-proxy logs ([S1](checklist.md#s1)):
   ```nginx
   log_format safe '$remote_addr [$time_local] "$request_method $uri" $status $body_bytes_sent';
   ```
3. Restrict source IPs at the proxy, and rotate keys regularly.

## Known issues

See **[checklist.md](checklist.md)** (English and Chinese) for issues, severity and review points. Notes for AI assistants working on this code are in [handoff.md](handoff.md).

<a id="ai-disclosure"></a>

## AI disclosure

> [!IMPORTANT]
> **AI disclosure: generative AI took part in the architecture, code, documentation and tests of mcsm-mcp-secure.** All AI-generated or AI-modified content is reviewed and verified by the project maintainer, who is responsible for its maintenance.
>
> AI involved: **Claude Opus 5.5** (via **Claude Code**): architecture design, coding, testing and security review, checking the API against the MCSManager source and fixing defects, and writing the README, the review checklist (`checklist.md`) and the handoff notes (`handoff.md`).

## License

[MIT](LICENSE) © 2026 EvergardenRoxy
