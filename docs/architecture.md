# Architecture

## Overview

```text
MCP client ── stdio ── opencode-mcp ── HTTP / SSE ── OpenCode server
                            │
                            └── local job metadata and result storage
```

opencode-mcp is a stdio bridge. OpenCode owns coding sessions and model execution. The MCP process owns tool registration, response formatting, job observation, and its local job records. A remote OpenCode server can be used through HTTP; the MCP-facing transport remains stdio.

## Main Components

| Area | Responsibility |
|---|---|
| Entry point and MCP adapter | Register the catalog, select a profile, negotiate protocol support, manage stdio |
| `client.ts` | SDK-backed HTTP requests, error handling, bounded retries, SSE, directory routing |
| `backends/` | V1/V2 domain adapters, normalized records, capability inventory, and explicit compatibility guards |
| `backend-detection.ts`, `doctor.ts` | Contract validation, read-only discovery, lifecycle identity, and bounded readiness diagnostics |
| `server-manager.ts` | Health probe, optional local child startup, owned-child shutdown |
| `async.ts` | Shared request deadlines, cancellation, and abortable waits |
| Job service and job tools | Persist handles/results, correlate completion, observe, cancel, and request required input |
| `helpers.ts` | Input helpers, result formatting, redaction, truncation |
| `tools/` | OpenCode API tools and combined workflows |
| `resources.ts`, `prompts.ts` | Data reads and reusable workflow instructions |

The full catalog is available by default. The essential profile advertises a smaller group of common workflows. Both profiles keep their names and use the selected backend's OpenCode permission model. The [generated inventory](compatibility.md) records supported, deliberately V1-only, and upstream-blocked operations. V2 calls never fall through to guessed V1 endpoints.

## Async State and Recovery

The async workflow distinguishes submission from completion. A job can be `accepted`, `running`, `input_required`, `completed`, `failed`, `cancelled`, or `unknown`. Completion is correlated with the submitted work; an omitted idle entry in OpenCode's status map is not sufficient evidence by itself. V1 observation uses submitted message/assistant correlation. V2 uses its inbox and execution/event identities, retaining the evidence needed after reconnect. V1 record interpretation is preserved; V2 records carry their backend identity.

`opencode_fire` returns promptly after dispatch. `opencode_check` observes work; `opencode_wait` and `opencode_run` wait within a bounded observation period. Expiring that period returns progress with a timeout indication. It does not abort the OpenCode session. Requests for permission or answers surface as `input_required` so the caller can respond explicitly. Cancellation of an observation stops waiting; use the job-cancel or session-abort tool to stop remote work.

Local job handles and results persist across MCP restarts, with a default 24-hour retention period measured from creation. Expiring a handle does not cancel the remote session. This supports rediscovery and resumed observation of existing OpenCode work, not checkpointing or restarting model execution. An ambiguous submission is not automatically resubmitted, because that could run a task twice. Backend failures remain errors rather than becoming successful completion.

Background execution survives an MCP disconnect only while the OpenCode server remains running. An externally managed OpenCode server is left running. A child launched by `OPENCODE_AUTO_SERVE=true` is closed with the MCP process, so do not rely on that child for work that must continue after disconnect.

### Native MCP Tasks

