# 008: Experimental V2 prerelease and issue #31

Date: 2026-10-18. Supersedes the release acceptance scope in earlier work packages; their historical evidence remains intact.

## Approved release scope

The user requested integrating the other agent's #31 fix, finishing merge checks, and preparing a prerelease with V2 command execution disabled and V2 support experimental. Candidate: `3.1.0-rc.2`. Preserve V1 behavior and the 64 V2 mappings / 22 V1-only exceptions / one disabled command accounting. The original 65-tool milestone is still incomplete; upstream [#49690](https://github.com/anomalyco/opencode/issues/49690) no longer blocks this explicitly reduced prerelease scope.

No npm publication, Git tag, GitHub release or merge is part of preparation. After separate publication authorization, publish the exact tested archive to `next`, preserving stable `latest` at 3.0.0. The September rc.1 archive is untouched.

## Integration and review

Adapted the local fix from the **Review repository contribution** chat's `codex/issue31-startup-diagnostics` worktree; its uncommitted files are left intact. The V1 startup path now probes `opencode --version`, rejects recognized V2/newer executables before SDK launch, and explains how to connect to an existing V2 server. Probe time counts against the total startup budget. Unknown launcher versions retain bounded SDK startup. Invalid V1 health JSON cannot trigger replacement startup; owned children close exactly once on failed validation. Authentication remains terminal and never retries without credentials.

The V2-aware detector still accepts a V1 HTML fallback followed by valid V2 server information; it propagates actionable startup incompatibility errors. Focused tests cover versions, HTML, cleanup, total budget and existing V2 connection. Existing manifest tests verify all 23 unavailable V2 tools fail before transport or mutation, including `opencode_command_execute`. V1 command behavior remains covered by HTTP integration tests.

Scope reaches server-manager callers (`backend-detection` and V1 reconnect), their tests, package/lock metadata, generated compatibility documentation, setup/migration/release guides and changelog. No new dependency, no record-format change, no credential output. PR #34 remains separate and is not integrated. No external comment was posted.

## Candidate verification

- Clean `npm ci`, `npm test`, coverage and generated-doc checks passed on macOS arm64 / Node 22.23.3: **774 passed, 3 skipped**. Coverage: 72.09% statements, 70.85% branches, 72.74% functions, 75.28% lines. Node 24.20.0 also passed 774/3 before the final SyntaxError-only health-parser refinement; final revision coverage is enforced by CI on both runtimes.
- `npm audit`: zero advisories. `git diff --check`: passed.
- Retained archive: `artifacts/opencode-mcp-3.1.0-rc.2.tgz`, 196116 bytes, 134 entries. Inspected the allowlisted contents, version, experimental label and startup guard. Integrity:
  `sha512-coxSRIxFzipefaddTrZNs0iQ4Z0y8U1Bciu5FSKoWyk2FWLcfARV0w3BMBUVRJG5+CMUMgEjv7BToAeMoj46hw==`.
- Exact retained archive passed production-only executable/stdio/catalog/fixture/shutdown checks on Node 22.23.3.
- That same archive passed isolated native V1 `opencode-ai@1.18.31` and V2 `@opencode/cli@2.0.32` checks on Node 22.23.3: runtime versions, doctor read-only/no startup/redaction behavior, project/path/agents/config/file reads, session CRUD/list, disconnect survival and cleanup. V2 doctor correctly reported no configured provider in the isolated test environment; no readiness or inference claim is made from that check.
- Logs: `artifacts/rc2-final-tests-node22.log`, `rc2-final-coverage-node22.log`, `rc2-docs-check.log`, `rc2-audit.json`, `rc2-package-node22.log`, `rc2-compat-node22.log` and `rc2-pack.json`. Local artifacts/logs remain ignored; the archive must not be rebuilt between validation and eventual publication.
- Hosted Ubuntu/macOS/Windows × Node 22/24 remains a required merge check on the pushed revision. Final hosted results and any additional Node 24 archive results are recorded in [PR #29](https://github.com/AlaeddineMessadi/opencode-mcp/pull/29). No human approval is claimed; the current ruleset requires a PR but zero approving reviews.

An initial Node 22 coverage invocation overlapped a Node 24 build writing the shared `dist` directory and saw one CLI invalid-argument exit mismatch (1 versus 2). A standalone rerun passed. Build overlap is the suspected cause, not a reproduced application defect; preserve the first failure log and run subsequent checks sequentially.

## Remaining evidence boundaries

Model-free native checks do not verify live inference, durable execution/restart recovery, cancellation against a provider, forms/permissions, OAuth completion or GUI client behavior. Those need exact backend/provider/model/client versions and explicit test results before stable V2 promotion. Parent-session creation remains conservatively rejected pending semantic validation; V2 service startup is intentionally external. Windows Node 26 from the issue report is outside the tested Node 22/24 matrix.
