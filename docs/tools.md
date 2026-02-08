# Tools Reference

Complete reference for all 70 tools provided by opencode-mcp.

## Table of Contents

- [Workflow Tools](#workflow-tools)
- [Session Tools](#session-tools)
- [Message Tools](#message-tools)
- [File & Search Tools](#file--search-tools)
- [Config Tools](#config-tools)
- [Provider & Auth Tools](#provider--auth-tools)
- [TUI Control Tools](#tui-control-tools)
- [System & Monitoring Tools](#system--monitoring-tools)
- [Event Tools](#event-tools)

---

## Workflow Tools

High-level tools that combine multiple API calls into single, LLM-friendly operations.

### `opencode_ask`

**One-shot interaction** — Creates a session, sends a prompt, and returns the AI response.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | yes | The question or instruction |
| `title` | string | no | Session title (defaults to first 80 chars of prompt) |
| `providerID` | string | no | Provider (e.g. `"anthropic"`) |
| `modelID` | string | no | Model (e.g. `"claude-3-5-sonnet-20241022"`) |
| `agent` | string | no | Agent to use (e.g. `"build"`, `"plan"`) |
| `system` | string | no | System prompt override |

**Example use case**: "Ask OpenCode to explain this codebase" — one tool call, one answer.

---

### `opencode_reply`

Send a **follow-up message** to an existing session.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | yes | Session ID to reply in |
| `prompt` | string | yes | The follow-up message |
| `providerID` | string | no | Provider ID |
| `modelID` | string | no | Model ID |
| `agent` | string | no | Agent to use |

---

### `opencode_conversation`

Get the **full conversation history** of a session, formatted for easy reading.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | yes | Session ID |
| `limit` | number | no | Max messages to return |

---

### `opencode_sessions_overview`

Get a **quick overview** of all sessions with titles, IDs, and status.

*No parameters.*

---

### `opencode_context`

Get **full project context** in one call: project info, path, VCS, config, and available agents.

*No parameters.*

**Example output:**
```
## Project
{ "name": "my-app", "path": "/home/user/my-app", ... }

## VCS (Git)
{ "branch": "main", "remote": "origin", ... }

## Agents (4)
- build [primary]: Full development agent
- plan [primary]: Analysis and planning
- general [subagent]: Multi-step tasks
- explore [subagent]: Read-only codebase exploration
```

---

### `opencode_wait`

**Poll a session** until it finishes processing. Use after `opencode_message_send_async`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | yes | Session ID to wait on |
| `timeoutSeconds` | number | no | Max wait time (default: 120) |
| `pollIntervalMs` | number | no | Poll interval in ms (default: 2000) |

---

### `opencode_review_changes`

Get a **formatted diff summary** of file changes in a session.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | yes | Session ID |
| `messageID` | string | no | Specific message ID |

---

## Session Tools

Full lifecycle management of OpenCode sessions.

### `opencode_session_list`

List all sessions with titles and IDs.

### `opencode_session_create`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `parentID` | string | no | Parent session ID (for child sessions) |
| `title` | string | no | Session title |

### `opencode_session_get`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Session ID |

### `opencode_session_delete`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Session ID to delete |

### `opencode_session_update`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Session ID |
| `title` | string | no | New title |

### `opencode_session_children`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Parent session ID |

### `opencode_session_status`

Get status (`running`, `idle`, `completed`, `error`) for all sessions.

### `opencode_session_todo`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Session ID |

### `opencode_session_init`

Analyze the project and create `AGENTS.md`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Session ID |
| `messageID` | string | yes | Message ID |
| `providerID` | string | yes | Provider ID |
| `modelID` | string | yes | Model ID |

### `opencode_session_abort`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Session ID to abort |

### `opencode_session_fork`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Session ID to fork |
| `messageID` | string | no | Fork point (message ID) |

### `opencode_session_share` / `opencode_session_unshare`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Session ID |

### `opencode_session_diff`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Session ID |
| `messageID` | string | no | Specific message |

### `opencode_session_summarize`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Session ID |
| `providerID` | string | yes | Provider ID |
| `modelID` | string | yes | Model ID |

### `opencode_session_revert`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Session ID |
| `messageID` | string | yes | Message ID to revert |
| `partID` | string | no | Specific part ID |

### `opencode_session_unrevert`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Session ID |

### `opencode_session_permission`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Session ID |
| `permissionID` | string | yes | Permission request ID |
| `response` | string | yes | Response string |
| `remember` | boolean | no | Remember this decision |

---

## Message Tools

### `opencode_message_list`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | yes | Session ID |
| `limit` | number | no | Max messages |

### `opencode_message_get`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | yes | Session ID |
| `messageId` | string | yes | Message ID |

### `opencode_message_send`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | yes | Session ID |
| `text` | string | yes | Message text |
| `providerID` | string | no | Provider ID |
| `modelID` | string | no | Model ID |
| `agent` | string | no | Agent |
| `noReply` | boolean | no | If true, inject context only (no AI response) |
| `system` | string | no | System prompt override |

### `opencode_message_send_async`

Same as `opencode_message_send` but returns immediately. Use `opencode_wait` to poll.

### `opencode_command_execute`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | yes | Session ID |
| `command` | string | yes | Slash command (e.g. `"init"`) |
| `arguments` | string | no | Command arguments |
| `agent` | string | no | Agent |
| `providerID` | string | no | Provider ID |
| `modelID` | string | no | Model ID |

### `opencode_shell_execute`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | yes | Session ID |
| `command` | string | yes | Shell command |
| `agent` | string | yes | Agent |
| `providerID` | string | no | Provider ID |
| `modelID` | string | no | Model ID |

---

## File & Search Tools

### `opencode_find_text`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pattern` | string | yes | Text or regex pattern |

### `opencode_find_file`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Search string (fuzzy match) |
| `type` | `"file"` / `"directory"` | no | Filter by type |
| `directory` | string | no | Override project root |
| `limit` | number | no | Max results (1-200) |

### `opencode_find_symbol`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Symbol name |

### `opencode_file_list`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | no | Path to list (default: project root) |

### `opencode_file_read`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | File path to read |

### `opencode_file_status`

Get VCS status for all tracked files. No parameters.

---

## Config Tools

### `opencode_config_get`

Get current configuration. No parameters.

### `opencode_config_update`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `config` | object | yes | Partial config to merge |

### `opencode_config_providers`

List configured providers and default models. No parameters.

---

## Provider & Auth Tools

### `opencode_provider_list`

List all providers, models, and connection status. No parameters.

### `opencode_provider_auth_methods`

Get available auth methods per provider. No parameters.

### `opencode_provider_oauth_authorize`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `providerId` | string | yes | Provider ID |

### `opencode_provider_oauth_callback`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `providerId` | string | yes | Provider ID |
| `callbackData` | object | yes | OAuth callback payload |

### `opencode_auth_set`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `providerId` | string | yes | Provider ID (e.g. `"anthropic"`) |
| `type` | string | yes | Auth type (e.g. `"api"`) |
| `key` | string | yes | API key |

---

## TUI Control Tools

These tools drive the OpenCode TUI remotely. Useful for IDE integrations.

| Tool | Parameters | Description |
|---|---|---|
| `opencode_tui_append_prompt` | `text` | Append text to prompt |
| `opencode_tui_submit_prompt` | — | Submit current prompt |
| `opencode_tui_clear_prompt` | — | Clear the prompt |
| `opencode_tui_execute_command` | `command` | Execute a slash command |
| `opencode_tui_show_toast` | `message`, `title?`, `variant?` | Show toast |
| `opencode_tui_open_help` | — | Open help dialog |
| `opencode_tui_open_sessions` | — | Open session selector |
| `opencode_tui_open_models` | — | Open model selector |
| `opencode_tui_open_themes` | — | Open theme selector |

---

## System & Monitoring Tools

| Tool | Parameters | Description |
|---|---|---|
| `opencode_health` | — | Server health and version |
| `opencode_path_get` | — | Current working path |
| `opencode_vcs_info` | — | Git branch, remote, status |
| `opencode_instance_dispose` | — | Shut down the instance |
| `opencode_agent_list` | — | List agents with descriptions |
| `opencode_command_list` | — | List all slash commands |
| `opencode_lsp_status` | — | LSP server status |
| `opencode_formatter_status` | — | Formatter status |
| `opencode_mcp_status` | — | MCP server status |
| `opencode_mcp_add` | `name`, `config` | Add MCP server dynamically |
| `opencode_tool_ids` | — | List tool IDs (experimental) |
| `opencode_tool_list` | `provider`, `model` | List tools with schemas |
| `opencode_log` | `service`, `level`, `message`, `extra?` | Write log entry |

---

## Event Tools

### `opencode_events_poll`

Poll for real-time SSE events from the server.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `durationMs` | number | no | Collection duration (default: 3000, max: 30000) |
| `maxEvents` | number | no | Max events to collect (default: 50) |
