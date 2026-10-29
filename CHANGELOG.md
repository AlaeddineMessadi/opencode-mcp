# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [4.0.0] - 2026-10-22

### Breaking changes

- Require an OpenCode 2.x server (tested against 2.1.2). All requests use the `/api/*` server API through the `@opencode-ai/sdk` v2 client (`^1.19.3`, `./v2/client`). An OpenCode 1.x server is detected at startup and rejected with an upgrade message; stay on 3.x to keep using OpenCode 1.x.
- OpenCode 2.x always enforces HTTP Basic authentication. For an external server, `OPENCODE_SERVER_PASSWORD` must match the server's password (username `opencode` by default); a server started without one prints a generated password at startup. A rejected password now produces an explicit credentials error.
- Remove prompt-level structured output. OpenCode 2.x dropped response formats, so the `format` parameter is gone from `opencode_ask`, `opencode_reply`, `opencode_run`, `opencode_fire`, `opencode_provider_test`, `opencode_message_send`, and `opencode_message_send_async`. Ask for machine-readable output in the prompt text instead.
- `opencode_question_reply` now answers an OpenCode 2.x form: it takes `answer`, an object keyed by form field key, instead of `answers`. It and `opencode_question_reject` accept an optional `sessionId`, looked up from the pending form list when omitted.
- Tool parameter changes following the 2.x API:
  - `opencode_message_send` drops `noReply` and `system`, and adds `timeoutMs`; `opencode_ask` drops `system`.
  - `opencode_command_execute` drops `agent`, `providerID`, `modelID`, and `variant`; `opencode_shell_execute` drops `agent`, `providerID`, and `modelID`.
  - `opencode_session_summarize` compacts a session and no longer takes a provider/model/variant.
  - `opencode_session_revert` replaces `partID` with `files`; `opencode_session_unrevert` discards staged revert changes.
  - `opencode_find_text` matches file and directory paths; OpenCode 2.x has no line-level text search. `opencode_find_file` drops `searchDirectory`.
  - `opencode_auth_set` drops `type` and adds an optional `label`. `opencode_provider_oauth_authorize` takes an optional `methodID` instead of `method`/`inputs`; `opencode_provider_oauth_callback` takes `attemptID` and an optional `code` instead of `callbackData`.
  - `opencode_config_update` is limited to the fields OpenCode 2.x can patch (currently `shell`).

### Changed

- Select models per session. New sessions are created with the chosen model; passing a model or `variant` for an existing session switches its model for later turns.
- Submit prompts to OpenCode's asynchronous session inbox and correlate completion with the idle marker that closes the submitted turn. Interrupted and failed turns map to `cancelled` and `failed`.
- Questions are backed by OpenCode 2.x forms. Job input still takes one answer array per field in field order and maps it to field keys, option values, booleans, and numbers.
- Cancellation (`opencode_job_cancel`, `opencode_session_abort`) uses OpenCode's session interrupt. `opencode_session_abort` adds an optional `resume` flag.
- `opencode_session_create` accepts optional `agent`, `providerID`, and `modelID`; `opencode_session_permission` accepts an optional `message`.
- Health checks use `GET /api/info`. Events come from the single `/api/event` stream, scoped by directory for project polling and unscoped for global polling.
- `OPENCODE_AUTO_SERVE=true` now spawns `opencode serve` directly with a randomly generated private password instead of using the SDK launcher.
- The 3.1.0 OpenChamber sign-in and `OPENCODE_SERVER_TOKEN` bearer auth carry over and apply to API requests, the `/api/event` stream and the `/api/info` probe. They need OpenChamber 2.0 or newer, which fronts OpenCode 2.x and passes `/api/*` through unchanged.

### Removed

- Tools without an OpenCode 2.x equivalent: `opencode_find_symbol`, `opencode_formatter_status`, `opencode_instance_dispose`, `opencode_log`, `opencode_lsp_status`, `opencode_session_init`, `opencode_session_share`, `opencode_session_todo`, `opencode_session_unshare`, `opencode_tool_ids`, and `opencode_tool_list`.
- All nine TUI control tools (`opencode_tui_*`).
- The OpenCode 1.18.31 response-format history-serialization workaround and the `StructuredOutput` permission guidance.
- Tool count: 67 in the full profile (down from 87); the essential profile still exposes 25.

