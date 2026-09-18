# OpenCode V1/V2 compatibility migration

The compatibility foundation preserves the existing V1 SDK and V1 job records. It adds the pinned `@opencode/client@2.0.6` adapter, explicit backend detection, and a read-only doctor. An API mapping is not proof of live end-to-end behavior: consult the [release verification guide](docs/releasing.md) and record actual backend check results separately.

## Select a backend

Keep the existing MCP stdio command and tool profile. `OPENCODE_BACKEND` defaults to `auto`; set `v1` or `v2` to require that backend's validated contract. `OPENCODE_BASE_URL`, when present, is authoritative. Detection never switches from a failed explicit URL to another server.

Without an explicit URL, the bridge probes `http://127.0.0.1:4096`, then checks an existing V2 service registration using the pinned client's read-only discovery contract. Present but invalid, unauthorized, or unresponsive registrations prevent alternate startup. HTTP 401/403 ends detection. Credentials stay in memory and are excluded from doctor output.

`OPENCODE_AUTO_SERVE=true` continues to allow an owned local V1 child when no existing backend or service registration is present. It never enables V2 `Service.ensure()` or stops a shared service. An owned child stops with MCP; externally managed and discovered servers can continue work while their processes remain alive.

## Check readiness

For a source build:

```bash
npm run build
node dist/index.js doctor --json --directory /absolute/project/on/the/server
```

`doctor` and `--check` perform no inference, session creation, configuration writes, or startup. They share a 15-second deadline. A supplied directory is interpreted on the OpenCode host; omit it to skip the optional project check. External connections do not require an OpenCode executable on the MCP host. Exit codes are `0` for readiness, `1` for failed checks, and `2` for invalid arguments.

The versioned JSON reports `integrationTargetVersion` and `matchesIntegrationTarget`. These describe the intended version baseline, not a completed live test. Provider configuration is inspected without exercising provider credentials. Ordinary stdio can expose its catalog while detection is unresolved, but backend calls fail before mutation with `BACKEND_UNAVAILABLE`; repair the connection and restart MCP.

## Backend-specific behavior

The [generated inventory](docs/compatibility.md) records 87 tool names, with 64 V2 mappings, 22 deliberate V1-only exceptions, and one upstream-blocked command operation. Both profiles retain their names and schemas. Calls that cannot preserve their requested semantics return `UNSUPPORTED_CAPABILITY` before mutation rather than substituting weaker behavior.

| Operation | V2 behavior |
|---|---|
| Prompt output | `format` may be omitted or text. JSON-schema output, per-prompt `system`, and `noReply: true` are rejected. |
| Existing sessions | Model, variant, and agent must match the existing selections. Create a new session to choose different values. |
| Session creation | `parentID` is rejected; fork explicitly. A variant requires an explicit provider/model pair. |
| Fork | A message boundary is **before** that message. The result reports the boundary. |
| Diff/review | Supply explicit `from` and `to` message IDs; no range silently means “all session changes.” Cross-location ranges are rejected. |
| Revert | Whole-message revert is staged and remains reversible through `opencode_session_unrevert`; the bridge never automatically commits it. V2 2.0.6 implicitly commits a staged revert when prompting or compacting, so the bridge rejects those operations while a revert is staged. Clear it with `opencode_session_unrevert`, or explicitly commit it outside the bridge, before continuing. Individual `partID` reverts are rejected. |
| Permissions | `once` affects the specified request. `always` requires `scope: "project"`; `reject` requires `scope: "session"` and rejects all pending permissions in that session. Present that scope before forwarding the user's decision. |
| Questions/forms | Use `sessionId`, `requestId`, and typed, field-keyed `values` from the returned form fields. Legacy selected-label `answers` are not silently converted. |
| Authentication | `opencode_auth_set` accepts API keys through an integration with a published key method. Use the explicit OAuth workflow for OAuth. |
| Slash command execution | `opencode_command_execute` is blocked: V2 2.0.6 supplies no caller ID or submission receipt that allows exact completion correlation. No command is submitted. |

Configuration, providers, sessions, messages, and events may include explicitly labeled V2 raw data or pagination metadata. Consumers should use the bridge's normalized fields and inspect `isError`, structured state, and completeness instead of assuming V1 internals.

## V2 OAuth and explicit input

Discover the provider's authentication methods first. Use the returned integration/method identifiers, then retain the exact authorization attempt:

```javascript
opencode_provider_auth_methods({})
opencode_provider_oauth_authorize({
  providerId: "<discovered-provider>",
  integrationId: "<returned-integration-id>",
  methodId: "<returned-oauth-method-id>"
  // Include values only when the selected method's form requires them.
})
// Follow the returned authorization instructions. Retain structuredContent.data.attemptId.
opencode_provider_oauth_callback({
  providerId: "<same-provider>",
  callbackData: {
    integrationId: "<same-integration-id>",
    attemptId: "<exact-returned-attempt-id>"
    // Include code only if the authorization method requests one.
  }
})
```

For a form whose returned fields are `target` (string), `count` (integer), and `enabled` (boolean), send the user's selected values without coercing their types:

```javascript
opencode_job_input({
  jobId: "<retained-job-id>",
  responses: [{ id: "<form-id>", kind: "question", values: {
    target: "web", count: 2, enabled: false
  } }]
})
```

Use the fields of the actual pending form; this example does not define a universal schema. Conditional fields, patterns, or other forms that cannot be faithfully represented by MCP elicitation are returned for manual typed responses. A native task remains `working` with `pendingInputs` and manual instructions until that input is supplied. Representable forms use native `inputRequests`; both routes validate against the original form.

Permission decisions require the user's explicit approval of their scope:

```javascript
// Only after the user approves saved matching permissions across this project:
opencode_job_input({ jobId: "<job-id>", responses: [
  { id: "<permission-id>", kind: "permission", reply: "always", scope: "project" }
] })

// Only after the user chooses to reject ALL pending permissions in this session:
opencode_job_input({ jobId: "<job-id>", responses: [
  { id: "<permission-id>", kind: "permission", reply: "reject", scope: "session" }
] })
```

For one request, use `reply: "once"`. Native permission forms require a matching scope acknowledgment (`request`, `project`, or `session`) and have no preselected approval. Dismissing a native V2 permission form does not infer a session-wide rejection.

## Durable jobs

V1 records and behavior remain readable. V2 records identify their backend and preserve the correlation evidence needed to observe the submitted work. A lost response produces an unknown outcome; reconnect and inspect the existing job instead of resubmitting. Observation cancellation does not request a remote abort, and record expiration does not cancel remote work.

The same `JobService` serves ordinary `opencode_fire` / `opencode_job_get` / `opencode_job_input` calls and native `opencode_run` / `tasks/get` / `tasks/update`. A native `taskId` is the ordinary `jobId`; changing observation interface does not dispatch a second task. V1 records keep their original layout, while V2 records live in the server/caller scope's `v2/` subdirectory under `OPENCODE_TASK_STORE` (or its default root). Active jobs require their recorded backend; cached terminal results remain readable without re-executing the work.

Persistent records preserve observation handles and results. They do not checkpoint model execution or keep a stopped OpenCode process alive. Separate sessions share filesystem changes unless you explicitly use separate directories or Git worktrees.
