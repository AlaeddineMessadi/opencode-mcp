# Prompts Reference

MCP prompts return workflow instructions for the client to follow. Requesting a prompt does not execute its suggested tools or approve an operation. The six existing prompt names and input schemas are unchanged.

| Prompt | Arguments | Guidance |
|---|---|---|
| `opencode-code-review` | `sessionId` | Confirm project scope, inspect diffs, and provide evidence-based review feedback |
| `opencode-debug` | `issue`, optional `context` | Inspect setup, choose a model, investigate, then propose or implement an authorized fix |
| `opencode-project-setup` | none | Read project context and key files; use a read-only OpenCode request when low-level file tools are not advertised |
| `opencode-implement` | `description`, optional `requirements` | Dispatch implementation through run/fire, retain identifiers, resolve explicit input, review changes and tests |
| `opencode-best-practices` | none | Select tools/models, interpret async states, recover jobs, handle input, and understand scope and lifecycle |
| `opencode-session-summary` | `sessionId` | Check current state, inspect bounded history and changes, and summarize completed and remaining work |

## Async Guidance

The implementation and debugging prompts retain the returned `jobId`, `sessionId`, and `messageId`. They use `opencode_job_get`, `opencode_check`, or `opencode_wait` to follow existing work. A timeout does not instruct the client to submit a duplicate prompt.

When work reports `input_required`, the prompt asks the client to present the pending permission or question and forward the user's explicit response. It does not recommend bypassing the request with blanket permission approval.

## Project and Model Context

Use the absolute directory on the OpenCode server for relevant tool calls. These prompt schemas do not contain a directory argument; the client must use the project directory established in the conversation. Do not assume that a previous tool call changed the server's default project.

Provider/model IDs come from discovery or both configured environment defaults. The essential profile supports the common workflow tools, while specialist file/API tools require the full profile. Prompts should only invoke capabilities actually advertised to the client.

See [examples](examples.md) for concrete tool calls and [configuration](configuration.md) for profiles and lifecycle behavior.
