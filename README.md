# opencode-mcp

[![npm version](https://img.shields.io/npm/v/opencode-mcp)](https://www.npmjs.com/package/opencode-mcp)
[![license](https://img.shields.io/github/license/AlaeddineMessadi/opencode-mcp)](LICENSE)
[![node](https://img.shields.io/node/v/opencode-mcp)](https://nodejs.org/)

**Delegate coding work to OpenCode from your MCP client.**

opencode-mcp connects Claude, Cursor, VS Code, and other MCP clients to OpenCode's headless API. Ask questions, implement features, monitor background work, respond to questions and permissions, and review changes across projects.

> Version 3.0.0 requires **Node.js 22 or newer**. Upgrading from 2.x? See the [migration notes](CHANGELOG.md#300---2026-09-16).

This source branch adds an OpenCode V1/V2 compatibility foundation. It retains the V1 API and adds the pinned V2 client contract. V2 currently maps **64 tools**, keeps **22 V1-only exceptions**, and blocks **1 command operation** whose completion cannot be correlated safely. See the [generated compatibility inventory](docs/compatibility.md) and [V1/V2 migration guide](MIGRATION.md). This is not a claim that every live backend workflow has been verified.

## Quick Start

For OpenCode V1, install [OpenCode](https://opencode.ai/docs/) and start its server from your project:

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

If you use the TUI, start it with `opencode --port 4096` and share that server. Set `OPENCODE_BASE_URL` for another endpoint.

For V2, start OpenCode separately and supply its URL, or let this bridge discover its existing local service registration. The bridge never starts or stops the shared V2 service. `OPENCODE_BACKEND=auto` recognizes the running backend; set `v1` or `v2` to require a specific contract. An explicit `OPENCODE_BASE_URL` is always authoritative.

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

Check a source build before connecting your MCP client:

```bash
node dist/index.js doctor --json --directory /absolute/path/on/opencode/server
```

Doctor performs only read operations, with a 15-second total deadline and no inference or server startup. It reports version recognition, provider configuration, project access, and lifecycle. Exit codes are `0` ready, `1` failed checks, and `2` invalid arguments. `--check` is an alias; no arguments still starts stdio.

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

Tools retain readable text and provide structured results for clients that consume them. V1 accepts OpenCode structured-output formats. V2 rejects JSON-schema output and preserves the selected model, variant, and agent when continuing an existing session. See [migration restrictions](MIGRATION.md), the [generated tools reference](docs/tools.md), and [examples](docs/examples.md).

## Multi-Project Use

Project-scoped tools accept `directory`: an absolute path **on the OpenCode server**. POSIX, Windows drive, and UNC paths are preserved across client operating systems. Relative paths are rejected; OpenCode checks existence and access.

`opencode_project_init({path: "/absolute/local/project"})` creates or opens a directory on the **MCP host**. For remote OpenCode servers, create the project on that server instead. Authentication tools are global. Resources offer both static reads of the default project and [explicit project/session templates](docs/resources.md).

Independent sessions do not isolate filesystem changes. Use separate project directories or Git worktrees when running overlapping coding tasks in parallel.

## Configuration

All settings are optional; an OpenCode server must already be running by default.

| Variable | Purpose |
|---|---|
| `OPENCODE_BACKEND` | `auto` (default), `v1`, or `v2` |
| `OPENCODE_BASE_URL` | Authoritative endpoint; otherwise probe loopback, then discover an existing local V2 service |
| `OPENCODE_SERVER_USERNAME`, `OPENCODE_SERVER_PASSWORD` | Optional server HTTP authentication |
| `OPENCODE_AUTO_SERVE` | Set to `true` to opt in to launching an owned local V1 child |
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
- [V1/V2 migration](MIGRATION.md) and [capability inventory](docs/compatibility.md)
- [Tools reference](docs/tools.md)
- [Resources](docs/resources.md) and [prompts](docs/prompts.md)
- [Examples](docs/examples.md)
- [Architecture](docs/architecture.md)
- [Contributing](CONTRIBUTING.md) and [releasing](docs/releasing.md)

[MIT license](LICENSE) · [OpenCode API](https://opencode.ai/docs/server/) · [Model Context Protocol](https://modelcontextprotocol.io/)
