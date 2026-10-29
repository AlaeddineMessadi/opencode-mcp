# Getting Started

## Prerequisites

- Node.js **22 or newer** for version 3.0.0 and later.
- [OpenCode](https://opencode.ai/docs/) **2.x** installed and a provider configured for model calls. Version 4.0.0 rejects OpenCode 1.x servers.
- An MCP client capable of launching a stdio server.

These instructions cover version 4.0.0. Review the [migration notes](../CHANGELOG.md#400---2026-10-22) when upgrading from 3.x.

## 1. Start OpenCode

From your project directory:

```bash
OPENCODE_SERVER_PASSWORD=<choose-a-password> opencode serve --hostname 127.0.0.1 --port 4096
```

OpenCode 2.x always requires HTTP Basic authentication; the MCP needs the same password. Without `OPENCODE_SERVER_PASSWORD`, OpenCode prints a generated password at startup. Alternatively, share your TUI's server by starting it with `opencode --port 4096`. Automatic startup is disabled by default. Opt in with `OPENCODE_AUTO_SERVE=true` only when you want a separate child server; the MCP then generates its own private password and no password setting is needed.

## 2. Add MCP to Your Client

For Claude Code:

```bash
claude mcp add opencode --env OPENCODE_SERVER_PASSWORD=<server-password> -- npx -y opencode-mcp
```

Other clients have different configuration shapes. Follow the [client configuration guide](configuration.md); for example VS Code uses `.vscode/mcp.json` with a `servers` object, while Continue uses YAML.

For this source checkout, run `npm ci` and `npm run build`, then set your MCP command to `node` with the absolute path to `dist/index.js` as its argument. Restart the MCP connection after rebuilding.

## 3. Verify Setup and Choose a Model

Ask your client to:

1. Call `opencode_setup` to inspect server health and configured providers.
2. Call `opencode_provider_models` for a configured provider.
3. Call `opencode_context` with the absolute project `directory`.
4. Pass the selected `providerID` and `modelID` when asking a question.

You can instead set both `OPENCODE_DEFAULT_PROVIDER` and `OPENCODE_DEFAULT_MODEL` in the MCP server's environment. OpenCode 2.x keeps the model on the session, so follow-ups reuse it unless you pass a different one.

## 4. Start Work

Use `opencode_ask` for a quick question. For longer coding work, use `opencode_fire` and save its returned job/session identifiers. Check progress with `opencode_check`, or wait with `opencode_wait`.

If the state is `input_required`, inspect the pending permission or question and respond explicitly. A timeout means the observation period ended; continue monitoring instead of submitting the same task again. Once complete, use `opencode_review_changes` to inspect the result.

See [examples](examples.md) for task recovery, required input, and independent projects.

## Troubleshooting

### Connection refused

Start OpenCode on the configured port and check `OPENCODE_BASE_URL`. For opt-in auto-start, verify `opencode` is on the MCP process's PATH using `command -v opencode` on macOS/Linux or `Get-Command opencode` in PowerShell.

### Unauthorized

OpenCode 2.x always requires authentication. A credentials error (HTTP 401) means `OPENCODE_SERVER_PASSWORD` does not match the server's password. Use the password the server was started with, or the generated one OpenCode printed at startup. The username defaults to `opencode`; change `OPENCODE_SERVER_USERNAME` only if the server uses another. Do not place credentials in shared project configuration.

### OpenCode 1.x detected

opencode-mcp 4.x supports only OpenCode 2.x. Upgrade OpenCode, restart its server, and reconnect. To keep using an OpenCode 1.x server, stay on opencode-mcp 3.x.

### Tools missing

Restart the MCP connection after editing settings. Check the client's MCP logs and verify Node.js 22 or newer is available to the client. If `OPENCODE_TOOL_PROFILE=essential`, specialist tools are intentionally omitted; select `full` when needed.

### Work stopped after closing the client

Jobs persist metadata, but OpenCode must remain running to execute work. An auto-started child closes with MCP. Use an externally managed OpenCode server for work that must survive MCP disconnects.

### Task never reports completion

Check its current state and pending input. Use `opencode_job_list` to rediscover tracked work after reconnecting. A server/network error or `unknown` state is not a reason to submit the same prompt again without checking its existing session.
