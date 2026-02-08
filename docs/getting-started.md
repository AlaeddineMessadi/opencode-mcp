# Getting Started

This guide walks you through setting up `opencode-mcp` from scratch.

## Prerequisites

- **Node.js** >= 18 ([download](https://nodejs.org/))
- **OpenCode** installed ([opencode.ai](https://opencode.ai/))
- An **MCP-compatible client** — Claude Desktop, Claude Code, Cursor, Windsurf, or any MCP client

## Step 1: Start the OpenCode Server

In your project directory, start the OpenCode headless server:

```bash
opencode serve
```

By default this starts on `http://127.0.0.1:4096`. You can verify it's running:

```bash
curl http://127.0.0.1:4096/health
```

You should see a JSON response with version info.

### Optional: Enable authentication

If you want to secure the server:

```bash
OPENCODE_SERVER_USERNAME=myuser OPENCODE_SERVER_PASSWORD=mypass opencode serve
```

## Step 2: Add opencode-mcp to Your Client

Choose your MCP client below. In each case, add the configuration to the client's MCP config file.

### Claude Desktop

Edit `claude_desktop_config.json`:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

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

Restart Claude Desktop after editing.

### Claude Code

```bash
claude mcp add opencode -- npx -y opencode-mcp
```

### Cursor

Create or edit `.cursor/mcp.json` in your project root:

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

### Windsurf

Edit `~/.windsurf/mcp.json`:

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

### opencode itself

Add to `opencode.json` in your project root:

```json
{
  "mcp": {
    "opencode-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "opencode-mcp"]
    }
  }
}
```

## Step 3: Verify It Works

Once your client is configured and restarted, try using one of the workflow tools:

1. Ask your MCP client: *"Use opencode_context to get project info"*
2. Or: *"Use opencode_ask to ask OpenCode to explain this project"*

If the tool returns data from OpenCode, everything is working.

## Troubleshooting

### "Connection refused" errors

The OpenCode server is not running. Start it with `opencode serve`.

### "Unauthorized" errors

The OpenCode server has auth enabled but the MCP server doesn't have the credentials. Add env vars:

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

### Custom server URL

If the OpenCode server is on a different host or port:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "npx",
      "args": ["-y", "opencode-mcp"],
      "env": {
        "OPENCODE_BASE_URL": "http://192.168.1.10:4096"
      }
    }
  }
}
```

### Tools not showing up

- Make sure the MCP client supports tools (not all do)
- Restart the client after editing the config
- Check that `npx opencode-mcp` runs without errors when executed manually in a terminal

## Next Steps

- [Configuration](configuration.md) — all environment variables and advanced config
- [Tools Reference](tools.md) — detailed reference for all 70 tools
- [Usage Examples](examples.md) — real workflow examples
