# Tools Reference

Complete reference for all 78 tools provided by opencode-mcp.

Every tool accepts an optional `directory` parameter (absolute path) to target a specific project. All tools include [MCP tool annotations](https://modelcontextprotocol.io/docs/concepts/tools#tool-annotations) (`readOnlyHint`, `destructiveHint`) so clients can make informed decisions about tool safety.

## Table of Contents

- [Workflow Tools (13)](#workflow-tools) — start here
- [Session Tools (19)](#session-tools)
- [Message Tools (6)](#message-tools)
- [File & Search Tools (6)](#file--search-tools)
- [Config Tools (3)](#config-tools)
- [Provider & Auth Tools (6)](#provider--auth-tools)
- [TUI Control Tools (9)](#tui-control-tools)
- [System & Monitoring Tools (12)](#system--monitoring-tools)
- [Event Tools (1)](#event-tools)
- [Project Tools (2)](#project-tools)
- [Global Tools (1)](#global-tools)

---

## Workflow Tools

High-level tools that combine multiple API calls into single, LLM-friendly operations. **Start here** — these cover most use cases.

### `opencode_setup`

Check server health, provider config, and project status. **Use this as your first call.**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `directory` | string | no | Target project directory |

---

### `opencode_ask`

One-shot interaction — creates a session, sends a prompt, returns the AI response.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | yes | The question or instruction |
| `title` | string | no | Session title |
| `providerID` | string | no | Provider (e.g. `"anthropic"`) |
| `modelID` | string | no | Model (e.g. `"claude-opus-4-6"`) |
| `agent` | string | no | Agent (e.g. `"build"`, `"plan"`) |
| `system` | string | no | System prompt override |

---

### `opencode_reply`

Follow-up message in an existing session.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | yes | Session ID |
| `prompt` | string | yes | The follow-up message |
| `providerID` | string | no | Provider ID |
| `modelID` | string | no | Model ID |
| `agent` | string | no | Agent to use |

---

### `opencode_run`

**Send a task and wait for completion.** Combines session creation, async prompt dispatch, and polling into one call. Best for tasks you want to wait on (up to 10 minutes by default).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | yes | The task or instruction |
| `sessionId` | string | no | Existing session to continue (omit to create new) |
| `title` | string | no | Session title (new sessions only) |
| `providerID` | string | no | Provider ID |
| `modelID` | string | no | Model ID |
| `agent` | string | no | Agent to use |
| `maxDurationSeconds` | number | no | Max wait time (default: 600 = 10 min) |

---

### `opencode_fire`

**Fire-and-forget** — dispatch a task and return immediately. OpenCode works autonomously in the background. Use `opencode_check` to monitor progress.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | yes | The task or instruction |
| `sessionId` | string | no | Existing session to continue (omit to create new) |
| `title` | string | no | Session title (new sessions only) |
| `providerID` | string | no | Provider ID |
| `modelID` | string | no | Model ID |
| `agent` | string | no | Agent to use |

Returns: session ID + monitoring instructions.

---

### `opencode_check`

**Compact progress report** for a running session. Returns status, todo progress (completed/total + current task), and file change count. Much cheaper than `opencode_conversation` or `opencode_wait`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | yes | Session ID to check |
| `detailed` | boolean | no | Include last message text (default: false) |

---

### `opencode_conversation`

Full conversation history of a session, formatted for reading.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | yes | Session ID |
| `limit` | number | no | Max messages to return |

---

### `opencode_sessions_overview`

Quick overview of all sessions with titles, IDs, and status.

*No parameters.*

---

### `opencode_context`

Full project context in one call: project info, path, VCS, config, agents.

*No parameters (accepts optional `directory`).*

---

### `opencode_wait`

Poll a session until it finishes. Use after `opencode_message_send_async`. On timeout, returns actionable suggestions.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | yes | Session ID |
| `timeoutSeconds` | number | no | Max wait (default: 120) |
| `pollIntervalMs` | number | no | Poll interval in ms (default: 2000) |

> **Prefer `opencode_run`** for new tasks — it handles session creation + async send + polling in one call.

---

### `opencode_review_changes`

Formatted diff summary of file changes in a session.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | yes | Session ID |
| `messageID` | string | no | Specific message ID |

---

### `opencode_provider_test`

Quick-test whether a provider works. Creates a temporary session, sends a trivial prompt, checks the response, cleans up.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `providerId` | string | yes | Provider ID to test |
| `modelID` | string | no | Model ID (defaults to provider default) |

---

### `opencode_status`

At-a-glance dashboard: health, provider count, session count, VCS info.

*No parameters (accepts optional `directory`).*

---

## Session Tools

Full lifecycle management of OpenCode sessions (19 tools).

| Tool | Key Parameters | Description |
|---|---|---|
| `opencode_session_list` | — | List all sessions |
| `opencode_session_create` | `title?`, `parentID?` | Create a new session |
| `opencode_session_get` | `id` | Get session details |
| `opencode_session_delete` | `id` | Delete a session |
| `opencode_session_update` | `id`, `title?` | Update session properties |
| `opencode_session_search` | `query` | Search sessions by keyword |
| `opencode_session_children` | `id` | Get child sessions |
| `opencode_session_status` | — | Status for all sessions |
| `opencode_session_todo` | `id` | Get the todo list |
| `opencode_session_init` | `id`, `messageID`, `providerID`, `modelID` | Create AGENTS.md (slow) |
| `opencode_session_abort` | `id` | Abort a running session |
| `opencode_session_fork` | `id`, `messageID?` | Fork a session |
| `opencode_session_share` | `id` | Share publicly |
| `opencode_session_unshare` | `id` | Unshare |
| `opencode_session_diff` | `id`, `messageID?` | Get raw diff |
| `opencode_session_summarize` | `id`, `providerID`, `modelID` | AI-summarize (slow) |
| `opencode_session_revert` | `id`, `messageID`, `partID?` | Revert a message |
| `opencode_session_unrevert` | `id` | Restore reverted messages |
| `opencode_session_permission` | `id`, `permissionID`, `response`, `remember?` | Respond to permission request |

---

## Message Tools

Send prompts and execute commands (6 tools).

| Tool | Key Parameters | Description |
|---|---|---|
| `opencode_message_list` | `sessionId`, `limit?` | List messages in a session |
| `opencode_message_get` | `sessionId`, `messageId` | Get a specific message |
| `opencode_message_send` | `sessionId`, `text`, `providerID?`, `modelID?` | Send prompt (sync, waits for response) |
| `opencode_message_send_async` | `sessionId`, `text`, `providerID?`, `modelID?` | Send prompt (async, returns immediately) |
| `opencode_command_execute` | `sessionId`, `command`, `arguments?` | Execute a slash command |
| `opencode_shell_execute` | `sessionId`, `command`, `agent` | Run a shell command |

---

## File & Search Tools

Search and read project files (6 tools).

| Tool | Key Parameters | Description |
|---|---|---|
| `opencode_find_text` | `pattern` | Search text/regex across the project |
| `opencode_find_file` | `query`, `type?`, `limit?` | Find files by name (fuzzy) |
| `opencode_find_symbol` | `query` | Find workspace symbols (functions, classes, etc.) |
| `opencode_file_list` | `path?` | List directory contents |
| `opencode_file_read` | `path` | Read a file |
| `opencode_file_status` | — | VCS status for all tracked files |

---

## Config Tools

Read and update OpenCode configuration (3 tools).

| Tool | Key Parameters | Description |
|---|---|---|
| `opencode_config_get` | — | Get current config |
| `opencode_config_update` | `config` | Update config (partial merge) |
| `opencode_config_providers` | — | List configured providers and default models |

---

## Provider & Auth Tools

Manage LLM providers and authentication (6 tools).

| Tool | Key Parameters | Description |
|---|---|---|
| `opencode_provider_list` | — | List providers with connection status |
| `opencode_provider_models` | `providerId`, `limit?` | List models for a provider |
| `opencode_provider_auth_methods` | — | Get available auth methods |
| `opencode_provider_oauth_authorize` | `providerId` | Start OAuth flow |
| `opencode_provider_oauth_callback` | `providerId`, `callbackData` | Handle OAuth callback |
| `opencode_auth_set` | `providerId`, `type`, `key` | Set API key |

---

## TUI Control Tools

Remote-control the OpenCode terminal UI (9 tools).

| Tool | Key Parameters | Description |
|---|---|---|
| `opencode_tui_append_prompt` | `text` | Append text to prompt input |
| `opencode_tui_submit_prompt` | — | Submit the current prompt |
| `opencode_tui_clear_prompt` | — | Clear the prompt |
| `opencode_tui_execute_command` | `command` | Execute a slash command |
| `opencode_tui_show_toast` | `message`, `title?`, `variant?` | Show toast notification |
| `opencode_tui_open_help` | — | Open help dialog |
| `opencode_tui_open_sessions` | — | Open session selector |
| `opencode_tui_open_models` | — | Open model selector |
| `opencode_tui_open_themes` | — | Open theme selector |

---

## System & Monitoring Tools

Server health, VCS, LSP, and infrastructure tools (12 tools).

| Tool | Key Parameters | Description |
|---|---|---|
| `opencode_health` | — | Server health and version |
| `opencode_path_get` | — | Current working path |
| `opencode_vcs_info` | — | Git branch, remote, status |
| `opencode_instance_dispose` | — | Shut down the instance (destructive) |
| `opencode_agent_list` | — | List agents with descriptions |
| `opencode_command_list` | — | List all slash commands |
| `opencode_lsp_status` | — | LSP server status |
| `opencode_formatter_status` | — | Formatter status |
| `opencode_mcp_status` | — | MCP server status |
| `opencode_mcp_add` | `name`, `config` | Add MCP server dynamically |
| `opencode_tool_ids` | — | List tool IDs (experimental) |
| `opencode_tool_list` | `provider`, `model` | List tools with JSON schemas |

---

## Event Tools

### `opencode_events_poll`

Poll for real-time SSE events from the server.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `durationMs` | number | no | Collection duration (default: 3000, max: 30000) |
| `maxEvents` | number | no | Max events (default: 50) |

---

## Project Tools

| Tool | Key Parameters | Description |
|---|---|---|
| `opencode_project_list` | — | List all known projects |
| `opencode_project_current` | — | Get the current active project |

---

## Global Tools

| Tool | Key Parameters | Description |
|---|---|---|
| `opencode_log` | `service`, `level`, `message`, `extra?` | Write a log entry |
