### Feature hasn't been suggested before.

- [x] I have verified this feature I'm about to request hasn't been suggested before.

### Describe the enhancement you want to request

Please expose a stable invocation identity and result correlation for V2 `session.command`, or document an existing supported way to obtain them.

While adding V2 support to an MCP bridge, I found that `@opencode/client@2.0.6` accepts `sessionID`, `name`, `text`, attachments and `delivery`, but no caller-assigned ID. Its result is `void`; the HTTP endpoint returns 204. The current V2 branch still has this contract:

- [Client input/output types](https://github.com/anomalyco/opencode/blob/90112f52db59a8f2ec412c66c6677193bf5dc7b8/packages/client/src/effect/api/api.ts#L271-L281)
- [HTTP endpoint](https://github.com/anomalyco/opencode/blob/90112f52db59a8f2ec412c66c6677193bf5dc7b8/packages/protocol/src/groups/session.ts#L413-L429)

This makes it difficult for an external client to associate a command with inputs it admits and their eventual output/error. For example, if a command enqueues a prompt while another client submits work to the same session, selecting the latest message or waiting for session inactivity cannot reliably identify the command's result. A lost HTTP response also leaves the caller without an invocation handle to inspect.

The desired contract would provide:

- A caller-assigned invocation ID, or another recoverable identity.
- A receipt linking the invocation to any admitted input IDs, plus documented status/log correlation.
- Explicit semantics for callback completion versus completion of admitted agent work, including commands that admit no input.

`session.prompt` already accepts an ID and returns an inbox receipt. An equivalent correlation path for commands would let bridges observe results without guessing or replaying uncertain mutations.

This is a contract inspection and integration requirement, not a claim that command execution itself is broken or that a live concurrency race was reproduced. Related: the completed implementation in #34429 / #34849; this request concerns its externally observable invocation/result identity.
