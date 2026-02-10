# Resources Reference

MCP Resources are browseable data endpoints that clients can read without calling tools. All return `application/json`.

## Available Resources (10)

| URI | Description |
|---|---|
| `opencode://project/current` | Current active project (name, path, config) |
| `opencode://config` | Full OpenCode configuration |
| `opencode://providers` | All providers, models, and connection status |
| `opencode://agents` | Available agents with names, modes, descriptions |
| `opencode://commands` | All slash commands (built-in and custom) |
| `opencode://health` | Server health and version (`{ "healthy": true, "version": "x.y.z" }`) |
| `opencode://vcs` | Git info: branch, remote, commit, dirty status |
| `opencode://sessions` | All sessions with IDs, titles, dates, parent relationships |
| `opencode://mcp-servers` | Status of all configured MCP servers in OpenCode |
| `opencode://file-status` | VCS status of tracked files (modified, added, deleted) |

## How Resources Differ from Tools

- **Resources** are read-only data endpoints. Clients can browse and subscribe to them.
- **Tools** are actions that can read data, create sessions, modify files, etc.

For example, `opencode://providers` gives you provider data passively. To actually set an API key, you'd use the `opencode_auth_set` tool.
