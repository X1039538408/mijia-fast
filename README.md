# mijia-fast

## 中文

`mijia-fast` 是一个运行在 Windows 上的米家自动化管理工具，为 [Oh My Sage](https://github.com/allocnode/oh-my-sage) 提供精简的 CLI 和 MCP 适配层。

它把设备查询、规则读取、Graph 校验、dry-run、快照、回读验证和失败回滚封装成短命令。日常自动化仍由米家极客版网关本地执行，模型不参与运行时控制。

### 功能

- CLI：设备清单、规则查询、规则校验、补丁、备份和恢复。
- Windows Named Pipe 常驻 daemon：复用一次登录会话，不开放新的局域网端口。
- 精简 MCP：默认提供 `mi_connect`、`mi_search`、`mi_get`、`mi_patch`、`mi_sync` 五个高层工具。
- Graph 连线检查和写入后回读验证。
- 主卧卫生间离开规则补丁：灯光和换气使用独立延时，并在关闭前重新确认无人。

### 环境要求

- Windows 10 或更高版本。
- Node.js 20 或更高版本。
- 已安装且可执行的 `oh-my-sage-mcp`。
- 可访问兼容的米家自动化极客版网关。

本项目调用 Oh My Sage MCP，不重新实现米家网关协议。

### 安装和配置

```powershell
npm install
$env:MIJIA_BACKEND_COMMAND = 'C:\path\to\oh-my-sage-mcp.cmd'
```

编辑 `config/mijia.json`，把示例网关地址、设备 ID、服务 ID、属性 ID 和规则名称替换成你自己的配置。登录码只通过当前进程的环境变量或命令行参数提供，不会保存到配置、快照或日志。

```powershell
$env:MIJIA_PASSCODE = '<六位登录码>'
node .\src\cli.mjs inventory
node .\src\cli.mjs rules list
```

也可以启动常驻会话：

```powershell
node .\src\cli.mjs daemon start --passcode <六位登录码>
node .\src\cli.mjs daemon status
node .\src\cli.mjs daemon stop
```

### 主卧卫生间防误关灯

专用命令会先检查其他启用中的关灯规则，然后执行 dry-run、规则级快照、写入、回读验证；验证失败时会尝试恢复原 Graph。

```powershell
node .\src\cli.mjs rule bathroom_leave_light_vent_off set-bathroom-delays --light 2m --vent 5m --dry-run
node .\src\cli.mjs rule bathroom_leave_light_vent_off set-bathroom-delays --light 2m --vent 5m
```

### MCP 配置

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

旧的底层工具只建议排错时通过 `MIJIA_EXPOSE_LEGACY_TOOLS=1` 开启。

### 开发和安全

```powershell
npm run check
npm test
```

`.data/` 可能包含设备和规则元数据，已加入 `.gitignore`，不要提交到公开仓库。请使用自己的 `config/mijia.json`，不要把家庭设备清单、完整规则 Graph、快照、登录码或网关凭据提交到 GitHub。

## English

`mijia-fast` is a Windows CLI and MCP adapter for [Oh My Sage](https://github.com/allocnode/oh-my-sage). It provides compact commands for device inventory, rule inspection, Graph validation, dry-runs, snapshots, verified writes, and rollback.

Automation continues to run locally in the MiJia gateway. The project invokes the Oh My Sage MCP process instead of reimplementing the gateway protocol.

### Features

- CLI for inventory, rules, validation, patches, backups, and restore.
- Windows Named Pipe daemon with an in-memory login session.
- Five compact MCP tools: `mi_connect`, `mi_search`, `mi_get`, `mi_patch`, and `mi_sync`.
- Graph edge validation and read-back verification.
- A bathroom leave-rule patch with separate light and ventilation delays and occupancy rechecks.

### Requirements

- Windows 10 or later.
- Node.js 20 or later.
- A working `oh-my-sage-mcp` command.
- Access to a compatible local MiJia automation gateway.

### Install and configure

```powershell
npm install
$env:MIJIA_BACKEND_COMMAND = 'C:\path\to\oh-my-sage-mcp.cmd'
$env:MIJIA_PASSCODE = '<six-digit-code>'
node .\src\cli.mjs inventory
```

Edit `config/mijia.json` and replace the example gateway URL, device IDs, service IDs, property IDs, and rule names. The login code is accepted only through the current process environment or command line and is not written to configuration, snapshots, or logs.

### Bathroom patch

```powershell
node .\src\cli.mjs rule bathroom_leave_light_vent_off set-bathroom-delays --light 2m --vent 5m --dry-run
node .\src\cli.mjs rule bathroom_leave_light_vent_off set-bathroom-delays --light 2m --vent 5m
```

The command checks for competing enabled light-off rules, creates a rule-scoped snapshot, writes the Graph, reads it back, and attempts rollback if verification fails.

### Development and security

```powershell
npm run check
npm test
```

`.data/` may contain device and rule metadata and is ignored by Git. Do not commit private device inventories, complete rule Graphs, snapshots, login codes, or gateway credentials.

## License

MIT
