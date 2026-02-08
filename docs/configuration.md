# Configuration

## Environment Variables

All configuration is done through environment variables. Pass them in your MCP client config's `env` field.

| Variable | Description | Default |
|---|---|---|
| `OPENCODE_BASE_URL` | URL of the OpenCode headless server | `http://127.0.0.1:4096` |
| `OPENCODE_SERVER_USERNAME` | HTTP basic auth username | `opencode` |
| `OPENCODE_SERVER_PASSWORD` | HTTP basic auth password | *(empty — auth disabled when not set)* |

### Notes

- **Auth is disabled by default.** It only activates when `OPENCODE_SERVER_PASSWORD` is set on both the OpenCode server and the MCP server.
- **The default username is `opencode`**, matching the OpenCode server's default. You only need to set `OPENCODE_SERVER_USERNAME` if you changed it on the server side.
- **The base URL** should point to where `opencode serve` is listening. If running on the same machine with default settings, you don't need to set this.

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

### opencode

**Config file:** `opencode.json` in your project root

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

### With authentication

Add `env` to any config above:

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

## OpenCode Server Setup

The MCP server connects to a running OpenCode headless server. Start it in your project directory:

```bash
# Default (no auth, port 4096)
opencode serve

# Custom port
opencode serve --port 8080

# With authentication
OPENCODE_SERVER_USERNAME=myuser OPENCODE_SERVER_PASSWORD=mypass opencode serve
```

The server exposes an OpenAPI 3.1 spec at `http://<host>:<port>/doc`.
