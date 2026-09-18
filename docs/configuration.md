# Configuration

## Environment Variables

An OpenCode server must already be running unless automatic startup is explicitly enabled. Node.js 22 or newer is required for version 3.0.0 and later.

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_BACKEND` | `auto` | Detect the backend, or require `v1` or `v2` |
| `OPENCODE_BASE_URL` | unset | Authoritative OpenCode HTTP(S) endpoint; if absent, probe loopback `http://127.0.0.1:4096` then discover an existing local V2 service |
| `OPENCODE_SERVER_USERNAME` | `opencode` | Username when HTTP authentication is enabled |
| `OPENCODE_SERVER_PASSWORD` | unset | HTTP password; set matching credentials on OpenCode and MCP |
| `OPENCODE_AUTO_SERVE` | `false` | Set exactly `true` to allow an owned local V1 child; never starts V2 |
| `OPENCODE_DEFAULT_PROVIDER` | unset | Default prompt provider ID |
| `OPENCODE_DEFAULT_MODEL` | unset | Default prompt model ID; configure both defaults together |
| `OPENCODE_TOOL_PROFILE` | `full` | `full` or `essential`; changes the advertised tool set |
| `OPENCODE_TASK_STORE` | see below | Root directory for persisted job records |

Choose provider/model IDs from `opencode_setup` and `opencode_provider_models`. Authentication credentials are global to OpenCode; `directory` does not make provider credentials project-specific.

An explicit URL never falls back to a different server. URLs must be HTTP(S), without embedded credentials, queries, or fragments; configure authentication using the environment variables above. HTTP 401/403 ends detection without alternate probes or startup. A present but invalid or unresponsive local service registration also prevents replacement startup. V2 discovery uses the pinned 2.0.6 registration-file contract and `Service.discover()`; it never calls `Service.ensure()` or `Service.stop()`.

Run `opencode-mcp doctor --json [--directory ABSOLUTE_SERVER_PATH]` after installing this build, or `node dist/index.js doctor` from source. Doctor shares a 15-second deadline across checks, performs no inference or writes, and ignores auto-start permission. Project access is checked only when a directory is supplied. The report identifies backend, recognized version, connection source, ownership, and disconnect behavior; credentials and raw upstream responses are omitted. `--check` is an alias. Exit `0` means ready, `1` means a failed check, and `2` means invalid CLI arguments.

The `essential` profile keeps the common delegation, observation, and required-input workflows available with fewer tool definitions. Select `full` for low-level API tools, TUI control, or provider administration. The profile is a discovery choice, not a security boundary: coding workflows can still modify files or run commands through OpenCode according to its permissions.

Job records hold local operational metadata and results, independent of OpenCode's session storage. The default root is `$XDG_STATE_HOME/opencode-mcp/tasks` (falling back to `~/.local/state/opencode-mcp/tasks`); Windows uses `%LOCALAPPDATA%/opencode-mcp/tasks`. Records are partitioned by server and caller scope. Records expire 24 hours after creation; expiry removes the handle and does not abort the OpenCode session. Keep the task store private to your user account and persist it if the MCP process is ephemeral. See [architecture](architecture.md) for recovery behavior and retention.

## Project Scope

For project-scoped tools, `directory` must be an absolute path on the OpenCode server. POSIX, Windows drive, and UNC paths are preserved on every client OS; relative paths and NUL/CR/LF are rejected. OpenCode resolves existence, access, and symlinks. Global authentication tools omit `directory`.

`opencode_project_init` operates on the MCP host filesystem and accepts `path`. It cannot create a directory on a remote OpenCode host. Static resources read the server's default project; [resource templates](resources.md) explicitly select a project or session.

## MCP Client Configurations

These examples launch the published npm package. When testing a source build, replace the command with `node` and the arguments with the absolute path to your built `dist/index.js`. Modern MCP extensions are negotiated; support for tools does not imply that a client supports tasks or interactive input.

### Claude Code

```bash
# Current project, private to your account
claude mcp add opencode -- npx -y opencode-mcp

# Available across projects
claude mcp add opencode --scope user -- npx -y opencode-mcp

# Custom endpoint
claude mcp add opencode --env OPENCODE_BASE_URL=http://127.0.0.1:8080 -- npx -y opencode-mcp
```

