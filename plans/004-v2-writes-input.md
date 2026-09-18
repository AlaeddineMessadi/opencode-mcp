# 004: V2 mutations, forms, OAuth, permissions

Planned at: `0de817a919969821eceb8f29059a0ad9d3518a18`

Scope: first milestone of the user-approved OpenCode MCP compatibility foundation. Work only in `<foundation-worktree>`, branch `codex/v1-v2-foundation`. Preserve original checkout and historical plans. No publishing, pushing, registry submissions, global CLI replacement, implicit V2 startup, telemetry, remote transport, budgets, or future roadmap features. Keep V1 SDK and V1 record schema intact; pin V2 client 2.0.6. Preserve full/essential tool names and defaults.

Verification: focused contract/regression tests before integration; final gates `npm test`, `npm run docs:check`, `npm run test:coverage`, `npm audit`, `git diff --check`, `npm run test:package`, `npm run test:compat`. Tests must distinguish fixtures from live backend evidence. Isolated live targets are opencode-ai@1.18.31 and @opencode/cli@2.0.6; inference is opt-in.

Stop an individual operation and report the exact incompatibility if published upstream contracts cannot preserve its required behavior. Never implement a weaker silent substitute. Ambiguous writes are never replayed.

## Implementation

Create model/variant/agent on new V2 sessions; configured defaults only there. Explicit existing selections must match. Reject unsupported JSON-schema format, nonempty system, noReply:true, parentID creation, part-specific revert before writes. Revert via reversible staging, never commit. Preserve fork boundary and explicit session diff range with cross-location rejection/turn attribution. Observe command/shell execution to completion. Add field-keyed typed values/session identity preserving V1 answers. Shared form validation for native elicitation and manual fallback. OAuth requires exact attemptId and explicit integration/method resolution; reject ambiguous provider mappings. Translate supported MCP config and reject conflicts/unsupported fields. V2 always requires explicit project-scope acknowledgment, reject requires session scope. Forms show scopes/saved patterns.

## Dependency

Complete work package 003; independently developed tests may be prepared earlier.

## Done criteria

Implementation, generated capability documentation and focused tests agree. Run focused tests, `npm run build`, and all relevant final gates. Report unavailable upstream behavior explicitly. Reviewer maintains index.

## Final status — 2026-09-17

Implemented except upstream-blocked command; forms/OAuth fixture-tested. See [final verification evidence](verification.md#final-candidate-evidence-2026-09-17). The overall 65-tool V2 acceptance gate remains blocked by the command API; fixture coverage is not live workflow verification.

## V2 command blocker tracking

Recorded: 2026-09-18. Status: **BLOCKED — awaiting a usable upstream contract or documented existing mechanism**.

Upstream feature request: [anomalyco/opencode#49690 — V2 session.command invocation identity and result correlation](https://github.com/anomalyco/opencode/issues/49690). The submitted [issue body](upstream-v2-command-issue.md) and [source verification](verification.md#upstream-command-tracking-request-2026-09-18) are retained locally.

Affected tool: `opencode_command_execute`. The pinned `@opencode/client@2.0.6` command input has no caller-assigned ID and returns void/HTTP 204. The same contract was checked on upstream V2 commit `90112f52db59a8f2ec412c66c6677193bf5dc7b8`. Callback completion does not provide an identity linking the invocation to any admitted agent work. Concurrent session inputs and lost responses therefore prevent reliable result attribution. This is an integration limitation; a live concurrency bug has not been reproduced.

Until resolved, keep the V2 capability blocked and return `UNSUPPORTED_CAPABILITY` before dispatch. V1 behavior remains available. Shell commands and ordinary prompts use separate supported paths. This blocker is additional to the 22 intentional V1-only exceptions.

### Conditions to unblock

- [ ] Confirm a published upstream contract or documented mechanism provides recoverable invocation identity and links to resulting inputs/output, including commands that admit no input. Record the exact version and source.
- [ ] Define callback completion versus completion/failure of admitted agent work; do not infer success from session inactivity.
- [ ] Implement the adapter and correlated observation without replaying uncertain mutations. Any dependency upgrade must preserve the other V1/V2 contracts.
- [ ] Test concurrent inputs, queued work, lost submission responses, reconnects, failures, and commands with no message result. Distinguish fixture evidence from live verification.
- [ ] Run focused adapter/catalog tests and the repository release gates, then update the capability manifest, generated docs, migration notes and verification evidence together.

An upstream issue closure alone does not satisfy these conditions. Verified support would raise V2-backed tools from 64 to 65; the separate release verification gaps remain tracked in work package 006.
