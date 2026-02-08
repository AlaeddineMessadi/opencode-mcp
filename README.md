# opencode-mcp

A full-featured [MCP](https://modelcontextprotocol.io/) (Model Context Protocol) server that wraps the [OpenCode AI](https://opencode.ai/) headless HTTP server API.

This lets any MCP-compatible client (Claude Desktop, Claude Code, Cursor, Windsurf, etc.) interact with a running OpenCode instance — manage sessions, send prompts, search files, review diffs, configure providers, and more.

## Features

- **70 tools** covering the entire OpenCode server API surface
- **7 high-level workflow tools** — `opencode_ask`, `opencode_reply`, `opencode_context`, etc.
- **10 MCP resources** — browseable project data (config, sessions, providers, agents, VCS, etc.)
- **5 MCP prompts** — guided workflow templates (code review, debugging, implementation, etc.)
- **Smart response formatting** — extracts meaningful text from message parts instead of dumping raw JSON
- **SSE event polling** — monitor real-time server events
- **TUI remote control** — 9 tools to drive the OpenCode TUI programmatically
- **Robust HTTP client** — automatic retry with exponential backoff, error categorization, timeout support

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- A running [OpenCode](https://opencode.ai/) instance (`opencode serve` or the TUI)

### Install

```bash
git clone https://github.com/AlaeddineMessadi/opencode-mcp.git
cd opencode-mcp
npm install
npm run build
```

### Run

```bash
# Start OpenCode server first
opencode serve

# Then run the MCP server
node dist/index.js
```

### Configure in your MCP client

Add to your MCP client config (e.g. `claude_desktop_config.json`, `opencode.json`, `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "opencode": {
      "command": "node",
      "args": ["/path/to/opencode-mcp/dist/index.js"],
      "env": {
        "OPENCODE_BASE_URL": "http://127.0.0.1:4096"
      }
    }
  }
}
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `OPENCODE_BASE_URL` | URL of the OpenCode server | `http://127.0.0.1:4096` |
| `OPENCODE_SERVER_USERNAME` | HTTP basic auth username | `opencode` |
| `OPENCODE_SERVER_PASSWORD` | HTTP basic auth password | *(none — auth disabled)* |

## Tools Reference

### Workflow Tools (start here)

These high-level tools are the easiest way for an LLM to interact with OpenCode:

| Tool | Description |
|---|---|
| `opencode_ask` | One-shot: create session + send prompt + get answer in one call |
| `opencode_reply` | Send a follow-up message to an existing session |
| `opencode_conversation` | Get formatted conversation history of a session |
| `opencode_sessions_overview` | Quick overview of all sessions with status |
| `opencode_context` | Get project + path + VCS + config + agents in one call |
| `opencode_wait` | Poll an async session until it finishes |
| `opencode_review_changes` | Formatted diff summary for a session |

### Session Tools

| Tool | Description |
|---|---|
| `opencode_session_list` | List all sessions |
| `opencode_session_create` | Create a new session |
| `opencode_session_get` | Get session details |
| `opencode_session_delete` | Delete a session |
| `opencode_session_update` | Update session title |
| `opencode_session_children` | Get child sessions |
| `opencode_session_status` | Get status for all sessions |
| `opencode_session_todo` | Get todo list for a session |
| `opencode_session_init` | Analyze app and create AGENTS.md |
| `opencode_session_abort` | Abort a running session |
| `opencode_session_fork` | Fork a session at a message |
| `opencode_session_share` | Share a session publicly |
| `opencode_session_unshare` | Unshare a session |
| `opencode_session_diff` | Get file diffs for a session |
| `opencode_session_summarize` | Summarize a session |
| `opencode_session_revert` | Revert a message |
| `opencode_session_unrevert` | Restore reverted messages |
| `opencode_session_permission` | Respond to a permission request |

### Message Tools

| Tool | Description |
|---|---|
| `opencode_message_list` | List messages in a session |
| `opencode_message_get` | Get message details |
| `opencode_message_send` | Send a prompt and wait for response |
| `opencode_message_send_async` | Send a prompt without waiting |
| `opencode_command_execute` | Execute a slash command |
| `opencode_shell_execute` | Run a shell command |

### File & Search Tools

| Tool | Description |
|---|---|
| `opencode_find_text` | Search for text/regex in project files |
| `opencode_find_file` | Find files by name (fuzzy) |
| `opencode_find_symbol` | Find workspace symbols |
| `opencode_file_list` | List files and directories |
| `opencode_file_read` | Read a file's content |
| `opencode_file_status` | Get VCS status for tracked files |

### Config & Provider Tools

| Tool | Description |
|---|---|
| `opencode_config_get` | Get current configuration |
| `opencode_config_update` | Update configuration |
| `opencode_config_providers` | List configured providers |
| `opencode_provider_list` | List all providers and models |
| `opencode_provider_auth_methods` | Get auth methods for providers |
| `opencode_provider_oauth_authorize` | Start OAuth flow |
| `opencode_provider_oauth_callback` | Handle OAuth callback |
| `opencode_auth_set` | Set API key for a provider |

### TUI Control Tools

| Tool | Description |
|---|---|
| `opencode_tui_append_prompt` | Append text to TUI prompt |
| `opencode_tui_submit_prompt` | Submit the current prompt |
| `opencode_tui_clear_prompt` | Clear the prompt |
| `opencode_tui_execute_command` | Execute a slash command |
| `opencode_tui_show_toast` | Show a toast notification |
| `opencode_tui_open_help` | Open help dialog |
| `opencode_tui_open_sessions` | Open session selector |
| `opencode_tui_open_models` | Open model selector |
| `opencode_tui_open_themes` | Open theme selector |

### System & Monitoring Tools

| Tool | Description |
|---|---|
| `opencode_health` | Check server health and version |
| `opencode_path_get` | Get current working path |
| `opencode_vcs_info` | Get VCS (Git) info |
| `opencode_instance_dispose` | Shut down the instance |
| `opencode_agent_list` | List available agents |
| `opencode_command_list` | List available commands |
| `opencode_lsp_status` | Get LSP server status |
| `opencode_formatter_status` | Get formatter status |
| `opencode_mcp_status` | Get MCP server status |
| `opencode_mcp_add` | Add an MCP server dynamically |
| `opencode_tool_ids` | List tool IDs (experimental) |
| `opencode_tool_list` | List tools with schemas (experimental) |
| `opencode_log` | Write a log entry |
| `opencode_events_poll` | Poll for real-time events |

## Resources

MCP resources are browseable data endpoints that clients can discover:

| URI | Description |
|---|---|
| `opencode://project/current` | Current active project |
| `opencode://config` | Current configuration |
| `opencode://providers` | All providers with models |
| `opencode://agents` | Available agents |
| `opencode://commands` | Available commands |
| `opencode://health` | Server health and version |
| `opencode://vcs` | Version control info |
| `opencode://sessions` | All sessions |
| `opencode://mcp-servers` | MCP server status |
| `opencode://file-status` | VCS file status |

## Prompts

Pre-built prompt templates for guided workflows:

| Prompt | Description | Arguments |
|---|---|---|
| `opencode-code-review` | Structured code review from session diffs | `sessionId` |
| `opencode-debug` | Guided debugging workflow | `issue`, `context?` |
| `opencode-project-setup` | Get oriented in a new project | *(none)* |
| `opencode-implement` | Have OpenCode implement a feature | `description`, `requirements?` |
| `opencode-session-summary` | Summarize a session | `sessionId` |

## Architecture

```
src/
  index.ts              Entry point — wires everything together
  client.ts             HTTP client with retry, SSE, error categorization
  helpers.ts            Smart response formatting for LLM-friendly output
  resources.ts          MCP Resources (10 browseable data endpoints)
  prompts.ts            MCP Prompts (5 guided workflow templates)
  tools/
    workflow.ts         High-level workflow tools (7)
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
# Watch mode
npm run dev

# Build
npm run build

# Run
npm start
```

## How It Works

The MCP server communicates over **stdio** using the Model Context Protocol. When an MCP client (like Claude Desktop) invokes a tool, the server translates it into HTTP calls against the OpenCode server API.

```
MCP Client  <--stdio-->  opencode-mcp  <--HTTP-->  OpenCode Server
(Claude)                  (this project)            (opencode serve)
```

The OpenCode server exposes an [OpenAPI 3.1 spec](https://opencode.ai/docs/server/) at `http://<host>:<port>/doc`. This MCP server wraps that entire API surface.

## References

- [OpenCode Documentation](https://opencode.ai/docs/)
- [OpenCode Server API](https://opencode.ai/docs/server/)
- [OpenCode SDK](https://opencode.ai/docs/sdk/)
- [Model Context Protocol](https://modelcontextprotocol.io/)

## License

MIT
