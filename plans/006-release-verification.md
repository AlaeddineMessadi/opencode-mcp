# 006: Compatibility, documentation, package CI and release candidate

Planned at: `0de817a919969821eceb8f29059a0ad9d3518a18`

Scope: first milestone of the user-approved OpenCode MCP compatibility foundation. Work only in `<foundation-worktree>`, branch `codex/v1-v2-foundation`. Preserve original checkout and historical plans. No publishing, pushing, registry submissions, global CLI replacement, implicit V2 startup, telemetry, remote transport, budgets, or future roadmap features. Keep V1 SDK and V1 record schema intact; pin V2 client 2.0.6. Preserve full/essential tool names and defaults.

Verification: focused contract/regression tests before integration; final gates `npm test`, `npm run docs:check`, `npm run test:coverage`, `npm audit`, `git diff --check`, `npm run test:package`, `npm run test:compat`. Tests must distinguish fixtures from live backend evidence. Isolated live targets are opencode-ai@1.18.31 and @opencode/cli@2.0.6; inference is opt-in.

Stop an individual operation and report the exact incompatibility if published upstream contracts cannot preserve its required behavior. Never implement a weaker silent substitute. Ambiguous writes are never replayed.

## Implementation

Generate compatibility/tool docs from manifest. Update setup/lifecycle/limitations/forms/OAuth/migration examples. Add macOS to Ubuntu/Windows Node22/24 matrix. Test actual npm archive clean production install, executable/init/catalog/fixture calls/shutdown. Add test:compat isolated exact V1/V2 versions with model-free default and explicitly enabled selected-model inference. Record versions, skips and exact evidence; mocks do not establish live/client verification. Prepare release candidate only, no publishing or external metadata changes.

## Dependency

Complete work package 005; independently developed tests may be prepared earlier.

## Done criteria

Implementation, generated capability documentation and focused tests agree. Run focused tests, `npm run build`, and all relevant final gates. Report unavailable upstream behavior explicitly. Reviewer maintains index.

## Final status — 2026-09-17

RC prepared; local Node 22/24 gates passed; hosted OS matrix unrun. See [final verification evidence](verification.md#final-candidate-evidence-2026-09-17). The overall 65-tool V2 acceptance gate remains blocked by the command API; fixture coverage is not live workflow verification.

## Artifact verification follow-up — 2026-09-18

The native compatibility harness previously packed the current source independently of the retained candidate archive. Add `--archive` support to run the real pinned backends against the retained bytes and record their integrity, skipping build/repack. Exercise `doctor --json` against each owned backend without model calls, checking backend identity, expected provider readiness, lifecycle, redaction, and lack of session creation. Runtime/package contents remain frozen unless these checks expose a defect.

Linux-container verification was investigated: Docker CLI is installed, but its daemon information request did not respond within approximately one minute. Only that probe process was terminated; no Docker daemon or user container was started/stopped. Hosted Windows/Linux checks remain unverified.

Follow-up completed locally: exact retained archive checks passed for both native backends on Node 22/24, including read-only doctor behavior. Full Node 22 regression: 755 passed / 3 skipped; final harness tests: 27 passed on both Node versions. One initial V2 final-phase failure did not reproduce and remains explicitly unresolved in [verification evidence](verification.md#follow-up-results). Runtime/archive contents are unchanged.
