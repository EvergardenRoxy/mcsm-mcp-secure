# mcsm-mcp-secure

[English](README.md) | **中文**

[![AI Assisted](https://img.shields.io/badge/AI-Claude%20Opus%205.5%20%2B%20Claude%20Code-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](#ai-制作声明) [![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE) [![Node](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](#安装配置教程)

一个 **MCSManager V10** 用的最小权限 MCP 服务端（stdio），可接入任何支持 MCP 的客户端。AI 助手可以用它查看实例状态、读日志和文件；开启相应开关后，也能修改文本文件、发命令、启停实例。API Key 和面板地址分开存放，Key 不会出现在客户端配置或任何输出里。

> [!NOTE]
> 已在真实 V10 面板上验证：实例发现、状态、日志、文件列表与读取、`send_command`。文件修改、启停和强制终止只在模拟面板上测过。完整现状和问题见 [checklist.md](checklist.md)。

## 安全设计

- **密钥分离**：Key 放在单独的 `api-key` 文件（或环境变量 `MCSM_API_KEY`）；`config.json` 只放地址、实例和开关；MCP 客户端配置里只写 `config.json` 的路径。`config.json` 里写了 `api_key` 会直接拒绝启动。
- **拒绝不安全配置**：Linux / macOS 上两个文件不是 `600` 权限就拒绝启动；非本机地址必须 https；不跟随重定向。
- **输出脱敏**：Key、面板地址、节点 IP、服务器上的实例路径不会出现在工具输出、错误信息和日志里。
- **写类工具默认不注册**：文件修改、`send_command`、启停、强制终止要在 `allow` 里开启，否则模型根本看不到。
- **其他**：路径拒绝 `..`；命令拒绝换行；默认每分钟最多 60 次请求；写操作记录到 `audit.log`。

> [!WARNING]
> 命令黑名单可以绕过，不是安全边界（[S4](checklist.md#s4)）；游戏内聊天和日志可能对模型进行提示注入（[S3](checklist.md#s3)）；`read_file` 会把配置文件里的密码原样交给模型（[S5](checklist.md#s5)）。真正的边界是面板账号的权限。

## 安装配置教程

共六步：准备面板 → 安装 → 写 `config.json` → 保存密钥 → 接入客户端 → 验证。每一步都分 Linux（macOS 相同）和 Windows 两种写法。

### 第 1 步：在面板上准备

1. **生成 API Key**：登录面板，点右上角用户菜单 →「个人资料」→ API 密钥一栏点「生成」。先不要关闭这个窗口，第 4 步要粘贴它。不要把它存进记事本或聊天里。
2. **记下实例 ID**：打开实例的控制台页面，地址里有 `/instances/terminal?daemonId=…&instanceId=…`，把这两个值记下来。
   如果使用通配模式（自动发现所有实例，但**需要管理员 Key**），可以跳过这一步。

> [!CAUTION]
> API Key 的权限与生成它的账号完全一致。请用**专用低权限账号**生成，只分配需要管理的实例。不要把 Key 贴进任何聊天。

### 第 2 步：安装

需要 Node.js ≥ 18（用 `node -v` 查看）。

**Linux**

```bash
# 如未安装 Node.js，请用发行版的包管理器或从 https://nodejs.org 安装
git clone https://github.com/EvergardenRoxy/mcsm-mcp-secure.git ~/mcsm-mcp-secure
cd ~/mcsm-mcp-secure
npm install
npm test   # 可选：针对模拟面板的端到端测试
```

**Windows（PowerShell）**

```powershell
winget install OpenJS.NodeJS.LTS   # 如未安装 Node.js；装完重新打开 PowerShell
git clone https://github.com/EvergardenRoxy/mcsm-mcp-secure.git "$HOME\mcsm-mcp-secure"
# 没有 git：在 GitHub 页面点「Code → Download ZIP」，解压到同一个文件夹
cd "$HOME\mcsm-mcp-secure"
npm.cmd install   # 用 npm.cmd：PowerShell 的执行策略可能会拦截 npm.ps1
```

### 第 3 步：创建 `config.json`

配置放在项目文件夹之外，以后更新代码不会影响它。

**Linux**

```bash
mkdir -p ~/.config/mcsm-mcp && chmod 700 ~/.config/mcsm-mcp
cp ~/mcsm-mcp-secure/config.example.json ~/.config/mcsm-mcp/config.json
chmod 600 ~/.config/mcsm-mcp/config.json
nano ~/.config/mcsm-mcp/config.json
```

**Windows（PowerShell）**

```powershell
$dir = "$HOME\.config\mcsm-mcp"; New-Item -ItemType Directory -Force $dir | Out-Null
Copy-Item "$HOME\mcsm-mcp-secure\config.example.json" "$dir\config.json"
notepad "$dir\config.json"   # 保存为 UTF-8（带不带 BOM 都可以）
```

填入面板地址和第 1 步记下的 ID：

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

使用通配模式时：把 `instances` 写成 `{}`，删掉 `default_instance`，再加上 `"wildcard": { "enabled": true }`。全部字段见[配置字段](#配置字段)。

### 第 4 步：保存 API Key

Key 单独存放在 `config.json` 同目录下名为 `api-key` 的文件里。下面的命令输入时不回显，也不会进入命令历史。

**Linux**

```bash
read -rs MCSM_KEY && printf '%s' "$MCSM_KEY" > ~/.config/mcsm-mcp/api-key && unset MCSM_KEY
chmod 600 ~/.config/mcsm-mcp/api-key
```

**Windows（PowerShell）**：不要用 `>` 或 `Out-File`，PowerShell 5.1 会写成 UTF-16。

```powershell
$dir = "$HOME\.config\mcsm-mcp"
$k = Read-Host "API Key" -AsSecureString
[IO.File]::WriteAllText("$dir\api-key", [Net.NetworkCredential]::new('', $k).Password); Remove-Variable k
icacls "$dir\api-key" /inheritance:r /grant:r "${env:USERNAME}:F"   # 只允许当前用户读取
```

也可以不用文件，改用环境变量 `MCSM_API_KEY` 提供 Key。

### 第 5 步：接入 MCP 客户端

任何支持 stdio MCP 服务端的客户端都可以使用，需要三项：命令 `node`、`server.mjs` 的绝对路径、环境变量 `MCSM_MCP_CONFIG`（指向 `config.json`）。客户端配置里没有密钥，也没有面板地址。

**`mcpServers` JSON 格式**（Claude Desktop 的 `claude_desktop_config.json` 等许多客户端采用这种格式，具体文件位置见各客户端文档）：

```json
{
  "mcpServers": {
    "mcsm": {
      "command": "node",
      "args": ["/home/<你>/mcsm-mcp-secure/server.mjs"],
      "env": { "MCSM_MCP_CONFIG": "/home/<你>/.config/mcsm-mcp/config.json" }
    }
  }
}
```

Windows 路径请用正斜杠（`C:/Users/<你>/mcsm-mcp-secure/server.mjs`）或双反斜杠（`C:\\Users\\...`）。单个 `\` 会让 JSON 无效。

**命令行添加**（以 Claude Code 为例）：

```bash
claude mcp add mcsm -e MCSM_MCP_CONFIG=$HOME/.config/mcsm-mcp/config.json -- node $HOME/mcsm-mcp-secure/server.mjs
```

### 第 6 步：验证

1. **先在终端里试运行**（可选，但能清楚看到启动错误）：
   ```bash
   # Linux
   MCSM_MCP_CONFIG=~/.config/mcsm-mcp/config.json node ~/mcsm-mcp-secure/server.mjs
   ```
   ```powershell
   # Windows
   $env:MCSM_MCP_CONFIG = "$HOME\.config\mcsm-mcp\config.json"; node "$HOME\mcsm-mcp-secure\server.mjs"
   ```
   看到以 `[mcsm-mcp] 就绪` 开头的一行，说明配置正确。按 `Ctrl+C` 退出。
2. **完全重启 MCP 客户端**（Windows / macOS 上要从托盘或菜单栏退出），然后让 AI 助手调用 `list_instances` 和 `get_instance_info`。

**常见报错**：

| 报错 | 原因 / 解决 |
| --- | --- |
| `找不到配置文件` | `MCSM_MCP_CONFIG` 路径不对 |
| `权限过宽` | Linux/macOS：对报错里的文件执行 `chmod 600` |
| `配置文件不是合法 JSON` | 少了逗号或引号，或者 Windows 路径用了单个反斜杠 |
| `配置无效` | 字段名写错或多了未知字段，对照 `config.example.json` |
| `找不到密钥文件` | `config.json` 所在目录里没有 `api-key` |
| `非本机地址必须使用 https` | 改用 https 面板地址（见[公网面板建议](#公网面板建议)） |
| `无法连接面板` | 面板不可达、端口错误，或面板返回了重定向（程序故意不跟随） |
| `面板返回了非 JSON 内容` | `base_url` 没有指向 MCSManager 面板 |
| `面板返回 status=403` | Key 错误，或账号没有该实例 / 管理员接口的权限 |

## 配置字段

| 字段 | 说明 |
| --- | --- |
| `base_url` | 面板地址，如 `https://panel.example.com`（可带子路径） |
| `api_key_file` | 密钥文件名，相对于 `config.json` 所在目录（默认 `api-key`） |
| `default_instance` | 工具调用没有指定 `instance` 时使用的别名 |
| `instances` | 别名 → `uuid` + `daemon_id`（可选 `description`） |
| `wildcard` | `enabled: true` 时自动发现所有实例（**需要管理员 Key**）；`allowed_daemons` 限定节点 UUID |
| `allow` | `read_files`（默认开）、`write_files`、`send_command`、`power`、`kill`（默认关） |
| `blocked_command_prefixes` | 禁止的命令前缀，默认 `stop`、`op `、`deop `、`save-off` |
| `rate_limit_per_minute` | 每分钟请求上限（默认 60） |
| `max_output_chars` | 每次工具调用最多返回的字符数（默认 8000） |
| `request_timeout_ms` | 面板请求超时（默认 20000） |
| `allow_insecure_http` | 允许对非本机地址使用明文 http（不推荐） |

## 工具

| 工具 | 何时可见 | 说明 |
| --- | --- | --- |
| `list_instances` | 始终 | 列出已配置的实例别名 |
| `discover_instances` | `wildcard.enabled` | 列出所有节点上的实例（昵称、状态、UUID） |
| `get_instance_info` | 始终 | 状态、资源占用、玩家数（不含启动命令） |
| `get_output_log` | 始终 | 终端输出最后 N 行，已去除颜色码 |
| `list_files` | `allow.read_files` | 列目录；`filter` 按名称过滤，`page` 从 0 开始 |
| `read_file` | `allow.read_files` | 读文本文件；`lines` + `from: tail/head` 选取部分；拒绝二进制和压缩文件 |
| `write_file` | `allow.write_files` | 用完整 `text` 覆盖已有文本文件，空文本表示清空 |
| `edit_file` | `allow.write_files` | 按字面值将 `old_text` 替换为 `new_text`；匹配数必须等于 `expected_matches`（默认 1） |
| `send_command` | `allow.send_command` | 发送命令并返回新增输出 |
| `start_instance` / `stop_instance` / `restart_instance` | `allow.power` | 启动 / 停止 / 重启 |
| `kill_instance` | `allow.kill` | 强制终止 |

通配模式下，`instance` 参数可以用别名、实例昵称（不区分大小写）或 UUID；昵称重复时会拒绝猜测。

### 开启文件修改

在现有 `config.json` 中将 `allow.write_files` 设为 `true`，然后重启 MCP 服务端或客户端连接。此开关独立于 `allow.read_files`，不需要开启控制台命令或电源权限。文件须已存在，且面板账号有权访问；这两个工具不创建文件或目录。

局部修改可调用 `edit_file`：

```json
{"instance":"survival","path":"/server.properties","old_text":"max-players=20","new_text":"max-players=40"}
```

工具内部读取完整文件，所以 `read_file` 输出范围以外的内容也会保留，包含 CRLF、BOM 和美元符号。未匹配或重复匹配时不保存；需要替换多处时，显式将 `expected_matches` 设为匹配数量。`new_text: ""` 表示删除匹配内容。只有掌握完整替换文本时才使用 `write_file`，不要用经过截断或脱敏的 `read_file` 输出覆盖文件。

原文件和修改结果都须为不超过 **1 MiB** 的 UTF-8 文本；拒绝二进制扩展名、NUL 和替换字符。审计日志只记录工具、实例、路径和结果，不记录文件正文。保存会覆盖文件，不自动备份；面板没有原子条件写入接口，应避免同时编辑同一文件。修改后可能需要在应用中重载或重启才能生效。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `MCSM_MCP_CONFIG` | `config.json` 路径（默认 `~/.config/mcsm-mcp/config.json`） |
| `MCSM_API_KEY` | 直接提供密钥，优先于密钥文件 |
| `MCSM_MCP_AUDIT` | 审计日志路径（默认与配置同目录的 `audit.log`） |
| `MCSM_MCP_ALLOW_LOOSE_PERMS=1` | 跳过文件权限检查（不推荐） |

## 公网面板建议

1. 面板走 https（反向代理 + 证书）。如果通过 FRP 等隧道映射到本机，请确认隧道本身加密（[S6](checklist.md#s6)）。
2. MCSM 只支持把 Key 放在 URL 查询参数里，反向代理日志要去掉查询串（[S1](checklist.md#s1)）：
   ```nginx
   log_format safe '$remote_addr [$time_local] "$request_method $uri" $status $body_bytes_sent';
   ```
3. 在反代层限制来源 IP；定期轮换 Key。

## 已知问题

问题清单、严重度和审查要点见 **[checklist.md](checklist.md)**（中英双语）。给 AI 助手的交接说明见 [handoff.md](handoff.md)。

<a id="ai-制作声明"></a>

## AI 制作声明

> [!IMPORTANT]
> **AI 制作声明：mcsm-mcp-secure 采用生成式 AI 参与架构设计、编码、文档与测试。** AI 生成或修改的内容由项目维护者审阅、验证并承担最终维护责任。
>
> 参与的 AI：**Claude Opus 5.5**（通过 **Claude Code**）参与架构设计、编码、测试与安全审查，对照 MCSManager 源码核对接口并修复缺陷，以及 README、审查清单（`checklist.md`）与交接文档（`handoff.md`）的编写。

## 许可证

[MIT](LICENSE) © 2026 EvergardenRoxy
