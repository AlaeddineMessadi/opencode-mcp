# Getting Started

Set up opencode-mcp in under 2 minutes.

## Prerequisites

- **Node.js** >= 18 ([download](https://nodejs.org/))
- **OpenCode** installed ([opencode.ai](https://opencode.ai/))
  - `curl -fsSL https://opencode.ai/install | bash`
  - or `npm i -g opencode-ai`
  - or `brew install sst/tap/opencode`
- An **MCP-compatible client** (Claude Desktop, Claude Code, Cursor, Windsurf, etc.)

## Step 1: Add to Your Client

**Claude Code:**

```bash
claude mcp add opencode -- npx -y opencode-mcp
```

**Claude Desktop / Cursor / Windsurf / Cline / Continue** — add to your MCP config file:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "npx",
      "args": ["-y", "opencode-mcp"]
    }
  }
}
```

See [Configuration](configuration.md) for all client configs (VS Code Copilot, Zed, Amazon Q, OpenCode itself, etc.).

## Step 2: Restart Your Client

Restart your MCP client after editing the config. That's it.

The MCP server **automatically starts** the OpenCode server (`opencode serve`) if it's not already running. No manual server management needed.

## Step 3: Verify

Ask your client to run a tool:

- *"Use opencode_setup to check server status"*
- *"Use opencode_context to get project info"*
- *"Use opencode_ask to explain this project"*

If it returns data from OpenCode, everything is working.

## What's Available

You now have access to **78 tools**, **10 resources**, and **6 prompts**. Start with these:

| Tool | What it does |
|---|---|
| `opencode_setup` | Check server health and provider config |
| `opencode_ask` | Ask OpenCode a question (one call, one answer) |
| `opencode_run` | Send a coding task and wait for it to finish |
| `opencode_fire` | Dispatch a task in the background |
| `opencode_check` | Check progress on a background task |
| `opencode_context` | Get project info, VCS status, agents |

See the full [Tools Reference](tools.md) and [Examples](examples.md).

## Troubleshooting

### "Connection refused" errors

The OpenCode server is not running and auto-start failed. Try starting it manually:

```bash
opencode serve
```

If auto-start keeps failing, check that `opencode` is on your PATH:

```bash
which opencode
```

### "Unauthorized" errors

The OpenCode server has auth enabled. Add credentials:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "npx",
      "args": ["-y", "opencode-mcp"],
      "env": {
        "OPENCODE_SERVER_USERNAME": "myuser",
        "OPENCODE_SERVER_PASSWORD": "mypass"
      }
    }
  }
}
```

### Tools not showing up

- Restart the client after editing the config
- Check that `npx opencode-mcp` runs without errors in a terminal
- Make sure your MCP client supports tools

### Disable auto-start

If you prefer to manage the OpenCode server yourself:

```json
{
  "env": {
    "OPENCODE_AUTO_SERVE": "false"
  }
}
```

## Next Steps

- [Configuration](configuration.md) — all env vars and client configs
- [Tools Reference](tools.md) — all 78 tools
- [Examples](examples.md) — real workflow examples
- [Prompts](prompts.md) — 6 guided workflow templates
