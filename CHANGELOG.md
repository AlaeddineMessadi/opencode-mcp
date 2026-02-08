# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
