# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
