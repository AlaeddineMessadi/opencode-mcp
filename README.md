# opencode-mcp

[![npm version](https://img.shields.io/npm/v/opencode-mcp)](https://www.npmjs.com/package/opencode-mcp)
[![license](https://img.shields.io/github/license/AlaeddineMessadi/opencode-mcp)](https://github.com/AlaeddineMessadi/opencode-mcp/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/opencode-mcp)](https://nodejs.org/)
[![npm downloads](https://img.shields.io/npm/dm/opencode-mcp)](https://www.npmjs.com/package/opencode-mcp)

**Give any MCP client the power of [OpenCode](https://opencode.ai/).**

opencode-mcp is an MCP server that bridges your AI tools (Claude, Cursor, Windsurf, VS Code, etc.) to OpenCode's headless API. It lets your AI delegate real coding work — building features, debugging, refactoring, running tests — to OpenCode sessions that autonomously read, write, and execute code in your project.

**79 tools** | **10 resources** | **6 prompts** | **Multi-project** | **Auto-start**

## Why Use This?

- **Delegate coding tasks** — Tell Claude "build me a REST API" and it delegates to OpenCode, which creates files, installs packages, writes tests, and reports back.
- **Parallel work** — Fire off multiple tasks to OpenCode while your primary AI keeps working on something else.
- **Any MCP client** — Works with Claude Desktop, Claude Code, Cursor, Windsurf, VS Code Copilot, Cline, Continue, Zed, Amazon Q, and any other MCP-compatible tool.
- **Zero setup** — The server auto-starts `opencode serve` if it's not already running. No manual steps.

## Quick Start

> **Prerequisite:** [OpenCode](https://opencode.ai/) must be installed.
> `curl -fsSL https://opencode.ai/install | bash` or `npm i -g opencode-ai` or `brew install sst/tap/opencode`

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
(Claude, Cursor, etc.)   (this package)            (opencode serve)
```

Your MCP client calls tools over stdio. This server translates them into HTTP requests to the OpenCode headless API. If the OpenCode server isn't running, it's started automatically.

## Key Tools

The 79 tools are organized into tiers. Start with the workflow tools — they handle the common patterns in a single call.

### Workflow Tools (13) — Start Here

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
| [Project](docs/tools.md#project-tools) | 2 | List and inspect projects |
| [Events](docs/tools.md#event-tools) | 1 | Poll real-time SSE events |

### Resources (10)

Browseable data endpoints — your client can read these without tool calls:

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

## Environment Variables

All optional. Only needed if you've changed defaults on the OpenCode server.

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_BASE_URL` | `http://127.0.0.1:4096` | OpenCode server URL |
| `OPENCODE_SERVER_USERNAME` | `opencode` | HTTP basic auth username |
| `OPENCODE_SERVER_PASSWORD` | *(none)* | HTTP basic auth password (enables auth when set) |
| `OPENCODE_AUTO_SERVE` | `true` | Auto-start `opencode serve` if not running |
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
npm test         # 316 tests
```

### Smoke Testing

End-to-end test against a running OpenCode server:

```bash
npm run build && node scripts/mcp-smoke-test.mjs
```

## Documentation

- [Getting Started](docs/getting-started.md) — step-by-step setup
- [Configuration](docs/configuration.md) — env vars and all client configs
- [Tools Reference](docs/tools.md) — all 79 tools in detail
- [Resources](docs/resources.md) — 10 MCP resources
- [Prompts](docs/prompts.md) — 6 guided workflow templates
- [Examples](docs/examples.md) — real workflow examples
- [Architecture](docs/architecture.md) — system design and data flow

## References

- [OpenCode](https://opencode.ai/) | [OpenCode Docs](https://opencode.ai/docs/) | [OpenCode Server API](https://opencode.ai/docs/server/)
- [Model Context Protocol](https://modelcontextprotocol.io/)

## License

[MIT](LICENSE)
