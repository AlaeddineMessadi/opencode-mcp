# Resources Reference

MCP Resources are browseable data endpoints that clients can discover and read without needing to call specific tools.

## Available Resources

### `opencode://project/current`

The currently active OpenCode project.

**MIME type:** `application/json`

Returns project metadata including name, path, and configuration.

---

### `opencode://config`

Current OpenCode configuration.

**MIME type:** `application/json`

Returns the full config object including model settings, provider configuration, and tool permissions.

---

### `opencode://providers`

All available LLM providers, their models, and connection status.

**MIME type:** `application/json`

Returns:
- `all` — Array of all providers with their models
- `default` — Default model per provider
- `connected` — List of connected provider IDs

---

### `opencode://agents`

All available agents and their configurations.

**MIME type:** `application/json`

Returns array of agents with:
- `name` / `id`
- `mode` — `"primary"`, `"subagent"`, or `"all"`
- `description`
- Tool and permission configuration

---

### `opencode://commands`

All available commands (built-in and custom slash commands).

**MIME type:** `application/json`

---

### `opencode://health`

OpenCode server health and version.

**MIME type:** `application/json`

Returns:
```json
{
  "healthy": true,
  "version": "x.y.z"
}
```

---

### `opencode://vcs`

Version control system info for the current project.

**MIME type:** `application/json`

Returns Git info: branch, remote, commit, dirty status, etc.

---

### `opencode://sessions`

All sessions.

**MIME type:** `application/json`

Returns array of session objects with IDs, titles, creation dates, and parent relationships.

---

### `opencode://mcp-servers`

Status of all configured MCP servers in OpenCode.

**MIME type:** `application/json`

Returns a map of server names to their status objects.

---

### `opencode://file-status`

VCS status of all tracked files (modified, added, deleted, etc.).

**MIME type:** `application/json`
