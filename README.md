# opencode-mcp

[![npm version](https://img.shields.io/npm/v/opencode-mcp)](https://www.npmjs.com/package/opencode-mcp)
[![license](https://img.shields.io/github/license/AlaeddineMessadi/opencode-mcp)](https://github.com/AlaeddineMessadi/opencode-mcp/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/opencode-mcp)](https://nodejs.org/)
[![npm downloads](https://img.shields.io/npm/dm/opencode-mcp)](https://www.npmjs.com/package/opencode-mcp)

**Give any MCP client the power of [OpenCode](https://opencode.ai/).**

opencode-mcp is an MCP server that bridges your AI tools (Claude, Cursor, Windsurf, VS Code, etc.) to OpenCode's headless API. It lets your AI delegate real coding work: building features, debugging, refactoring, running tests: to OpenCode sessions that autonomously read, write, and execute code in your project.

**80 tools** | **10 resources** | **6 prompts** | **Multi-project** | **Optional auto-start**

## Why Use This?

- **Delegate coding tasks**: Tell Claude "build me a REST API" and it delegates to OpenCode, which creates files, installs packages, writes tests, and reports back.
- **Parallel work**: Fire off multiple tasks to OpenCode while your primary AI keeps working on something else.
- **Any MCP client**: Works with Claude Desktop, Claude Code, Cursor, Windsurf, VS Code Copilot, Cline, Continue, Zed, Amazon Q, and any other MCP-compatible tool.
- **Explicit server control**: Connect to an existing OpenCode server or opt in to launching a local server with `OPENCODE_AUTO_SERVE=true`.

## Quick Start

> **Prerequisite:** [OpenCode](https://opencode.ai/) must be installed.
> `curl -fsSL https://opencode.ai/install | bash` or `npm i -g opencode-ai` or `brew install sst/tap/opencode`

Start a server first:

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

If you already use the TUI, start it with `opencode --port 4096` and connect MCP to that same server. For a different port, set `OPENCODE_BASE_URL`.

**Claude Code:**

```bash
claude mcp add opencode -- npx -y opencode-mcp
```

**Claude Desktop / Cursor / Windsurf / Cline / Continue** (add to your MCP config):

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

That's it. Restart your client and OpenCode's tools will be available.

> See [Configuration](docs/configuration.md) for all client configs (VS Code Copilot, Zed, Amazon Q, etc.) and environment variables.

## How It Works

```
MCP Client  <--stdio-->  opencode-mcp  <--HTTP-->  OpenCode Server
(Claude, Cursor, etc.)   (this package)            (existing TUI/serve server,
                                                    or SDK-managed child process)
```

Your MCP client calls tools over stdio. This server translates them into HTTP requests to the OpenCode headless API. By default it connects to the server at `OPENCODE_BASE_URL`. With `OPENCODE_AUTO_SERVE=true`, the official SDK can launch `opencode serve` as a child process on a local loopback address. The `directory` parameter on every tool routes that request to a specific project using the server-side directory scope, so a single MCP instance can fan out across many project roots.

## Key Tools

The 80 tools are organized into tiers. Start with the workflow tools: they handle the common patterns in a single call.

### Workflow Tools (13): Start Here

| Tool | What it does |
|---|---|
| `opencode_setup` | Check server health, providers, and project status. Use first. |
| `opencode_ask` | Create session + send prompt + get answer. One call. |
| `opencode_reply` | Follow-up message in an existing session |
| `opencode_run` | Send a task and wait for completion (session + async send + polling) |
| `opencode_fire` | Fire-and-forget: dispatch a task, return immediately |
| `opencode_check` | Compact progress report for a running session (status, todos, files changed) |
| `opencode_conversation` | Get formatted conversation history |
| `opencode_sessions_overview` | Quick overview of all sessions |
| `opencode_context` | Project + VCS + config + agents in one call |
| `opencode_review_changes` | Formatted diff summary for a session |
| `opencode_wait` | Poll an async session until it finishes |
| `opencode_provider_test` | Quick-test whether a provider is working |
| `opencode_status` | Health + providers + sessions + VCS dashboard |

### Recommended Patterns

**Quick question:**
```
opencode_ask({ prompt: "Explain the auth flow in this project" })
```

**Build something and wait:**
```
opencode_run({ prompt: "Add input validation to POST /api/users", maxDurationSeconds: 300 })
```

**Parallel background tasks:**
```
opencode_fire({ prompt: "Refactor the auth module to use JWT" })
→ returns sessionId immediately
opencode_check({ sessionId: "..." })
→ check progress anytime
```

### All Tool Categories

| Category | Count | Description |
|---|---|---|
| [Workflow](docs/tools.md#workflow-tools) | 13 | High-level composite operations |
| [Session](docs/tools.md#session-tools) | 20 | Create, list, fork, share, abort, revert, permissions |
| [Message](docs/tools.md#message-tools) | 6 | Send prompts, execute commands, run shell |
| [File & Search](docs/tools.md#file--search-tools) | 6 | Search text/regex, find files/symbols, read files |
| [System](docs/tools.md#system--monitoring-tools) | 13 | Health, VCS, LSP, MCP servers, agents, logging |
| [TUI Control](docs/tools.md#tui-control-tools) | 9 | Remote-control the OpenCode terminal UI |
| [Provider & Auth](docs/tools.md#provider--auth-tools) | 6 | List providers/models, set API keys, OAuth |
| [Config](docs/tools.md#config-tools) | 3 | Get/update configuration |
| [Project](docs/tools.md#project-tools) | 3 | List, inspect, and initialize projects |
| [Events](docs/tools.md#event-tools) | 1 | Poll real-time SSE events |

### Resources (10)

Browseable data endpoints: your client can read these without tool calls:

| URI | Description |
|---|---|
| `opencode://project/current` | Current active project |
| `opencode://config` | Current configuration |
| `opencode://providers` | Providers with models |
| `opencode://agents` | Available agents |
| `opencode://commands` | Available commands |
| `opencode://health` | Server health and version |
| `opencode://vcs` | Version control info |
| `opencode://sessions` | All sessions |
| `opencode://mcp-servers` | MCP server status |
| `opencode://file-status` | VCS file status |

### Prompts (6)

Guided workflow templates your client can offer as selectable actions:

| Prompt | Description |
|---|---|
| `opencode-code-review` | Review diffs from a session |
| `opencode-debug` | Step-by-step debugging workflow |
| `opencode-project-setup` | Get oriented in a new project |
| `opencode-implement` | Have OpenCode build a feature |
| `opencode-best-practices` | Setup, tool selection, monitoring, and pitfalls |
| `opencode-session-summary` | Summarize what happened in a session |

## Multi-Project Support

Every tool accepts an optional `directory` parameter to target a different project. No restarts needed.

```
opencode_ask({ directory: "/home/user/mobile-app", prompt: "Add navigation" })
opencode_ask({ directory: "/home/user/web-app", prompt: "Add auth" })
```

For local servers, use `opencode_project_init` to scaffold a new project directory (or open a preexisting one) before the first call, so the OpenCode server registers it as a project:

```
opencode_project_init({ path: "/home/user/new-project" })
// → "Successfully initialized project directory at: /home/user/new-project"

opencode_run({ directory: "/home/user/new-project", prompt: "Set up a Vite + React app" })
```

For remote servers, create the directory on the server yourself. `opencode_project_init` operates on the MCP host filesystem. Other tools accept absolute server paths, including Windows and WSL paths, without checking the MCP host's disk.

## Compatibility

The current development version uses `@opencode-ai/sdk` 1.18.31 and has been smoke-tested against OpenCode 1.18.31. Older versions have not been revalidated. When upgrading from 1.11.0, start a server explicitly or set `OPENCODE_AUTO_SERVE=true` to retain automatic startup. `OPENCODE_SERVE_ARGS` remains unsupported after the SDK migration; use a manually started server for custom CLI flags.

## Environment Variables

All optional. Only needed if you've changed defaults on the OpenCode server.

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_BASE_URL` | `http://127.0.0.1:4096` | OpenCode server URL |
| `OPENCODE_SERVER_USERNAME` | `opencode` | HTTP basic auth username |
| `OPENCODE_SERVER_PASSWORD` | *(none)* | HTTP basic auth password (enables auth when set) |
| `OPENCODE_AUTO_SERVE` | `false` | Opt in to starting a local `opencode serve` child process if the configured server is unavailable |
| `OPENCODE_DEFAULT_PROVIDER` | *(none)* | Default provider ID when not specified per-tool (e.g. `anthropic`) |
| `OPENCODE_DEFAULT_MODEL` | *(none)* | Default model ID when not specified per-tool (e.g. `claude-sonnet-4-5`) |

## Development

```bash
git clone https://github.com/AlaeddineMessadi/opencode-mcp.git
cd opencode-mcp
npm install
npm run build
npm start        # run the MCP server
npm run dev      # watch mode
npm test         # 328 tests
```

### Smoke Testing

End-to-end test against a running OpenCode server:

```bash
npm run build && node scripts/mcp-smoke-test.mjs
```

## Documentation

- [Getting Started](docs/getting-started.md): step-by-step setup
- [Configuration](docs/configuration.md): env vars and all client configs
- [Tools Reference](docs/tools.md): all 80 tools in detail
- [Resources](docs/resources.md): 10 MCP resources
- [Prompts](docs/prompts.md): 6 guided workflow templates
- [Examples](docs/examples.md): real workflow examples
- [Architecture](docs/architecture.md): system design and data flow

## References

- [OpenCode](https://opencode.ai/) | [OpenCode Docs](https://opencode.ai/docs/) | [OpenCode Server API](https://opencode.ai/docs/server/)
- [Model Context Protocol](https://modelcontextprotocol.io/)

## License

[MIT](LICENSE)
