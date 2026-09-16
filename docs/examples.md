# Usage Examples

These examples describe version 3.0.0. Replace provider/model placeholders with IDs discovered from `opencode_setup` and `opencode_provider_models`. All `directory` values refer to absolute paths on the OpenCode server.

## Quick Question and Follow-Up

```javascript
opencode_ask({
  directory: "/home/user/project",
  prompt: "Explain the authentication flow",
  providerID: "<configured-provider>",
  modelID: "<available-model>"
})

opencode_reply({
  directory: "/home/user/project",
  sessionId: "<returned-session-id>",
  prompt: "Which edge cases should we test?",
  providerID: "<configured-provider>",
  modelID: "<available-model>"
})
```

If both default provider/model environment variables are configured, you may omit them from individual calls. An optional `variant` selects an available model variant; use a value supported by the chosen provider/model.

## Background Work and Recovery

```javascript
opencode_fire({
  directory: "/home/user/project",
  prompt: "Add input validation to POST /api/users and run relevant tests",
  providerID: "<configured-provider>",
  modelID: "<available-model>"
})
// Save structuredContent.jobId, sessionId, and messageId.

opencode_check({
  directory: "/home/user/project",
  sessionId: "<returned-session-id>"
})

opencode_job_get({ jobId: "<returned-job-id>" })
```

After an MCP restart, use `opencode_job_list` to rediscover retained jobs. A durable handle helps resume observation; it does not restart a stopped OpenCode server or replay an interrupted prompt.

Use `opencode_job_cancel({jobId: "<returned-job-id>"})` to request cancellation. For a session without a recorded job, use `opencode_session_abort` with its session ID and directory.

## Wait Without Losing the Handle

```javascript
opencode_run({
  directory: "/home/user/project",
  prompt: "Add tests for expired login tokens",
  providerID: "<configured-provider>",
  modelID: "<available-model>",
  maxDurationSeconds: 120
})
```

The response contains the current state. If `timedOut` is true while work continues, keep the returned IDs and call `opencode_job_get`, `opencode_check`, or `opencode_wait`. Do not submit a second copy of the task merely because the wait expired.

For clients implementing the native MCP Tasks extension, request task execution for `opencode_run` through the client's task API. The native `taskId` identifies the same recorded job as its ordinary `jobId`. Clients without that extension can use the tool sequence above; no push notification or automatic assistant wake-up is promised.

## Respond to Required Input

When a job reports `input_required`, inspect its requests. July 2026 MCP clients advertising form elicitation can show an interactive input form. Legacy clients use the explicit response arguments below:

```javascript
opencode_job_input({ jobId: "<returned-job-id>" })
```

Or send an explicit response after the user has chosen it:

```javascript
opencode_job_input({
  jobId: "<returned-job-id>",
  responses: [
    { id: "<permission-request-id>", kind: "permission", reply: "once" },
    { id: "<question-request-id>", kind: "question", answers: [["<chosen-answer>"]] }
  ]
})
```

Question answers are an array per question, each containing the selected answers. To reject a question, send `{id: "<request-id>", kind: "question", reject: true}`. Permission replies are `once`, `always`, or `reject`; choose them according to the user's decision.

Lower-level callers can use `opencode_question_list`, `opencode_question_reply({requestId, answers, directory})`, and `opencode_question_reject({requestId, directory})`. Existing `opencode_permission_list` and `opencode_session_permission` remain available.

## Request Structured Model Output

```javascript
opencode_run({
  directory: "/home/user/project",
  prompt: "Summarize the project using the requested schema",
  providerID: "<configured-provider>",
  modelID: "<available-model>",
  format: {
    type: "json_schema",
    schema: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false
    },
    retryCount: 2
  }
})
```

`format` is forwarded to OpenCode. `{type: "text"}` requests ordinary text. Model-generated structured output and MCP `structuredContent` serve different purposes: the former shapes the model's answer; the latter carries the tool's machine-readable status and result fields.

OpenCode produces the answer by calling its `StructuredOutput` tool. If the project's permission policy denies all tools, explicitly allow this tool in `opencode.json`:

```json
{ "permission": { "*": "deny", "StructuredOutput": "allow" } }
```

This policy is suitable for an output-only task. Add permissions for the reads or edits your task needs. The MCP does not change permissions automatically. Denying `StructuredOutput` can leave a JSON-schema prompt running without producing an answer; an observation timeout does not stop inference. Explicitly abort an owned session when abandoning a run.

OpenCode 1.18.31 can return HTTP 400 when reading history containing a persisted response format. When a job/message ID is known, async observation retries a read of only the latest message and accepts a completed answer only if its parent matches that ID. If it cannot prove completion, it reports `unknown` and does not expose pending inputs from incomplete history. Keep polling the same job rather than resubmitting. Full history and cancellation ownership checks can still fail on the upstream serialization error; use the low-level session abort only after confirming that you own its current work.

## Independent Projects and Parallel Work

```javascript
opencode_fire({
  directory: "/home/user/worktrees/auth",
  prompt: "Add authentication tests",
  providerID: "<configured-provider>",
  modelID: "<available-model>"
})

opencode_fire({
  directory: "/home/user/worktrees/docs",
  prompt: "Update the API documentation",
  providerID: "<configured-provider>",
  modelID: "<available-model>"
})
```

Create the directories or worktrees first. Sessions alone do not isolate file changes; independent worktrees avoid overlapping edits. `opencode_project_init` can initialize a local directory on the MCP host, while remote directories must be created on the OpenCode host.

## Review Completed Work

```javascript
opencode_review_changes({
  directory: "/home/user/project",
  sessionId: "<returned-session-id>"
})

opencode_conversation({
  directory: "/home/user/project",
  sessionId: "<returned-session-id>",
  limit: 10
})
```

Review the changes and test results before accepting the work. Resources and prompts offer additional entry points; see the [resources reference](resources.md), [prompts](prompts.md), and [generated tool schemas](tools.md).