On protocol revision `2026-07-28`, clients advertising `io.modelcontextprotocol/tasks` in their per-request capabilities receive a native task handle from `opencode_run`. `tasks/get` retrieves status and the eventual result; `tasks/update` supplies explicit input responses; `tasks/cancel` requests cancellation. This follows the [July 2026 Tasks extension schema](https://github.com/modelcontextprotocol/ext-tasks/blob/main/schema/2026-07-28/schema.ts), rather than the earlier experimental task API. A small stdio adapter handles these extension operations; standard and legacy protocol messages use the MCP SDK v2 transport. Ordinary `fire`/`check`/`wait` calls remain available to clients without Tasks support.

No task status notifications are advertised. Clients poll explicitly. There is no remote HTTP MCP transport or guarantee that a notification wakes an idle model.

### Interactive Input

Job input can present pending permission or question requests through a negotiated modern client interaction. Explicit permission and question tools provide a fallback. Replies are validated and forwarded to OpenCode; the bridge does not approve permissions on the user's behalf.

## Request Scope and Lifecycle

Project-scoped calls include an absolute `directory` on the OpenCode server. Validation rejects relative paths and NUL/CR/LF bytes, preserving POSIX, Windows drive, and UNC paths without consulting the MCP host's filesystem. OpenCode resolves actual existence and access.

Authentication routes are global. `opencode_project_init` is a separate local-filesystem operation: it accepts `path`, checks protected roots and symlinks, creates the directory if necessary, then opens it through OpenCode. It does not create remote projects.

On startup the process validates the selected backend's health/info contract. An explicit endpoint is authoritative. Otherwise, it probes the default loopback endpoint and checks the existing V2 registration. The pinned 2.0.6 discovery implementation hides authentication failures as an absent result, so the bridge preflights the documented registration file with a bounded authenticated probe before `Service.discover()` selects the service. Present-but-invalid registrations fail closed. It never calls V2 `Service.ensure()` or `Service.stop()`.

With automatic startup explicitly enabled and no existing endpoint or registration, the V1 SDK can launch `opencode serve` on a local loopback HTTP endpoint. Concurrent starts are coalesced by endpoint. Shutdown handlers stop only owned child processes; externally managed servers remain running. A failed owned-child startup closes only that child. HTTP 401/403 is terminal and never enables another probe or unauthenticated retry.

Backend identity records kind, version, connection source, process ownership, and whether execution can survive MCP disconnect. In auto mode, unresolved startup can leave the stdio catalog available, but backend operations return `BACKEND_UNAVAILABLE` before mutation. Reconnect after repairing the server. Forced backend mismatches and authentication failures terminate startup.

Doctor shares a 15-second deadline across configuration, detection, and read-only readiness checks. It performs no startup, inference, session creation, or configuration writes. Its versioned JSON uses fixed sanitized messages rather than raw server bodies; reported provider configuration is not credential verification.

## Transport and Observation Costs

HTTP requests share a total deadline across attempts and use cancellation-aware waits. Project event polling forwards the directory; explicitly global event polling rejects a directory to avoid ambiguous scope. Polling preserves partial errors.

Job observation reads bounded recent messages to correlate completion. It uses session summary counts rather than downloading full diffs on each check. This is not a promise of zero network or history reads: the first fresh observation still contacts OpenCode; already persisted terminal results can be returned locally.

## Results, Resources, and Prompts

Tools expose behavior annotations and an output schema. They retain readable text for older clients and provide `structuredContent` for machine consumption. Generic JSON responses use a `data` field; workflow responses add fields such as job/session IDs and state. Consumers should inspect `isError` and structured state rather than infer success from arbitrary text.

Sensitive configuration/provider fields are redacted. Oversized serialized responses use a valid JSON truncation envelope with a text preview instead of slicing JSON into an invalid document.

Static resources use the default project. Project/session resource templates encode their explicit server path in the URI. Resources have no subscription support. Prompts guide common workflows but do not themselves execute tools.

## Verification

Unit tests cover formatting, validation, job state, and tool behavior. Local HTTP fixtures exercise the SDK transport; stdio process tests cover protocol behavior and lifecycle. The live smoke runner creates a disposable Git project and mutates only its owned session, with inference disabled by default. See [releasing](releasing.md) for exact live-check scope and artifact verification.

### Shared-session cancellation

V1 OpenCode aborts a whole session. Job cancellation refuses a known newer turn, but another client can submit work between that check and the abort request. V2 can cancel a queued item by its exact inbox ID; interrupting a running execution is also session-wide. V2 checks execution ownership and additional queued work before interrupting, but another client can submit between that check and the write. Use the default dedicated session per job on either backend when cancellation must not affect concurrent work. Uncertain backend responses remain uncertain and are not replayed.

A native `tasks/cancel` acknowledgement records cancellation intent; it does not prove execution has stopped. Poll `tasks/get` for the eventual state, especially after a lost backend response.
