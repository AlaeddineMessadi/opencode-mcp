# opencode-mcp

[![npm version](https://img.shields.io/npm/v/opencode-mcp)](https://www.npmjs.com/package/opencode-mcp)
[![license](https://img.shields.io/github/license/AlaeddineMessadi/opencode-mcp)](LICENSE)
[![node](https://img.shields.io/node/v/opencode-mcp)](https://nodejs.org/)

**Delegate coding work to OpenCode from your MCP client.**

opencode-mcp connects Claude, Cursor, VS Code, and other MCP clients to OpenCode's headless API. Ask questions, implement features, monitor background work, respond to questions and permissions, and review changes across projects.

> Version 3.0.0 requires **Node.js 22 or newer**. Upgrading from 2.x? See the [migration notes](CHANGELOG.md#300---2026-09-16).

## Quick Start

Install [OpenCode](https://opencode.ai/docs/) and start its server from your project:

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

If you use the TUI, start it with `opencode --port 4096` and share that server. Set `OPENCODE_BASE_URL` for another endpoint.

For Claude Code:

```bash
claude mcp add opencode -- npx -y opencode-mcp
```

For clients using an `mcpServers` configuration:

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

Restart the client and call `opencode_setup`. Choose a provider from its configured providers, then use `opencode_provider_models` to select a model. Set `OPENCODE_DEFAULT_PROVIDER` and `OPENCODE_DEFAULT_MODEL` together or pass the selected IDs in each prompt call.

[Client-specific configuration](docs/configuration.md) includes VS Code, Windsurf, Continue, Zed, and Amazon Q. To test unreleased changes, [build from source](CONTRIBUTING.md) and configure your client to run `node` with the absolute path to `dist/index.js`.

## Choose a Workflow

| Need | Tools |
|---|---|
| Setup and orientation | `opencode_setup`, `opencode_context`, `opencode_provider_models` |
| Quick question or follow-up | `opencode_ask`, `opencode_reply` |
| Start work and wait | `opencode_run` |
| Work in the background | `opencode_fire`, then `opencode_check` or `opencode_wait` |
| Recover or control a recorded job | `opencode_job_list`, `opencode_job_get`, `opencode_job_cancel` |
| Resolve required input | `opencode_job_input`, permission and question tools |
| Review the result | `opencode_review_changes`, `opencode_conversation` |

```javascript
opencode_fire({
  directory: "/absolute/path/to/project",
  prompt: "Add input validation to POST /api/users and run the relevant tests",
  providerID: "<configured-provider>",
  modelID: "<available-model>"
})
// Save the returned job and session IDs; use them to monitor or resume observation.
```

Async results distinguish `accepted`, `running`, `input_required`, `completed`, `failed`, `cancelled`, and `unknown`. An observation timeout returns current progress; it does not mean the task failed or was cancelled. Follow the returned state and IDs instead of assuming an absent busy status means success.

Modern clients can use the MCP Tasks extension for `opencode_run`. Clients without that extension use ordinary tools, including `opencode_fire` and `opencode_check`. Task status is retrieved by polling; this package does not promise to wake an idle assistant with completion notifications.

Tools retain readable text and provide structured results for clients that consume them. Prompt tools accept optional model variants and OpenCode structured-output formats. See the [generated tools reference](docs/tools.md) and [examples](docs/examples.md).

## Multi-Project Use

Project-scoped tools accept `directory`: an absolute path **on the OpenCode server**. POSIX, Windows drive, and UNC paths are preserved across client operating systems. Relative paths are rejected; OpenCode checks existence and access.

`opencode_project_init({path: "/absolute/local/project"})` creates or opens a directory on the **MCP host**. For remote OpenCode servers, create the project on that server instead. Authentication tools are global. Resources offer both static reads of the default project and [explicit project/session templates](docs/resources.md).

Independent sessions do not isolate filesystem changes. Use separate project directories or Git worktrees when running overlapping coding tasks in parallel.

## Configuration

All settings are optional; an OpenCode server must already be running by default.

| Variable | Purpose |
|---|---|
| `OPENCODE_BASE_URL` | Server endpoint; defaults to `http://127.0.0.1:4096` |
| `OPENCODE_SERVER_USERNAME`, `OPENCODE_SERVER_PASSWORD` | Optional server HTTP authentication |
| `OPENCODE_AUTO_SERVE` | Set to `true` to opt in to launching a local server |
| `OPENCODE_DEFAULT_PROVIDER`, `OPENCODE_DEFAULT_MODEL` | Default prompt provider/model pair |
| `OPENCODE_TOOL_PROFILE` | `full` (default) or a smaller `essential` tool set |
| `OPENCODE_TASK_STORE` | Override the local directory for persisted job records |

See [configuration](docs/configuration.md) for storage, permissions, and client setup. Auto-start only supports local loopback HTTP endpoints; custom OpenCode CLI flags require a manually started server.

## Development and Verification

```bash
npm ci
npm test
npm run test:coverage
```

Tests use local fixtures and do not require a model subscription. For controlled live checks against a local OpenCode server:

```bash
npm run build
node scripts/mcp-smoke-test.mjs
```

Live smoke checks use a disposable project and owned session. Inference is opt-in with an explicitly selected provider and model. See [live verification and releases](docs/releasing.md) for scope, skipped capabilities, and publishing checks.

## Documentation

- [Getting started](docs/getting-started.md)
- [Configuration](docs/configuration.md)
- [Tools reference](docs/tools.md)
- [Resources](docs/resources.md) and [prompts](docs/prompts.md)
- [Examples](docs/examples.md)
- [Architecture](docs/architecture.md)
- [Contributing](CONTRIBUTING.md) and [releasing](docs/releasing.md)

[MIT license](LICENSE) · [OpenCode API](https://opencode.ai/docs/server/) · [Model Context Protocol](https://modelcontextprotocol.io/)