### Migration notes

- Upgrade OpenCode to 2.x and restart its server before upgrading the MCP.
- Set `OPENCODE_SERVER_PASSWORD` in the MCP client environment to the server's password, or use `OPENCODE_AUTO_SERVE=true` for a local child server.
- Remove `format` arguments from prompt calls and request the desired output shape in the prompt. Replace calls to removed tools; session todos are no longer exposed.
- Update direct `opencode_question_reply` callers to send `answer: {"<field-key>": value}`. Use `opencode_question_list` to inspect field keys. `opencode_job_input` responses are unchanged.
- Passing a model on a follow-up now changes the session's model for later turns, not only the current prompt.
- OpenChamber users: upgrade to OpenChamber 2.0 or newer and drop the `/api` suffix from `OPENCODE_BASE_URL`.

## [3.1.0] - 2026-10-29

This release supports OpenCode 1.x only and was tested with OpenCode 1.19.3. OpenCode 2.x servers are not supported in 3.x; support is planned for 4.0.

### Added

- Bearer-token authentication with `OPENCODE_SERVER_TOKEN`. When set, it replaces Basic auth; `OPENCODE_OPENCHAMBER_PASSWORD` takes precedence over it.
- OpenChamber sign-in with `OPENCODE_OPENCHAMBER_PASSWORD` (and optional `OPENCODE_OPENCHAMBER_URL`): exchanges the UI password for a client token, keeps it in memory, and renews it once on 401. Applies to API requests, event streams and the health probe. Each process gets a distinct client identifier by default (override with `OPENCODE_OPENCHAMBER_CLIENT_ID`), so independent MCP instances on the same host do not replace each other's token.

### Fixed

