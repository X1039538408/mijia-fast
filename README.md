# mijia-fast

## 中文

`mijia-fast` 是一个 Windows 优先、局域网优先的米家自动化管理工具，为 [Oh My Sage](https://github.com/allocnode/oh-my-sage) 提供精简 CLI 和 MCP 适配层。

它负责连接、查询、校验、预览、备份和验证规则；日常自动化仍由米家极客版网关本地运行，不依赖模型持续在线。

### 适合谁

- 想用命令行快速维护家庭自动化的人。
- 想让模型通过少量高层 MCP 工具安全修改规则的人。
- 想把规则 Graph、设备映射和快照保留在本地，不依赖 NAS 或公网服务的人。

### 功能

- CLI：设备清单、规则查询、Graph 校验、补丁、dry-run、快照和恢复。
- 中文优先的状态、诊断、历史和错误提示。
- Windows Named Pipe 常驻 daemon，不开放新的局域网 TCP 端口。
- 精简 MCP：`mi_connect`、`mi_search`、`mi_get`、`mi_patch`、`mi_sync`。
- `mi_patch` 默认只生成预览，提供确认标识后才写入。
- 主卧卫生间离开规则补丁：灯光和换气使用独立延时，并在关闭前重新确认无人。

### 环境要求

- Windows 10 或更高版本。
- Node.js 20 或更高版本。
- 已安装且可执行的 `oh-my-sage-mcp`。
- 当前电脑可以访问米家自动化极客版网关。

本项目调用 Oh My Sage MCP，不重新实现米家网关协议。

### 五分钟开始

```powershell
git clone https://github.com/X1039538408/mijia-fast.git
cd mijia-fast
npm install
$env:MIJIA_BACKEND_COMMAND = 'C:\path\to\oh-my-sage-mcp.cmd'
```

首次连接并生成本机私有设备/规则映射：

```powershell
node .\src\cli.mjs setup --passcode <六位登录码>
node .\src\cli.mjs status
node .\src\cli.mjs doctor
```

`setup` 会读取当前设备和规则，写入 `.data/local-config.json`。登录码只在当前进程内存中使用，不写入配置、快照、审计或计划任务命令行。

如果不使用向导，也可以手动复制并编辑 `config/mijia.json`，或通过 `MIJIA_CONFIG_PATH` 指定本地配置文件。

### 日常命令

```powershell
# 查看设备和规则
node .\src\cli.mjs inventory
node .\src\cli.mjs rules list
node .\src\cli.mjs rules get --name "卧室全局无人关闭灯光"
node .\src\cli.mjs rules explain --name "卧室全局无人关闭灯光"
node .\src\cli.mjs rules lint --name "卧室全局无人关闭灯光"

# 预览修改。没有 --apply 时不会写入网关
node .\src\cli.mjs rule bedroom_all_empty_off set-delay 10s --dry-run

# 确认后写入，自动备份并回读验证
node .\src\cli.mjs rule bedroom_all_empty_off set-delay 10s --apply

# 主卧卫生间灯和换气延时
node .\src\cli.mjs rule bathroom_leave_light_vent_off set-bathroom-delays --light 2m --vent 5m --dry-run
node .\src\cli.mjs rule bathroom_leave_light_vent_off set-bathroom-delays --light 2m --vent 5m --apply
```

终端默认显示中文摘要；脚本和 MCP 场景使用 `--json` 获取稳定 JSON：

```powershell
node .\src\cli.mjs rules list --json
node .\src\cli.mjs status --json
```

旧的 `rule <别名> set-delay|enable|disable` 语法继续保留。非交互环境必须明确使用 `--apply` 或 `--yes` 才会写入。

### daemon 常驻会话

```powershell
node .\src\cli.mjs daemon start --passcode <六位登录码>
node .\src\cli.mjs daemon status
node .\src\cli.mjs daemon restart --passcode <六位登录码>
node .\src\cli.mjs daemon stop
```

daemon 通过 Windows Named Pipe 接收本机请求，复用一次后端登录会话。可以注册登录时启动的计划任务：

```powershell
node .\src\cli.mjs daemon install
node .\src\cli.mjs daemon uninstall
```

计划任务不会保存登录码。要实现开机自动连接，需要由用户自行配置用户级 `MIJIA_PASSCODE`；不希望持久化登录码时，请继续手动启动 daemon。

### 快照、差异和历史

```powershell
node .\src\cli.mjs backup create
node .\src\cli.mjs backup list
node .\src\cli.mjs backup show --id <快照编号>
node .\src\cli.mjs backup diff --id <快照编号>
node .\src\cli.mjs backup restore --id <快照编号> --dry-run
node .\src\cli.mjs backup restore --id <快照编号> --apply
node .\src\cli.mjs history
```

写入规则前会创建快照；回读验证失败时会尝试恢复原 Graph。`.data/` 中保存缓存、快照、审计和本地配置。

### MCP

```json
{
  "mcpServers": {
    "mijia-fast": {
      "command": "node",
      "args": ["C:/path/to/mijia-fast/src/mcp-server.mjs"],
      "environment": {
        "GATEWAY_URL": "http://127.0.0.1:8086",
        "MIJIA_BACKEND_COMMAND": "oh-my-sage-mcp"
      }
    }
  }
}
```

模型调用 `mi_patch` 时，第一次调用只返回紧凑差异和短期 `confirmation_token`；第二次携带该标识才执行备份、写入和回读。复杂 Graph 默认不返回给模型。

### 隐私和开源边界

不要提交以下内容：

- `.data/` 目录。
- 真实设备 ID、规则 ID、完整 Graph 和快照。
- 米家登录码、网关凭据和个人网络地址。
- 包含家庭房间布局的调试输出。

公开仓库只保留占位配置和示例计划。提交前请运行：

```powershell
npm run check
npm test
```

### 当前定位

项目定位是个人家庭局域网的 Windows-first 管理工具，不是公网多用户服务，也不直接暴露米家网关端口。日常自动化在极客版网关本地运行，不消耗模型 token。

## English

`mijia-fast` is a Windows-first, LAN-first CLI and MCP adapter for [Oh My Sage](https://github.com/allocnode/oh-my-sage).

It handles connection, discovery, rule inspection, Graph validation, previews, backups, verified writes, and recovery. Runtime automations continue to execute locally in the MiJia gateway.

### Quick start

```powershell
git clone https://github.com/X1039538408/mijia-fast.git
cd mijia-fast
npm install
$env:MIJIA_BACKEND_COMMAND = 'C:\path\to\oh-my-sage-mcp.cmd'
node .\src\cli.mjs setup --passcode <six-digit-code>
node .\src\cli.mjs status
node .\src\cli.mjs doctor
```

`setup` discovers devices and rules and stores the private mapping in `.data/local-config.json`. The passcode is kept in memory only and is not written to config, snapshots, audit logs, or scheduled-task arguments.

### Common commands

```powershell
node .\src\cli.mjs inventory
node .\src\cli.mjs rules list
node .\src\cli.mjs rules get --name "Bedroom all-empty lights off"
node .\src\cli.mjs rules explain --name "Bedroom all-empty lights off"
node .\src\cli.mjs rule bedroom_all_empty_off set-delay 10s --dry-run
node .\src\cli.mjs rule bedroom_all_empty_off set-delay 10s --apply
node .\src\cli.mjs backup list
node .\src\cli.mjs backup diff --id <snapshot-id>
node .\src\cli.mjs history
```

Human-readable summaries are used in terminals. Add `--json` for scripts and integrations. Non-interactive writes require explicit `--apply` or `--yes`.

### Daemon and MCP

The daemon uses a local Windows Named Pipe and does not open a LAN TCP port. `mi_patch` returns a preview first and requires a short-lived confirmation token before writing.

Legacy low-level tools remain available only when `MIJIA_EXPOSE_LEGACY_TOOLS=1` is set.

### Privacy

Do not commit `.data/`, real device or rule IDs, complete Graphs, snapshots, login codes, gateway credentials, or private room-layout diagnostics. The public repository contains only placeholder configuration and examples.

### Development

```powershell
npm run check
npm test
```

## License

MIT
