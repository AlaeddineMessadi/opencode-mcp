# Configuration

## Environment Variables

All environment variables are **optional**. You only need to set them if you've changed the defaults on the OpenCode server side.

| Variable | Description | Default | Required |
|---|---|---|---|
| `OPENCODE_BASE_URL` | URL of the OpenCode headless server | `http://127.0.0.1:4096` | No |
| `OPENCODE_SERVER_USERNAME` | HTTP basic auth username | `opencode` | No |
| `OPENCODE_SERVER_PASSWORD` | HTTP basic auth password | *(none — auth disabled)* | No |
| `OPENCODE_AUTO_SERVE` | Auto-start `opencode serve` if not running | `true` | No |
| `OPENCODE_DEFAULT_PROVIDER` | Default provider ID when not specified per-tool | *(none)* | No |
| `OPENCODE_DEFAULT_MODEL` | Default model ID when not specified per-tool | *(none)* | No |

### Notes

- **Authentication is disabled by default.** It only activates when `OPENCODE_SERVER_PASSWORD` is set on both the OpenCode server and the MCP server.
- **Username and password are both optional.** The default username is `opencode`, matching the OpenCode server's default. You only need to set these if you've explicitly enabled auth on the server.
- **The base URL** should point to where `opencode serve` is listening. If running on the same machine with default settings, you don't need to set this.
- **Default provider/model** are optional. When set, tools that accept `providerID`/`modelID` will use these as fallbacks when not specified per-call. Both must be set together. Example: `OPENCODE_DEFAULT_PROVIDER=anthropic` + `OPENCODE_DEFAULT_MODEL=claude-sonnet-4-5`.
- **Directory validation** — The `directory` parameter on all tools must be an absolute path to an existing directory. Relative paths, non-existent paths, and trailing slashes are handled automatically (resolved or rejected with a helpful error).

## MCP Client Configurations

Below are complete configuration examples for every supported MCP client. All examples assume the OpenCode server is running on the default `http://127.0.0.1:4096` with no auth.

### Claude Desktop

**Config file location:**
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

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

### Claude Code (CLI)

```bash
# Add globally
claude mcp add opencode -- npx -y opencode-mcp

# Add with custom env
claude mcp add opencode --env OPENCODE_BASE_URL=http://192.168.1.10:4096 -- npx -y opencode-mcp

# Remove
claude mcp remove opencode
```

### Cursor

**Config file:** `.cursor/mcp.json` in your project root

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

**Config file:** `~/.windsurf/mcp.json`

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

### VS Code — GitHub Copilot

**Config file:** `.vscode/settings.json` or user `settings.json`

```json
{
  "github.copilot.chat.mcp.servers": [
    {
      "name": "opencode",
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "opencode-mcp"]
    }
  ]
}
```

### Cline (VS Code extension)

Cline manages MCP servers through its own settings UI. Add a new server with:

- **Command:** `npx`
- **Args:** `-y opencode-mcp`
- **Transport:** stdio

### Continue

**Config file:** `.continue/config.json` in your project root or `~/.continue/config.json` globally

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

### Zed

**Config file:** `~/.config/zed/settings.json` or project `settings.json`

```json
{
  "context_servers": {
    "opencode": {
      "command": {
        "path": "npx",
        "args": ["-y", "opencode-mcp"]
      }
    }
  }
}
```

### Amazon Q

**Config file:** VS Code `settings.json`

```json
{
  "amazon-q.mcp.servers": [
    {
      "name": "opencode",
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "opencode-mcp"]
    }
  ]
}
```

### With authentication (optional)

Add `env` to any config above. This is only needed if you've enabled auth on the OpenCode server:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "npx",
      "args": ["-y", "opencode-mcp"],
      "env": {
        "OPENCODE_BASE_URL": "http://127.0.0.1:4096",
        "OPENCODE_SERVER_USERNAME": "myuser",
        "OPENCODE_SERVER_PASSWORD": "mypass"
      }
    }
  }
}
```

### With global install (instead of npx)

If you prefer a global install for faster startup:

```bash
npm install -g opencode-mcp
```

Then use `opencode-mcp` directly in your config:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "opencode-mcp"
    }
  }
}
```

## Auto-Start

By default, the MCP server **automatically starts** `opencode serve` if it's not already running. To disable this:

```json
{
  "env": {
    "OPENCODE_AUTO_SERVE": "false"
  }
}
```

## Manual OpenCode Server Setup

If you prefer to manage the server yourself:

```bash
# Default (no auth, port 4096)
opencode serve

# Custom port
opencode serve --port 8080

# With authentication (optional)
OPENCODE_SERVER_USERNAME=myuser OPENCODE_SERVER_PASSWORD=mypass opencode serve
```

The server exposes an OpenAPI 3.1 spec at `http://<host>:<port>/doc`.
