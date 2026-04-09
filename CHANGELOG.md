# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.10.1] - 2026-04-10

### Changed

- Instruction examples now use discovered/default provider and model values instead of hardcoded Anthropic examples. This avoids steering MCP clients toward unavailable providers and aligns the startup guidance with `opencode_setup`.

### Fixed

- Health checks for authenticated OpenCode servers now propagate HTTP basic auth through the full auto-start path, including startup polling and reconnection flows.
- `ensureServer()` now forwards configured server credentials during startup so remote protected servers no longer fail the health probe while coming online.

### Stats

- Tool count: 79
- Tests: 320

## [1.10.0] - 2026-02-10

### Added

- **`opencode_permission_list` tool** — lists all pending permission requests across sessions, showing permission type, session ID, patterns, and tool name. Helps detect and unblock sessions stuck waiting for approval in headless mode.
- **`OPENCODE_DEFAULT_PROVIDER` / `OPENCODE_DEFAULT_MODEL` env vars** — set default provider and model for all tool calls. Three-tier resolution: explicit params → env defaults → server fallback. Implemented via `applyModelDefaults()` across all 8 model-accepting tools.
- **`normalizeDirectory()` path validation** — resolves paths to absolute, strips trailing slashes, resolves `..`, and rejects non-existent directories with descriptive errors.
- **Lazy server reconnection** — on `ECONNREFUSED`/`ENOTFOUND` after all retries, auto-restarts the OpenCode server (max 3 reconnection attempts per MCP session).
- **Enhanced `diagnoseError()`** — 6 new error patterns with contextual suggestions (empty response, model errors, permission issues, config problems).
- **Directory display in workflow responses** — `opencode_run`, `opencode_fire`, `opencode_check`, `opencode_status` now show the active project directory.
- **Session-directory consistency warnings** — warns when a session was created for a different directory than the current request.
- **Permissions guidance in instructions** — recommends `"permission": "allow"` in `opencode.json` for headless use, documents permission tools.

### Changed

- **`opencode_session_permission` updated** — now uses the new API (`POST /permission/{requestID}/reply`) with automatic fallback to the deprecated endpoint. `reply` parameter changed from free string to enum: `"once"` | `"always"` | `"reject"`. Removed the old `remember` parameter.

### Fixed

- **Directory validation errors swallowed by `.catch(() => null)`** — `opencode_status`, `opencode_context`, and `opencode_check` used `Promise.all` with `.catch(() => null)` which silently ate validation errors (showing "UNREACHABLE" instead of "directory not found"). Fixed by adding early `normalizeDirectory()` before `Promise.all` in all 3 tools.

### Removed

- Demo projects (`projects/snake-game/`, `projects/nextjs-todo-app/`) — these were test artifacts.

### Stats

- Tool count: 79 (up from 78)
- Tests: 316 (up from 275)

## [1.9.0] - 2026-02-10

### Added

- **`opencode_run` workflow tool** — one-call solution for complex tasks: creates a session, sends the prompt, polls until completion, and returns the result with todo progress. Supports `maxDurationSeconds` (default 10 min) and session reuse via `sessionId`.
- **`opencode_fire` workflow tool** — fire-and-forget: creates a session, dispatches the task, and returns immediately with the session ID and monitoring instructions. Best for long-running tasks where you want to do other work in parallel.
- **`opencode_check` workflow tool** — compact progress report for a session: status, todo progress (completed/total), current task, file change count. Much cheaper than `opencode_conversation`. Supports `detailed` mode for last message text.
- Tool count: 78 (up from 75)
- Tests: 275 (up from 267) — 8 new tests covering `opencode_run` (polling, error, session reuse), `opencode_fire` (dispatch, session reuse), and `opencode_check` (progress, completion, detailed mode)

### Changed

- Instructions updated with new Tier 2 tools (`opencode_run`, `opencode_fire`, `opencode_check`) and simplified recommended workflows
- Best-practices prompt updated with new tool selection table

## [1.8.0] - 2026-02-10

### Added

- **`instructions` field** — the MCP server now provides a comprehensive structured guide via the `instructions` option in the `McpServer` constructor. This helps LLM clients understand tool tiers (5 levels from essential to dangerous), recommended workflows, and the async `message_send_async` + `wait` pattern for long tasks.
- **Tool annotations** — all tools now carry MCP `readOnlyHint` / `destructiveHint` annotations so clients can auto-approve safe read-only operations and warn before destructive ones (e.g. `session_delete`, `instance_dispose`)
- **`opencode-best-practices` prompt** — new prompt template (6th prompt) covering setup, provider/model selection, tool selection table, prompt writing tips, monitoring, error recovery, and common pitfalls
- **Honest wake-up documentation** — `opencode_wait` description now explains that most MCP clients do NOT interrupt the LLM for log notifications, and suggests `opencode_session_todo` for monitoring very long tasks