- Event streams (`opencode_events_poll`) now keep the `OPENCODE_BASE_URL` path prefix (e.g. OpenChamber's `/api` proxy). Previously they resolved against the origin and dropped it.
- The smoke-test runner now forwards `OPENCODE_SERVER_TOKEN`, `OPENCODE_OPENCHAMBER_PASSWORD`, `OPENCODE_OPENCHAMBER_URL` and `OPENCODE_OPENCHAMBER_CLIENT_ID` to the smoke child.
- A refused OpenChamber sign-in is no longer retried on every tool call, where it could reach OpenChamber's failure limit and lock out the UI. A rejected password is reported until restart. A rate limit waits for `Retry-After`. Other refusals wait 60 seconds. Network errors and 5xx responses are still retried. The same applies when OpenChamber accepts the password but issues no client token.

### Security

- Raise the minimum versions of `@modelcontextprotocol/core` and `@modelcontextprotocol/server` to 2.4.0 and of `zod` to 4.6.6. These address the published high-severity advisories GHSA-jm63-cq47-j5jp, GHSA-46jr-4wx8-v453, GHSA-f897-62hf-6gxq and GHSA-mrhx-c7xc-m3w5, and the medium-severity GHSA-rvq5-wwqv-78pq. `core` follows the exact version that `server` 2.4.0 pins. opencode-mcp uses stdio only, so the HTTP-transport advisories did not affect it; the new floors keep installs clear of them. Development dependencies are updated too; `npm audit` reports no advisories.

### Documentation

- State that 3.x needs OpenChamber 1.12 to 1.24 in front of OpenCode 1.x, and explain when to set a stable `OPENCODE_OPENCHAMBER_CLIENT_ID`.

## [3.0.0] - 2026-09-16

### Breaking changes

- Require Node.js 22 or newer. Upgrade the runtime used by your MCP client before installing 3.0.0.
- Move the MCP implementation to the split SDK v2 packages. Keep legacy stdio clients supported through protocol negotiation; native Tasks and interactive input depend on client capabilities.

### Added

- Durable local job handles and result storage, with get/list/cancel/input tools and default 24-hour retention. Override the storage directory with `OPENCODE_TASK_STORE`.
- Native MCP Tasks support for `opencode_run` through the stdio adapter, with explicit polling and ordinary fire/check/wait fallback.
- Pending question list/reply/reject tools and explicit permission/question responses for jobs. Supporting clients can present interactive input; permissions are never silently approved.
- Optional `full` and `essential` tool profiles selected with `OPENCODE_TOOL_PROFILE`.
- Structured MCP outputs alongside readable text, plus optional OpenCode JSON-schema response formats for prompts.
- Project/session resource templates with encoded absolute server paths; static resources retain their default-project scope.

### Fixed

- Recognize completed JSON-schema tool responses, show the validated JSON in readable output, and recover correlated async results from OpenCode 1.18.31 response-format history serialization failures. Document the required `StructuredOutput` permission.
- Correlate async observation with submitted work and report accepted, running, input-required, completed, failed, cancelled, and unknown states accurately. Observation timeouts preserve progress and do not imply cancellation.
- Preserve request deadlines and cancellation, avoid unsafe automatic mutation retries, and scope event streams to the requested project.
- Redact sensitive configuration/provider fields and preserve valid JSON when responses are truncated.
- Make tool annotations and generated documentation match the registered public surface.
- Replace unsafe smoke-test session fallback with a disposable project and owned-session cleanup. Unexpected backend errors now fail verification; inference requires an explicit provider/model opt-in and skipped tools are reported honestly.
- Refresh client configuration examples, remote path guidance, resource capabilities, development checks, and release verification instructions.

### Migration notes

- Keep OpenCode running externally if work must continue after MCP disconnect. Persisted job records allow resumed observation; they do not checkpoint inference or restart an auto-started child that was closed with MCP.
- Clients should inspect structured state and identifiers rather than parse status text. A timeout means observation ended, not that the job failed. Check existing work before retrying an ambiguous submission.
- The essential profile reduces advertised tools but is not a sandbox. OpenCode's project permission policy still controls delegated coding operations.

## [2.0.1] - 2026-09-15

### Breaking changes

- Automatic server startup is now opt-in. To retain the previous behavior, set `OPENCODE_AUTO_SERVE=true` in your MCP client configuration. Otherwise, start OpenCode explicitly with `opencode serve --port 4096` or share a TUI started with `opencode --port 4096`.

### Changed

- Upgrade `@opencode-ai/sdk` to 1.18.31 and refresh compatible dependencies.

- Automatic server startup is now opt-in with `OPENCODE_AUTO_SERVE=true`. By default, connect to an explicitly managed server or a TUI started with `opencode --port 4096`. This prevents MCP from silently launching a second instance alongside existing TUI sessions (#18).
- Auto-start only supports loopback HTTP endpoints; remote servers must be started on their own host.

### Fixed

- Normalize local project-init protection checks on Windows, including drive roots, native system directories and case differences.

- Forward model variants at the prompt body top level, and remove the unsupported shell variant option (community PR #15, @AveryanAlex). Slash commands now send their model as a `provider/model` string.
- Format current OpenCode tool-state and diff-patch responses, and recognize tool-only activity without reporting a false credentials failure.
- Handle stdin closure and SIGHUP when MCP clients disconnect (community PR #16, @potch8228).

- Preserve POSIX, Windows drive and UNC project paths across client/server OS boundaries. Reject ambiguous relative paths instead of resolving against the MCP process (#13).

- Let OpenCode validate project directory existence on its own machine, enabling remote servers and containers (#14).

- Use the asynchronous prompt endpoint in `opencode_fire` and `opencode_run`, so dispatch does not wait for inference before returning or polling (#20).

## [1.11.0] - 2026-05-19

Architectural release. Migrates server lifecycle to the official `@opencode-ai/sdk`, adds a tool for parallel project initialization, and lands a substantial security/correctness pass on the HTTP and SSE layers.

### Added

- **`opencode_project_init` tool** (#11) — initialize or open a project directory to host an independent OpenCode session. Designed for MCP clients orchestrating parallel multi-project workloads. Creates the directory (`mkdir -p`, idempotent on existing dirs), then pings the OpenCode server at that path to register it as a project. The tool returns the canonical (realpath'd) absolute path so downstream calls can rely on it.

### Changed

- **Server lifecycle now uses `@opencode-ai/sdk`'s `createOpencodeServer`** (#11) instead of our direct `spawn("opencode serve")` call. The SDK launches the `opencode` executable as a child process on the configured port. `OPENCODE_SERVE_ARGS` is ignored by this launcher. Correction added during the 1.18.31 compatibility review: the original release notes incorrectly described this as an in-process server.
- **Reconnect logic rebinds `baseUrl` from `ensureServer()` result** — when the managed server comes up on a different URL than expected, the client rebuilds its SDK instance against the new endpoint before retrying the failed request instead of hammering the dead one.
- **`reconnectAttempts` budget now resets on successful requests** — previously the counter grew monotonically, so a long-lived client permanently exhausted its auto-heal capacity after three reconnects.
- **Startup serialization is now keyed by `baseUrl`** — concurrent `ensureServer()` calls targeting different URLs each get their own startup promise. Same-target callers still share one `createOpencodeServer()` invocation.

### Security

- **Symlink escape in `opencode_project_init` closed** — `path.resolve` only canonicalizes `..`/`.` lexically. A symlink at e.g. `/tmp/safe → /etc` would have passed the forbidden-roots check, then OpenCode would scope its session into `/etc`. The tool now calls `realpath` after `mkdir` and re-runs the deny-list against the canonical path. Forbidden roots are also realpath'd at module load so macOS-style symlinks (`/etc → /private/etc`) match in either form.
- **`/var` removed from the project_init forbidden-roots list** — macOS user-temp directories live under `/var/folders` and many `/var` subtrees are legitimately user-writable. The original deny-list rejected `os.tmpdir()` paths on macOS; a latent bug uncovered while writing the new regression tests.
- **CRLF/NUL guard in `normalizeDirectory`** — Node's `undici` already rejects CRLF in header values, so this isn't currently exploitable, but `normalizeDirectory` now explicitly rejects NUL and CR/LF so the contract is independent of the runtime.
- **Basic auth header now propagated to `/global/health` probe** — when `OPENCODE_SERVER_PASSWORD` was set, the probe was rejected with 401, `isServerRunning` reported unhealthy, and `ensureServer` looped trying to auto-start an already-running server.
- **`x-opencode-directory` header sent raw, no longer URI-encoded** — the OpenCode server treats the header as a literal absolute filesystem path; URI-encoding turned `/tmp/proj` into `%2Ftmp%2Fproj` and broke project scoping for every multi-project tool call.
- **`opencode_project_init` validates `isAbsolute`, rejects NUL bytes, rejects `\r`/`\n`, denies system roots** (`/`, `/etc`, `/usr`, `/bin`, `/sbin`, `/sys`, `/proc`, `/dev`).

### Fixed

- **SSE event parser dropped events when the server used CRLF line endings** — the parser split on `"\n"` only, leaving `\r` on every line. Event names came out as `"message\r"` and the blank-line dispatcher (`"\r" !== ""`) never fired, silently corrupting `opencode_events_poll` and any downstream SSE consumers.
- **Per-call timeouts now propagated to the HTTP dispatcher** via `AbortSignal`. Long-running tools no longer hang past their stated timeout.

### Stats

- Tool count: 80 (up from 79)
- Tests: 328 (up from 321)

## [1.10.2] - 2026-05-16

### Fixed

- **`normalizeDirectory` rejected valid Windows absolute paths** (#5, #6, #13) — the resolved-path check used `startsWith("/")`, which only matches POSIX. On Windows hosts (including `npx`-spawned MCPs talking to a WSL OpenCode), `path.resolve("/mnt/d/Projects/foo")` returns `"\\mnt\\d\\Projects\\foo"`, which failed the check and rendered every tool's `directory` parameter unusable for Windows clients. Switched to the platform-aware `path.isAbsolute` from `node:path`, which accepts both POSIX (`/home/user/project`) and Windows (`C:\Users\me\project`, `\\server\share`) absolute paths. Updated the error message to show both forms.

### Added

- **`OPENCODE_SERVE_ARGS` environment variable** (#7, #9) — pass custom arguments to the `opencode serve` subprocess at auto-start. Useful for advanced server configuration. Thanks @xpufx for the issue.
- **Model variant parameter on all model-accepting tools** (#8, #10) — `opencode_ask`, `opencode_run`, `opencode_fire`, `opencode_reply`, `opencode_message_send*` now accept an optional `variant` to target a specific model variant. Thanks @iamabigartist for the issue.

### Stats

- Tool count: 79
- Tests: 321

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