See [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp) for scopes and environment expansion.

### Claude Desktop, Cursor, and Windsurf

Use the following server entry in the client's MCP configuration:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "npx",
      "args": ["-y", "opencode-mcp"],
      "env": { "OPENCODE_TOOL_PROFILE": "essential" }
    }
  }
}
```

- **Claude Desktop:** open the app's developer settings to edit its MCP configuration.
- **Cursor:** use the MCP settings UI or the project's `.cursor/mcp.json`; see [Cursor MCP documentation](https://cursor.com/docs/mcp).
- **Windsurf:** edit `~/.codeium/windsurf/mcp_config.json` through its MCP settings. See [Windsurf MCP documentation](https://docs.windsurf.com/windsurf/cascade/mcp).

### VS Code / GitHub Copilot

Use `.vscode/mcp.json` in the workspace, or run **MCP: Open User Configuration** for a user-level file. The key is `servers`:

```json
{
  "servers": {
    "opencode": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "opencode-mcp"]
    }
  }
}
```

See [VS Code MCP setup](https://code.visualstudio.com/docs/agent-customization/mcp-servers). Client-specific secret inputs can be used instead of committing credentials in JSON.

### Continue

Create `.continue/mcpServers/opencode.yaml` in your workspace:

```yaml
name: OpenCode
version: 1.0.0
schema: v1
mcpServers:
  - name: opencode
    command: npx
    args: ["-y", "opencode-mcp"]
```

Use Agent mode. See [Continue MCP configuration](https://docs.continue.dev/reference) and [workspace configuration](https://docs.continue.dev/guides/configuring-models-rules-tools).

### Zed

Use **Settings → AI → MCP Servers → Add Local Server**, or edit the settings file:

```json
{
  "context_servers": {
    "opencode": {
      "command": "npx",
      "args": ["-y", "opencode-mcp"],
      "env": {}
    }
  }
}
```

See [Zed MCP configuration](https://zed.dev/docs/ai/mcp). The command is a string; the earlier nested `command.path` example is obsolete.

### Amazon Q Developer

Open the tools/MCP panel, add a **STDIO** server named `opencode`, set command `npx`, and arguments `-y opencode-mcp`. Choose local or global scope. The current IDE UI stores these settings in `.amazonq/default.json` or `~/.aws/amazonq/default.json`; see [Amazon Q configuration](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/mcp-ide.html).

### Cline

Use Cline's MCP server settings to add a stdio server with command `npx` and arguments `-y opencode-mcp`.

## Required Input and Permissions

OpenCode can pause a session for permission or a question. Async observation reports `input_required`; it does not treat the pause as successful completion. Use the returned job ID with `opencode_job_input`, or use the lower-level tools:

| Tool | Purpose |
|---|---|
| `opencode_permission_list` | Inspect pending permission requests in a project |
| `opencode_session_permission` | Reply `once`, `always`, or `reject` |
| `opencode_question_list` | Inspect pending questions |
| `opencode_question_reply` | Provide selected answers |
| `opencode_question_reject` | Dismiss a pending question |

When supported by the client, job input can present an interactive request. These tools never silently approve permissions. Set a deliberate permission policy in the project's `opencode.json`; blanket `"permission": "allow"` is an optional policy choice, not a prerequisite for headless use.

## Server Lifecycle

Start a server explicitly:

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

Or share the TUI's server by starting it with `opencode --port 4096`. For custom flags, start OpenCode manually. `OPENCODE_SERVE_ARGS` is unsupported by the SDK launcher.

To opt in to a separate local V1 child server, add `"OPENCODE_AUTO_SERVE": "true"` under your MCP server's `env`. Automatic startup accepts loopback HTTP endpoints only and shuts down only the child it launched. An existing external server or discovered V2 service remains running when the MCP client disconnects. Start V2 separately and use its URL or existing local registration.

When other TUI instances are running, prefer a shared explicitly configured server. [Issue #18](https://github.com/AlaeddineMessadi/opencode-mcp/issues/18) reports hangs when a second server shares OpenCode storage; the underlying cause has not been confirmed. MCP does not scan processes to select a TUI.
