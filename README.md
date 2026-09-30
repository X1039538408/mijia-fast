# mijia-fast

## 中文

`mijia-fast` 是一个运行在 Windows 上的米家自动化管理工具，为 [Oh My Sage](https://github.com/allocnode/oh-my-sage) 提供简洁的 CLI 和 MCP 接口。

它把连接、查看、修改和备份规则这些常用操作集中到一起。自动化仍然由米家极客版网关在本地运行，不需要模型一直在线。

### 主要功能

- 查看设备和自动化规则。
- 修改前先预览，写入前自动备份，写入后重新确认结果。
- 出现问题时查看历史记录、比较备份并恢复规则。
- 支持命令行和 MCP 两种使用方式。

### 环境要求

- Windows 10 或更高版本。
- Node.js 20 或更高版本。
- 已安装且可执行的 `oh-my-sage-mcp`。
- 当前电脑可以访问米家自动化极客版网关。

本项目调用 Oh My Sage MCP，不重新实现米家网关协议。

### 快速开始

```powershell
git clone https://github.com/X1039538408/mijia-fast.git
cd mijia-fast
npm install
$env:MIJIA_BACKEND_COMMAND = 'C:\path\to\oh-my-sage-mcp.cmd'
```

第一次使用时，运行下面的命令连接网关，并生成本机配置：

```powershell
node .\src\cli.mjs setup --passcode <六位登录码>
node .\src\cli.mjs status
node .\src\cli.mjs doctor
```

`setup` 会读取当前设备和规则，并把配置保存到 `.data/local-config.json`。登录码只在当前进程中使用，不会写入配置、备份、操作记录或计划任务命令行。

如果不使用向导，也可以手动编辑 `config/mijia.json`，或通过 `MIJIA_CONFIG_PATH` 指定本地配置文件。

### 日常命令

```powershell
# 查看设备和规则
node .\src\cli.mjs inventory
node .\src\cli.mjs rules list
node .\src\cli.mjs rules get --name "卧室全局无人关闭灯光"
node .\src\cli.mjs rules explain --name "卧室全局无人关闭灯光"
node .\src\cli.mjs rules lint --name "卧室全局无人关闭灯光"

# 先预览修改，不会写入网关
node .\src\cli.mjs rule bedroom_all_empty_off set-delay 10s --dry-run

# 确认后写入，自动备份并检查结果
node .\src\cli.mjs rule bedroom_all_empty_off set-delay 10s --apply

# 主卧卫生间灯和换气延时
node .\src\cli.mjs rule bathroom_leave_light_vent_off set-bathroom-delays --light 2m --vent 5m --dry-run
node .\src\cli.mjs rule bathroom_leave_light_vent_off set-bathroom-delays --light 2m --vent 5m --apply
```

在终端中默认显示简洁摘要；脚本和 MCP 场景可以使用 `--json` 获取 JSON：

```powershell
node .\src\cli.mjs rules list --json
node .\src\cli.mjs status --json
```

原有的 `rule <别名> set-delay|enable|disable` 写法仍然可用。非交互环境必须明确使用 `--apply` 或 `--yes` 才会写入。

### 后台会话

```powershell
node .\src\cli.mjs daemon start --passcode <六位登录码>
node .\src\cli.mjs daemon status
node .\src\cli.mjs daemon restart --passcode <六位登录码>
node .\src\cli.mjs daemon stop
```

后台服务会复用登录会话，并且只接受本机请求，不会额外开放局域网端口。也可以设置为登录 Windows 时自动启动：

```powershell
node .\src\cli.mjs daemon install
node .\src\cli.mjs daemon uninstall
```

计划任务不会保存登录码。要自动连接，需要由用户自行配置用户级 `MIJIA_PASSCODE`；如果不希望保存登录码，请继续手动启动后台服务。

### 备份和恢复

```powershell
node .\src\cli.mjs backup create
node .\src\cli.mjs backup list
node .\src\cli.mjs backup show --id <快照编号>
node .\src\cli.mjs backup diff --id <快照编号>
node .\src\cli.mjs backup restore --id <快照编号> --dry-run
node .\src\cli.mjs backup restore --id <快照编号> --apply
node .\src\cli.mjs history
```

每次修改前都会先创建备份。如果修改结果不符合预期，工具会尝试恢复原设置。`.data/` 中保存缓存、备份、操作记录和本地配置。

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

通过 MCP 修改规则时，工具会先返回变更预览；确认后才会备份并写入。复杂的底层数据默认不会返回给模型。

### 隐私说明

不要提交以下内容：

- `.data/` 目录。
- 真实设备 ID、规则 ID、完整 Graph 和快照。
- 米家登录码、网关凭据和个人网络地址。
- 包含家庭房间布局的调试输出。

公开仓库只保留示例配置和示例计划。提交前请运行：

```powershell
npm run check
npm test
```

### 项目定位

这是一个面向个人家庭局域网的 Windows 工具，不是公网多用户服务，也不会直接暴露米家网关端口。日常自动化在网关本地运行，不消耗模型 token。

## English

`mijia-fast` is a Windows CLI and MCP interface for [Oh My Sage](https://github.com/allocnode/oh-my-sage).

It brings common connection, rule management, backup, and recovery tasks into one place. Automations continue to run locally in the MiJia gateway.

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

`setup` discovers devices and rules and stores the local configuration in `.data/local-config.json`. The passcode is kept in memory only and is not written to config, backups, operation history, or scheduled-task arguments.

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

Terminals show concise summaries by default. Add `--json` for scripts and integrations. Non-interactive writes require explicit `--apply` or `--yes`.

### Daemon and MCP

The background service reuses one login session, accepts local requests only, and does not open a LAN TCP port. `mi_patch` shows a preview before writing.

Legacy low-level tools remain available only when `MIJIA_EXPOSE_LEGACY_TOOLS=1` is set.

### Privacy

Do not commit `.data/`, real device or rule IDs, private backups, login codes, gateway credentials, or room-layout diagnostics. The public repository contains only example configuration and plans.

### Development

```powershell
npm run check
npm test
```

## License

MIT
