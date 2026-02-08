# Architecture

## Overview

opencode-mcp is a **stdio-based MCP server** that acts as a bridge between MCP clients and the OpenCode headless HTTP server.

```
┌─────────────┐     stdio      ┌───────────────┐     HTTP      ┌──────────────────┐
│  MCP Client  │ ◄────────────► │  opencode-mcp  │ ◄──────────► │  OpenCode Server │
│  (Claude,    │   JSON-RPC     │  (this project) │   REST API   │  (opencode serve)│
│   Cursor)    │                │                 │              │                  │
└─────────────┘                └───────────────┘              └──────────────────┘
```

## Project Structure

```
src/
├── index.ts              Main entry point — creates server, registers everything
├── client.ts             HTTP client with retry, SSE, error categorization
├── helpers.ts            Response formatting for LLM-friendly output
├── resources.ts          MCP Resources (10 browseable data endpoints)
├── prompts.ts            MCP Prompts (5 guided workflow templates)
└── tools/
    ├── workflow.ts       High-level workflow tools (7) — start here
    ├── session.ts        Session lifecycle management (18)
    ├── message.ts        Message/prompt operations (6)
    ├── file.ts           File and search operations (6)
    ├── tui.ts            TUI remote control (9)
    ├── config.ts         Configuration management (3)
    ├── provider.ts       Provider and authentication (5)
    ├── misc.ts           System, agents, LSP, MCP, logging (13)
    ├── events.ts         SSE event polling (1)
    ├── global.ts         Health check (1)
    └── project.ts        Project operations (2)
```

## Key Design Decisions

### 1. Layered Tool Architecture

Tools are organized in two layers:

- **Low-level tools** — 1:1 mapping to OpenCode API endpoints. Every API endpoint has a corresponding tool.
- **High-level workflow tools** — Composite operations that combine multiple API calls. These are what LLMs should reach for first.

The workflow tools (`opencode_ask`, `opencode_reply`, `opencode_context`, etc.) drastically reduce the number of tool calls an LLM needs. Instead of "create session → send message → parse response", it's just `opencode_ask`.

### 2. Smart Response Formatting

Raw OpenCode API responses are deeply nested JSON with message parts, tool invocations, metadata, etc. The `helpers.ts` module transforms these into human-readable text:

- **Message parts** → extracted text content, tool call summaries
- **Diffs** → formatted with file paths, add/delete counts
- **Session lists** → bullet-point format with titles and IDs
- **Large responses** → auto-truncated at 50K characters

This reduces token usage and makes it easier for LLMs to reason about the data.

### 3. Robust HTTP Client

The `OpenCodeClient` class handles:

- **Automatic retry** — Exponential backoff for HTTP 429 (rate limit), 502, 503, 504
- **Error categorization** — `OpenCodeError` with `.isTransient`, `.isNotFound`, `.isAuth` properties
- **204 No Content** — Properly handled across all HTTP methods
- **Request timeouts** — Configurable per-request via `AbortController`
- **SSE streaming** — Async generator for Server-Sent Events

### 4. Three MCP Primitives

The server uses all three MCP primitives:

| Primitive | Count | Purpose |
|---|---|---|
| **Tools** | 70 | Actions the LLM can take |
| **Resources** | 10 | Data the LLM can browse |
| **Prompts** | 5 | Guided multi-step workflows |

### 5. Registration Pattern

Each tool group is a separate file exporting a `register*` function that receives `(server, client)`. This keeps files focused and makes it easy to add new tool groups without touching the main entry point.

## Data Flow

### Tool Call Flow

```
1. MCP Client sends JSON-RPC tool call request via stdio
2. McpServer dispatches to registered tool handler
3. Tool handler builds HTTP request parameters
4. OpenCodeClient makes HTTP call to OpenCode server
5. Response is formatted by helpers.ts
6. Formatted text is returned as MCP tool result
7. McpServer sends JSON-RPC response via stdio
```

### Resource Read Flow

```
1. MCP Client requests resource by URI
2. McpServer dispatches to registered resource handler
3. Handler fetches data from OpenCode via HTTP
4. Data is returned as resource content (JSON or text)
```

### SSE Event Flow (opencode_events_poll)

```
1. Tool handler opens SSE connection to /event
2. Events are collected for the specified duration
3. Connection is closed after timeout or max events
4. Collected events are formatted and returned as tool result
```
