# opencode-mcp

[![npm version](https://img.shields.io/npm/v/opencode-mcp)](https://www.npmjs.com/package/opencode-mcp)
[![license](https://img.shields.io/github/license/AlaeddineMessadi/opencode-mcp)](https://github.com/AlaeddineMessadi/opencode-mcp/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/opencode-mcp)](https://nodejs.org/)
[![npm downloads](https://img.shields.io/npm/dm/opencode-mcp)](https://www.npmjs.com/package/opencode-mcp)

An [MCP](https://modelcontextprotocol.io/) server that gives any MCP-compatible client full access to a running [OpenCode](https://opencode.ai/) instance. Manage sessions, send prompts, search files, review diffs, configure providers, control the TUI, and more.

**71 tools** | **10 resources** | **5 prompts** | **Multi-project support**

## Quick Start

### 1. Start an OpenCode server

```bash
opencode serve
```

### 2. Add to your MCP client

Pick your client below. No authentication is needed by default — just add the config and restart your client.

**Claude Desktop** (`claude_desktop_config.json`):

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

**Claude Code:**

```bash
claude mcp add opencode -- npx -y opencode-mcp
```

**Cursor** (`.cursor/mcp.json`):

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

**Windsurf** (`~/.windsurf/mcp.json`):

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

**VS Code — GitHub Copilot** (`settings.json`):

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

**Cline** (VS Code extension settings):

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

**Continue** (`.continue/config.json`):

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

**Zed** (`settings.json`):

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

**Amazon Q** (VS Code `settings.json`):

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

That's it. Your MCP client now has access to the entire OpenCode API.

### Custom server URL or authentication (optional)

By default, the MCP server connects to `http://127.0.0.1:4096` with no authentication. Both username and password are **optional** — auth is only needed if you've enabled it on the OpenCode server side.

If the OpenCode server is on a different host/port or has auth enabled, pass environment variables:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "npx",
      "args": ["-y", "opencode-mcp"],
      "env": {
        "OPENCODE_BASE_URL": "http://192.168.1.10:4096",
        "OPENCODE_SERVER_USERNAME": "myuser",
        "OPENCODE_SERVER_PASSWORD": "mypass"
      }
    }
  }
}
```

## What Can It Do?

### Workflow Tools (start here)

High-level tools designed to be the easiest way for an LLM to interact with OpenCode:

| Tool | What it does |
|---|---|
| `opencode_setup` | Check server health, provider config, and project status — use as first step |
| `opencode_ask` | Create session + send prompt + get answer in one call |
| `opencode_reply` | Follow-up message in an existing session |
| `opencode_conversation` | Formatted conversation history |
| `opencode_sessions_overview` | Quick overview of all sessions |
| `opencode_context` | Project + path + VCS + config + agents in one call |
| `opencode_wait` | Poll an async session until it finishes |
| `opencode_review_changes` | Formatted diff summary for a session |

### Session Tools (18)

Create, list, get, delete, update, fork, share, abort, revert sessions. Get diffs, todos, summaries, child sessions, and respond to permission requests.

### Message Tools (6)

Send prompts (sync or async), list/get messages, execute slash commands, run shell commands.

### File & Search Tools (6)

Search text/regex across the project, find files by name, find workspace symbols, list directories, read files, check VCS file status.

### Config & Provider Tools (8)

Get/update config, list providers and models, manage auth (API keys, OAuth).

### TUI Control Tools (9)

Remote-control the OpenCode TUI: append/submit/clear prompts, execute commands, show toasts, open dialogs (help, sessions, models, themes).

### System & Monitoring Tools (13)

Health checks, VCS info, LSP/formatter status, MCP server management, agent/command listing, logging, SSE event polling.

### Resources (10)

Browseable data endpoints:

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

### Prompts (5)

Guided workflow templates:

| Prompt | Description |
|---|---|
| `opencode-code-review` | Structured code review from session diffs |
| `opencode-debug` | Guided debugging workflow |
| `opencode-project-setup` | Get oriented in a new project |
| `opencode-implement` | Have OpenCode implement a feature |
| `opencode-session-summary` | Summarize a session |

## Environment Variables

All environment variables are **optional**. You only need to set them if you've changed the defaults on the OpenCode server side.

| Variable | Description | Default | Required |
|---|---|---|---|
| `OPENCODE_BASE_URL` | URL of the OpenCode server | `http://127.0.0.1:4096` | No |
| `OPENCODE_SERVER_USERNAME` | HTTP basic auth username | `opencode` | No |
| `OPENCODE_SERVER_PASSWORD` | HTTP basic auth password | *(none — auth disabled)* | No |

> **Note:** Authentication is disabled by default. It only activates when `OPENCODE_SERVER_PASSWORD` is set on both the OpenCode server and the MCP server.

## How It Works

```
MCP Client  <--stdio-->  opencode-mcp  <--HTTP-->  OpenCode Server
(Claude, Cursor, etc.)   (this package)            (opencode serve)
```

The MCP server communicates over **stdio** using the Model Context Protocol. When a client invokes a tool, the server translates it into HTTP calls against the OpenCode headless API. The OpenCode server must be running separately (`opencode serve`).

## Working with Multiple Projects

Every tool accepts an optional `directory` parameter that targets a specific project directory. This lets you work on multiple projects from a single OpenCode server without restarting anything.

```
# First-time setup: check server status and configure providers
opencode_setup()

# Set an API key (one-time, global — shared across all projects)
opencode_auth_set({ providerId: "anthropic", type: "api", key: "sk-ant-..." })

# Work on a mobile app
opencode_ask({
  directory: "/home/user/projects/mobile-app",
  prompt: "Set up navigation with React Navigation"
})

# Switch to a web app — same server, different directory
opencode_ask({
  directory: "/home/user/projects/web-app",
  prompt: "Add authentication to the Next.js app"
})

# Go back to the mobile app — no restart needed
opencode_reply({
  directory: "/home/user/projects/mobile-app",
  sessionId: "sess_abc123",
  prompt: "Now add a login screen"
})
```

When `directory` is omitted, the OpenCode server uses its own working directory (where `opencode serve` was started).

**How it works internally:** The `directory` parameter is sent as the `x-opencode-directory` HTTP header. The OpenCode server lazily initializes a separate instance per directory (with its own LSP, VCS, MCP servers, sessions, etc.) and caches them in memory.

## Architecture

```
src/
  index.ts              Entry point — wires everything together
  client.ts             HTTP client with retry, SSE, error categorization
  helpers.ts            Smart response formatting for LLM-friendly output
  resources.ts          MCP Resources (10 browseable data endpoints)
  prompts.ts            MCP Prompts (5 guided workflow templates)
  tools/
    workflow.ts         High-level workflow tools (8)
    session.ts          Session management tools (18)
    message.ts          Message/prompt tools (6)
    file.ts             File and search tools (6)
    tui.ts              TUI remote control tools (9)
    config.ts           Config tools (3)
    provider.ts         Provider/auth tools (5)
    misc.ts             System, agents, LSP, MCP, logging tools (13)
    events.ts           SSE event polling (1)
    global.ts           Health check (1)
    project.ts          Project tools (2)
```

## Development

```bash
git clone https://github.com/AlaeddineMessadi/opencode-mcp.git
cd opencode-mcp
npm install
npm run build    # compiles TypeScript and sets executable permissions
npm start        # runs the MCP server
npm run dev      # watch mode
```

## Documentation

- [Getting Started](docs/getting-started.md) — step-by-step setup guide
- [Configuration](docs/configuration.md) — all env vars and MCP client configs
- [Tools Reference](docs/tools.md) — detailed reference for all 71 tools
- [Resources Reference](docs/resources.md) — all 10 MCP resources
- [Prompts Reference](docs/prompts.md) — all 5 MCP prompts
- [Usage Examples](docs/examples.md) — real workflow examples
- [Architecture](docs/architecture.md) — system design and data flow

## Compatible MCP Clients

Works with any MCP-compatible client, including:

- [Claude Desktop](https://claude.ai/download)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [Cursor](https://cursor.sh/)
- [Windsurf](https://codeium.com/windsurf)
- [VS Code (GitHub Copilot)](https://code.visualstudio.com/)
- [Cline](https://github.com/cline/cline)
- [Continue](https://continue.dev/)
- [Zed](https://zed.dev/)
- [Amazon Q](https://aws.amazon.com/q/developer/)

## References

- [OpenCode Documentation](https://opencode.ai/docs/)
- [OpenCode Server API](https://opencode.ai/docs/server/)
- [OpenCode SDK](https://opencode.ai/docs/sdk/)
- [Model Context Protocol](https://modelcontextprotocol.io/)

## License

[MIT](LICENSE)
