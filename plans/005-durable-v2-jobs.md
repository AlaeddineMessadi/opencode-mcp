# 005: Durable V2 jobs and native Tasks

Planned at: `0de817a919969821eceb8f29059a0ad9d3518a18`

Scope: first milestone of the user-approved OpenCode MCP compatibility foundation. Work only in `<foundation-worktree>`, branch `codex/v1-v2-foundation`. Preserve original checkout and historical plans. No publishing, pushing, registry submissions, global CLI replacement, implicit V2 startup, telemetry, remote transport, budgets, or future roadmap features. Keep V1 SDK and V1 record schema intact; pin V2 client 2.0.6. Preserve full/essential tool names and defaults.

Verification: focused contract/regression tests before integration; final gates `npm test`, `npm run docs:check`, `npm run test:coverage`, `npm audit`, `git diff --check`, `npm run test:package`, `npm run test:compat`. Tests must distinguish fixtures from live backend evidence. Isolated live targets are opencode-ai@1.18.31 and @opencode/cli@2.0.6; inference is opt-in.

Stop an individual operation and report the exact incompatibility if published upstream contracts cannot preserve its required behavior. Never implement a weaker silent substitute. Ambiguous writes are never replayed.

## Implementation

Keep accepted/running/input_required/completed/failed/cancelled/unknown semantics. Persist assigned msg_ ID before dispatch, pass prompt id, verify receipt. Use queue delivery. Save session log observation cursor; correlate inbox delivery/execution/assistant IDs and terminal events to submitted work. Queued history absence is not failure; session idle alone is not success. Preserve ambiguous unknown/no replay, observation timeout vs cancellation, reject cancellation ownership lost to unrelated turns. V1 schema/files unchanged; V2 records in versioned subdirectory with backend identity. Combined lists backend-labeled, cached terminal results readable; active only via recorded backend. Ordinary tools/native MCP Tasks share JobService. Cover restart, lost receipt, forms, outage, unrelated turns and cancellation.

## Dependency

Complete work package 004; independently developed tests may be prepared earlier.

## Done criteria

Implementation, generated capability documentation and focused tests agree. Run focused tests, `npm run build`, and all relevant final gates. Report unavailable upstream behavior explicitly. Reviewer maintains index.

## Final status — 2026-09-17

Implemented; recovery and native Tasks fixture-tested; live inference unverified. See [final verification evidence](verification.md#final-candidate-evidence-2026-09-17). The overall 65-tool V2 acceptance gate remains blocked by the command API; fixture coverage is not live workflow verification.