### Changed

- `opencode_instance_dispose` description now includes a WARNING about permanent shutdown
- Prompts: 6 (up from 5)
- Tests: 267 (up from 266)

## [1.6.0] - 2026-02-09

### Fixed

- **Empty message display** — `formatMessageList()` no longer shows blank output for assistant messages that performed tool calls but had no text content. It now shows concise tool action summaries like `Agent performed 3 action(s): Write: /src/App.tsx, Bash: npm install`
- **Session status `[object Object]`** — `opencode_sessions_overview` and `opencode_session_status` now correctly resolve status objects (e.g. `{ state: "running" }`) to readable strings instead of displaying `[object Object]`
- **`opencode_wait` timeout message** — now includes actionable recovery suggestions (`opencode_conversation` to check progress, `opencode_session_abort` to stop) and correctly resolves object-shaped status values during polling
- **`toolError()` contextual suggestions** — common error patterns (401/403 auth, timeout, rate limit, connection refused, session not found) now include helpful follow-up tool suggestions instead of bare error text

### Added

- `resolveSessionStatus()` exported helper in `src/helpers.ts` — normalizes status from string, object (`{ state, status, type }`), or boolean flags into a readable string
- `summarizeToolInput()` helper — extracts the most useful arg (path, command, query, url) from tool input objects for compact display
- `extractCostMeta()` helper — extracts cost/token metadata from `step-finish` message parts
- `diagnoseError()` private helper — pattern-matches common errors and returns contextual suggestions
- 11 new tool handler tests for `opencode_sessions_overview`, `opencode_session_status`, and `opencode_wait` covering object status resolution, timeout messages, and edge cases
- Tests: 266 total (up from 255)

## [1.5.0] - 2026-02-09

### Added

- `opencode_status` workflow tool for a fast health/providers/sessions/VCS dashboard
- `opencode_provider_test` workflow tool to quickly validate a provider/model actually responds (creates a temp session, sends a tiny prompt, cleans up)
- `opencode_session_search` to find sessions by keyword in title (also matches session ID)
- `scripts/mcp-smoke-test.mjs` end-to-end smoke test runner (spawns opencode-mcp over stdio and exercises most tools/workflows against a running OpenCode server)

### Changed

- Provider configuration detection is now shared via `isProviderConfigured()` (used consistently across provider listing and setup workflows)
- Multiple tool outputs are more token-efficient and user-friendly (compact provider list/model listing, session formatting, and warning surfacing)
- Tool count: 75 (up from 72)
- Tests: 255 total

### Fixed

- `opencode_message_send` no longer silently returns empty output for empty responses; it now appends actionable warnings like `opencode_ask`/`opencode_reply`
- `opencode_session_share` / `opencode_session_unshare` now return formatted confirmations instead of raw JSON dumps
- `opencode_events_poll` no longer crashes on timeout when the SSE stream is idle (abort now cancels the stream safely)

## [1.4.0] - 2025-02-09

### Added

- **Auth error detection** — `opencode_ask` and `opencode_reply` now analyze AI responses for signs of failure (empty response, missing text content, error keywords like "unauthorized" or "invalid key") and append a clear `--- WARNING ---` with actionable guidance instead of silently returning nothing
- **`analyzeMessageResponse()` helper** — new diagnostic function in `src/helpers.ts` that detects empty, error, and auth-related response issues
- **Provider probing in `opencode_setup`** — connected providers are now verified with a lightweight "Reply with OK" probe to distinguish between WORKING, CONNECTED BUT NOT RESPONDING (bad API key), and could-not-verify states. Unconfigured providers now show available auth methods.
- **`opencode_provider_models` tool** — new tool to list models for a single provider, replacing the previous approach of dumping all providers and all models in one massive response
- **164 tests** (up from 140) — new tests for `analyzeMessageResponse`, auth warning in ask/reply, provider probe statuses, compact provider list, and per-provider model listing

### Changed

- **`opencode_provider_list` is now compact** — returns only provider names, connection status, and model count (not the full model list). This dramatically reduces token usage for MCP clients. Use `opencode_provider_models` with a provider ID to drill into a specific provider's models.
- Tool count: 72 (up from 71)

