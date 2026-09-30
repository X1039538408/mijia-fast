# mijia-fast

`mijia-fast` is a small Windows CLI and MCP adapter for [Oh My Sage](https://github.com/allocnode/oh-my-sage). It keeps the conversational interface compact while leaving device automation in the local MiJia gateway.

The project provides:

- a CLI for inventory, rule inspection, dry-runs, patches, backups, and restore;
- a local daemon using a Windows Named Pipe;
- a compact MCP server with five high-level tools;
- structural Graph validation and read-back verification;
- a bathroom leave rule patch with separate light and ventilation delays and occupancy rechecks.

## Requirements

- Windows 10 or later;
- Node.js 20 or later;
- an installed and working `oh-my-sage-mcp` command;
- access to a compatible local MiJia automation gateway.

The project invokes the Oh My Sage MCP process and does not implement the gateway protocol itself.

## Install and configure

```powershell
npm install
$env:MIJIA_BACKEND_COMMAND = 'C:\path\to\oh-my-sage-mcp.cmd'
```

Copy `config/mijia.json` and replace the example gateway URL, device IDs, service IDs, property IDs, and rule names with your own values. Do not commit private device inventories, rule Graphs, backups, login codes, or gateway credentials.

Supply the login code to one process only:

```powershell
$env:MIJIA_PASSCODE = '<six-digit-code>'
node .\src\cli.mjs inventory
node .\src\cli.mjs rules list
```

Or use the resident session:

```powershell
node .\src\cli.mjs daemon start --passcode <six-digit-code>
node .\src\cli.mjs daemon status
node .\src\cli.mjs daemon stop
```

## Fast bathroom patch

```powershell
node .\src\cli.mjs rule bathroom_leave_light_vent_off set-bathroom-delays --light 2m --vent 5m --dry-run
node .\src\cli.mjs rule bathroom_leave_light_vent_off set-bathroom-delays --light 2m --vent 5m
```

The patch checks for another enabled rule that turns off the configured bathroom light. It creates a rule-scoped snapshot before writing, reads the Graph back, and attempts rollback when verification fails.

## MCP

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

The default tools are `mi_connect`, `mi_search`, `mi_get`, `mi_patch`, and `mi_sync`. Legacy low-level tools can be enabled with `MIJIA_EXPOSE_LEGACY_TOOLS=1`.

## Development

```powershell
npm run check
npm test
```

## Security

Keep `.data/` outside version control. It may contain device and rule metadata. The project intentionally does not persist the login code.

## License

MIT
