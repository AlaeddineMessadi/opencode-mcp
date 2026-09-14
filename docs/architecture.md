# Architecture

## Overview

opencode-mcp is a **stdio-based MCP server** that bridges MCP clients to the OpenCode headless HTTP API.

```
┌─────────────┐     stdio      ┌───────────────┐     HTTP      ┌─────────────────────────┐
│  MCP Client  │ <────────────> │  opencode-mcp  │ <──────────> │  OpenCode Server        │
│  (Claude,    │   JSON-RPC     │  (this package) │   REST API   │  (SDK child process,   │
│   Cursor)    │                │                 │              │   or external `opencode │
│              │                │                 │              │   serve` you launched)  │
└─────────────┘                └───────────────┘              └─────────────────────────┘
```

## Project Structure

```
src/
├── index.ts              Main entry point: creates server, registers everything
├── server-manager.ts     Probe server + opt-in child-process start via SDK
├── client.ts             HTTP client with retry, SSE, error categorization
├── helpers.ts            Response formatting + tool annotation constants
├── resources.ts          MCP Resources (10 browseable data endpoints)
├── prompts.ts            MCP Prompts (6 guided workflow templates)
└── tools/
    ├── workflow.ts       High-level workflow tools (13): start here
    ├── session.ts        Session lifecycle management (20)
    ├── message.ts        Message/prompt operations (6)
    ├── file.ts           File and search operations (6)
    ├── tui.ts            TUI remote control (9)
    ├── config.ts         Configuration management (3)
    ├── provider.ts       Provider and authentication (6)
    ├── misc.ts           System, agents, LSP, MCP, logging (12)
    ├── events.ts         SSE event polling (1)
    ├── global.ts         Health check (1)
    └── project.ts        Project operations (3): list, init, current
```

## Three MCP Primitives

| Primitive | Count | Purpose |
|---|---|---|
| **Tools** | 80 | Actions the LLM can take |
| **Resources** | 10 | Data the LLM can browse |
| **Prompts** | 6 | Guided multi-step workflows |

## Key Design Decisions

### Layered Tool Architecture

Tools are in two layers:

- **Low-level**: 1:1 mapping to OpenCode API endpoints (session, message, file, etc.)
- **Workflow**: Composite operations that combine multiple calls (`opencode_ask`, `opencode_run`, `opencode_fire`, etc.)

The workflow layer drastically reduces tool calls. Instead of "create session, send message, parse response", it's one `opencode_ask` call. For long-running tasks, `opencode_run` handles session creation + async dispatch + polling in one call. `opencode_fire` + `opencode_check` enables background work with lightweight monitoring.

### Tool Annotations

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`) so clients can make informed decisions about safety. Read-only tools like `opencode_check` and `opencode_context` are annotated as safe; destructive tools like `opencode_instance_dispose` are flagged.

### Smart Response Formatting

Raw API responses are deeply nested JSON. The `helpers.ts` module transforms these into human-readable text:

- Message parts -> extracted text, tool call summaries
- Diffs -> formatted with file paths, add/delete counts
- Session lists -> bullet-point format with titles and IDs
- Large responses -> auto-truncated at 50K characters

### Robust HTTP Client

`OpenCodeClient` handles:

- **Automatic retry**: Exponential backoff for 429, 502, 503, 504
- **Error categorization**: `OpenCodeError` with `.isTransient`, `.isNotFound`, `.isAuth`
- **204 No Content**: Properly handled
- **SSE streaming**: Async generator for Server-Sent Events
- **Directory validation**: Paths are normalized (resolved to absolute, trailing slashes removed) and validated (must exist on disk) before being sent as the `x-opencode-directory` header
- **Lazy reconnection**: If all retries fail due to connection errors (`ECONNREFUSED`, `ENOTFOUND`, etc.) and `autoServe` is enabled, the client attempts to restart the OpenCode server and retry once (up to 3 reconnection attempts per MCP session)

### Default Provider/Model

Tools that accept `providerID` and `modelID` apply a three-tier resolution:

1. **Explicit params**: If both are passed to the tool call, use them
2. **Env-var defaults**: If `OPENCODE_DEFAULT_PROVIDER` and `OPENCODE_DEFAULT_MODEL` are set, use them as fallback
3. **Server default**: If neither is available, let the OpenCode server decide (may result in empty responses if no provider is configured)

This is implemented via `applyModelDefaults()` in `helpers.ts`, called from all 8 tools that accept model params.

### Auto-Start

On startup, MCP probes `OPENCODE_BASE_URL/global/health` and attaches to an existing server. Startup is opt-in: `OPENCODE_AUTO_SERVE=true` allows `createOpencodeServer()` from the SDK to spawn the `opencode serve` executable as a child process. OpenCode must be on `PATH`; it binds its own HTTP port and inherits the process environment, including server authentication. Only loopback HTTP endpoints support automatic startup.

Shutdown handlers for stdin `end`/`close`, `SIGINT`, `SIGTERM`, `SIGHUP` and `exit` close the SDK-owned child. External servers remain running. The same opt-in setting controls reconnection attempts that may launch another server.

Concurrent `ensureServer()` calls are coalesced per `baseUrl` via an in-flight `Map<string, Promise>` so two simultaneous tool calls during cold-start can't race into `EADDRINUSE`. Calls targeting different baseUrls each get their own startup promise.

## Data Flow

### Tool Call

```
1. MCP Client sends JSON-RPC tool call via stdio
2. McpServer dispatches to registered handler
3. Handler builds HTTP request
4. OpenCodeClient makes HTTP call to OpenCode
5. Response formatted by helpers.ts
6. Formatted text returned as MCP tool result
7. McpServer sends JSON-RPC response via stdio
```

### Resource Read

```
1. Client requests resource by URI (e.g. opencode://health)
2. Handler fetches from OpenCode via HTTP
3. Data returned as resource content (JSON)
```

### SSE Events

```
1. opencode_events_poll opens SSE connection to /event
2. Events collected for specified duration
3. Connection closed, events formatted and returned
```

## Registration Pattern

Each tool group is a file exporting a `register*` function that receives `(server, client)`. New tool groups can be added without touching the entry point.

### Permission Handling

In headless mode, OpenCode may pause sessions waiting for tool-use permissions (e.g. file writes, shell commands). This blocks progress silently. The MCP server addresses this with:

- **`opencode_permission_list`**: Lists all pending permission requests across sessions so the LLM can detect and unblock stuck sessions
- **`opencode_session_permission`**: Replies to a specific permission request with `once`, `always`, or `reject`
- **Recommended config**: Set `"permission": "allow"` in `opencode.json` or call `opencode_config_update({ config: { permission: "allow" } })` at runtime to auto-approve all tool use in headless mode