## [1.3.0] - 2025-02-08

### Added

- **Auto-serve** — the MCP server now automatically detects whether `opencode serve` is running and starts it as a child process if not. No more manual "start opencode serve" step before using the MCP server.
  - Checks the `/global/health` endpoint on startup
  - Finds the `opencode` binary via `which`/`where`
  - Spawns `opencode serve --port <port>` and polls until healthy
  - Graceful shutdown: kills the managed child process on SIGINT/SIGTERM/exit
  - Clear error messages with install instructions if the binary is not found
- **`OPENCODE_AUTO_SERVE` env var** — set to `"false"` to disable auto-start for users who prefer manual control
- **`src/server-manager.ts` module** — new module with `findBinary()`, `isServerRunning()`, `startServer()`, `stopServer()`, `ensureServer()`
- **140 tests** (up from 117) — 23 new tests for the server manager covering health checks, binary detection, auto-start, error cases, and shutdown

### Changed

- Startup flow in `src/index.ts` now calls `ensureServer()` before connecting the MCP transport
- Updated README: removed manual "start opencode serve" step, added auto-serve documentation, updated env vars table and architecture section

## [1.2.0] - 2025-02-08

### Added

- **Per-tool project directory targeting** — every tool now accepts an optional `directory` parameter that scopes the request to a specific project directory via the `x-opencode-directory` header. This enables working with multiple projects simultaneously from a single MCP connection without restarting the server.
- **`opencode_setup` workflow tool** — new high-level onboarding tool that checks server health, lists provider configuration status, and shows project info. Use it as the first step when starting work.
- **117 tests** (up from 102) — new tests for directory header propagation, `opencode_setup` handler, and `directoryParam` validation

### Changed

- `opencode_find_file` tool: renamed the search-root override parameter from `directory` to `searchDirectory` to avoid collision with the new project-scoping `directory` parameter
- Auth tools (`opencode_auth_set`, `opencode_provider_oauth_authorize`, `opencode_provider_oauth_callback`) do not accept `directory` — auth credentials are global, not project-scoped

## [1.1.0] - 2025-02-08

### Added

- **Test suite** — 102 tests across 5 test files using Vitest
  - `helpers.test.ts` — 35 tests for all formatting and response helper functions
  - `client.test.ts` — 37 tests for HTTP client, error handling, retry logic, auth
  - `tools.test.ts` — 16 tests for tool registration and handler behavior
  - `resources.test.ts` — 7 tests for MCP resource registration and handlers
  - `prompts.test.ts` — 7 tests for MCP prompt registration and handlers
- `vitest.config.ts` configuration
- `test`, `test:watch`, and `test:coverage` npm scripts

## [1.0.1] - 2025-02-08

### Changed

- Removed opencode self-referencing config from README (it doesn't make sense to add opencode-mcp to opencode itself)
- Added MCP client configs for VS Code (GitHub Copilot), Cline, Continue, Zed, and Amazon Q
- Clarified that all environment variables and authentication are optional
- Added "Compatible MCP Clients" section to README
- Updated docs/configuration.md with all new client configs

## [1.0.0] - 2025-02-08

### Added

- **70 MCP tools** covering the entire OpenCode headless server API
- **7 high-level workflow tools** — `opencode_ask`, `opencode_reply`, `opencode_conversation`, `opencode_sessions_overview`, `opencode_context`, `opencode_wait`, `opencode_review_changes`
- **18 session management tools** — create, list, get, delete, update, fork, share, abort, revert, diff, summarize, permissions
- **6 message tools** — send prompts (sync/async), list/get messages, slash commands, shell execution
- **6 file & search tools** — text/regex search, file finder, symbol search, directory listing, file reading, VCS status
- **8 config & provider tools** — configuration management, provider listing, auth (API keys, OAuth)
- **9 TUI control tools** — remote-control the OpenCode TUI
- **13 system & monitoring tools** — health, VCS, LSP, formatters, MCP servers, agents, commands, logging, events
- **10 MCP resources** — browseable data endpoints for project, config, providers, agents, commands, health, VCS, sessions, MCP servers, file status
- **5 MCP prompts** — guided workflow templates for code review, debugging, project setup, implementation, session summary
- **Robust HTTP client** — automatic retry with exponential backoff (429/502/503/504), error categorization, timeout support
- **Smart response formatting** — extracts meaningful text from message parts, truncation for large outputs
- **SSE event polling** — monitor real-time server events
- **`npx` support** — run with `npx opencode-mcp` without installing globally
