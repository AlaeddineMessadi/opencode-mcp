# Compatibility foundation implementation

Baseline: `0de817a`. User-approved scope: milestone 1 only. Original checkout and historical review remain intact.

Implementation and local verification are complete for the supported scope; release candidate `3.1.0-rc.1` is prepared. The original milestone acceptance gate remains **BLOCKED**: V2 supports 64 tools, with 22 planned V1-only exceptions and `opencode_command_execute` blocked by the upstream 2.0.6 contract. See [final evidence and limitations](verification.md#final-candidate-evidence-2026-09-17). No publication is claimed.

| Package | Status | Dependency |
|---|---|---|
| [001: Capability manifest and typed adapters](001-contracts.md) | Implemented; catalog coverage and V1 regression passed | — |
| [002: Backend detection, lifecycle, and diagnostics](002-detection-doctor.md) | Implemented; contract, CLI, lifecycle and deadline tests passed | 001 |
| [003: V2 reads, resources, and normalization](003-v2-reads.md) | Implemented; contract tests and model-free native subset passed | 002 |
| [004: V2 mutations, forms, OAuth, permissions](004-v2-writes-input.md) | Implemented except upstream-blocked command; forms/OAuth fixture-tested | 003 |
| [005: Durable V2 jobs and native Tasks](005-durable-v2-jobs.md) | Implemented; recovery and native Tasks fixture-tested; live inference unverified | 004 |
| [006: Compatibility, documentation, package CI and release candidate](006-release-verification.md) | RC retained bytes verified on Node 22/24; initial native-test failure unreproduced; hosted OS matrix unrun | 005 |

## Open upstream blocker

`opencode_command_execute` is tracked in [OpenCode #49690](https://github.com/anomalyco/opencode/issues/49690). See [the blocker record and unblock checklist](004-v2-writes-input.md#v2-command-blocker-tracking). Keep it blocked until the required contract and regression evidence are verified.

## Subsequent roadmap

2. Onboarding/adoption: guided configuration, compact profile, specialist discovery, tested examples and registries.
3. Recovery/observation: caller idempotency keys, reattachment, progress, retention/export.
4. Isolation/verification: managed worktrees, structured artifacts, revision-linked verification and benchmarks.
5. Operational controls: usage, enforceable limits, concurrency, policies.
6. Demand-led remote transport, dashboard, orchestration/routing.

No telemetry infrastructure this milestone. Adoption begins with observed onboarding and voluntary feedback. No release publication is authorized by this implementation task.

2026-09-18 continuation: exact-archive native and doctor verification added. Latest full Node 22 suite: 755 passed, 3 skipped. See [follow-up evidence and unresolved transient failure](verification.md#follow-up-results).

2026-09-18 delivery update: the user authorized pushing the implementation branch and opening a draft PR. This supersedes the original local-only/no-push boundary in the work packages; npm publication and merging remain outside this task. Pre-PR regression, coverage, docs, audit and staged whitespace checks passed; see [PR preparation evidence](verification.md#pr-preparation-2026-09-18).
