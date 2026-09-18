# Milestone 1 review evidence

Historical checkpoints are retained below. The final candidate evidence at the end supersedes their pending test results. The original 65-tool V2 gate remains blocked by the documented command API incompatibility.

- Worktree baseline: `0de817a`; original checkout unchanged.
- Dependency audit after adding pinned V2 client: `npm audit --json`, zero vulnerabilities (203 dependencies).
- Initial V1 adapter checkpoint: build found an incorrect `timeoutMs` field; executor notified to preserve `RequestOptions.timeout`.
- Initial focused V1 check: `npx vitest run tests/tools.test.ts tests/resources.test.ts tests/contracts.test.ts --reporter=dot`; 125 passed, 7 failed due to changed omitted-option call shapes. Executor notified; final regression run required.

## Review cases

- Discovery must not interpret hidden authentication errors as service absence. Pinned SDK Service.discover returns undefined for failed registration probes; inspect the public registration contract read-only to distinguish absence from authentication/incompatibility before V1 opt-in startup.
- V2 native permission form decline/cancel must not silently cause session-wide rejection.
- Persist log cursor and correlation state together; restart after delivery must retain job ownership.
- Upstream V2 shutdown interruption clears retry state instead of projecting terminal interruption; do not conflate it with explicit cancellation.
- V2 session.command returns void without a caller-assigned ID; prove attribution before reporting completion. V2 session.shell accepts an ID.
- Existing V2 sessions must not inherit configured model defaults.
- Resource templates must migrate along with static resources.
- Fixture tests are not live/client verification; report tested versions and unexercised capabilities.

## Detection/doctor independent checkpoint

Reviewer reran `npx vitest run tests/backend-detection.test.ts tests/doctor.test.ts tests/server-manager.test.ts tests/stdio-integration.test.ts --reporter=dot`: 4 files, 96 tests passed. Covers authentication terminality, read-only diagnostics, redaction, deadline, owned-child lifecycle/authentication, invalid CLI arguments and stdio framing. Final integrated build/regression remains required.

## Confirmed upstream operation blocker

V2 `session.command` input has no caller-assigned identity and returns `Promise<void>`. Published `@opencode/core@2.0.6` SessionCommand.execute delegates to command execution without a result receipt. Concurrent session inputs prevent exact result attribution. The implementation must reject `opencode_command_execute` before V2 mutation and document this separately from the 22 planned upstream removals. Therefore the original 65-supported V2 gate is not met; independent work continues.

## Temporary environment issue

Live install initially failed ENOSPC at ~129 MiB free (V2 native binary ~180 MiB unpacked). Only task-created temp directories were cleaned. Later free space increased to ~3.1 GiB; live checks can resume. No live verification is claimed yet.

## Integrated regression checkpoint

`npm test -- --reporter=dot`: build passed; 559 passed, 3 skipped, 1 failed. The remaining permission-fallback fixture throws a plain string-based error instead of the real typed HTTP 404. Executor will characterize typed 404 fallback and ensure authentication failures/ambiguous writes never cause a second mutation. Final rerun required.

## First isolated V2 startup checkpoint

`node scripts/test-compat.mjs --backend v2` on macOS arm64, Node 26.0.0 installed exact `@opencode/cli@2.0.6`. First attempt found the CLI version string has a `v` prefix; parser corrected. Next attempt started the real server but unauthenticated readiness probes failed because V2 serve enables password authentication. Harness must supply an explicit isolated credential to backend, probes and bridge, and must never include raw startup output in reports. No live API operation is verified by these attempts.

## Successful archive and pinned backend checks

- `npm run test:package`: actual package 3.0.0 archive installed with production dependencies only, macOS arm64 / Node 26.0.0; executable help/version, stdio initialization, 87-tool catalog, fixture health/create/delete, and EOF shutdown passed.
- `npm exec --yes --package=node@22 -- node scripts/test-compat.mjs`: macOS arm64 / Node 22.23.2; exact isolated `opencode-ai@1.18.31` and `@opencode/cli@2.0.6` both passed authenticated runtime identity, archive stdio/catalog, health/project/path/agents/config/file reads, owned session create/get/update/list/delete, and bridge shutdown leaving the external backend alive. Owned backend cleanup completed.
- These runs did not exercise model inference, durable execution recovery, forms/permissions, OAuth, reverts or interactive GUI clients. Mocked/fixture coverage is recorded separately.
- Independent Node 22 checkpoint: jobs, capability catalog and harness suites passed (4 files, 92 tests). Additional tests are still being added; final integrated totals remain pending.
- `npm audit --json`: zero vulnerabilities across 203 dependencies; `git diff --check` passed at this checkpoint.

## Final review findings addressed before candidate verification

- Exact V2 prompt identity now requires a matching delivered user projection before exposing results/input or controlling active execution. Queued work does not require projected history.
- Native Tasks and ordinary fire/run preserve structured capability errors for unsupported preflight options.
- V2 global session APIs require bridge-side default-location resolution to preserve project-scoped listing/status behavior.
- The upstream V2 prompt and compaction operations implicitly commit staged reverts (`@opencode/core@2.0.6`, `Session.prompt` and `Session.compact`). Bridge guards must reject these operations when a revert is staged, avoiding implicit commit; no commit endpoint is exposed.
- A Node 24 checkpoint exposed an old hardcoded 3.0.0 startup-test string and a nested event-observation deadline race. Both require focused fixes and final reruns.

## Final candidate evidence 2026-09-17

Implementation worktree: `<foundation-worktree>`, branch `codex/v1-v2-foundation`, baseline `0de817a919969821eceb8f29059a0ad9d3518a18`. Changes remain uncommitted. No push, tag, publication, global CLI replacement or original-checkout modification was performed.

### Required local checks

All results below use the final candidate source on macOS arm64:

| Check | Result |
|---|---|
| `npm test -- --reporter=dot` under Node 22.23.2 | 26 files; 742 passed, 3 skipped |
| Same suite under Node 24.21.0 | 26 files; 742 passed, 3 skipped |
| `npm run docs:check` | Passed; generated manifest and tool documentation agree |
| `npm run test:coverage` under Node 22.23.2 | Passed; 71.46% statements, 70.37% branches, 72.5% functions, 74.52% lines |
| `npm audit` | Passed; zero vulnerabilities across 203 dependencies |
| `git diff --check` | Passed |
| `test:package` harness, retained archive, Node 22.23.2 and 24.21.0 | Passed on both; production-only install, executable help/version, stdio initialization, 87 tools, fixture health/create/delete, clean EOF shutdown |
| `test:compat` harness, Node 22.23.2 and 24.21.0 | Both exact native backends passed on each Node version |

The three suite skips are one pre-existing skipped HTTP client stub and two Windows-only cases on macOS. The Node 24 event deadline regression and version assertion noted above were fixed before both final full runs.

### Native integration scope

Each compatibility run installed exact `opencode-ai@1.18.31` and `@opencode/cli@2.0.6` in isolated temporary environments and exercised the installed `3.1.0-rc.1` package. Passed: executable and authenticated HTTP runtime identity; stdio initialization/catalog; health/project/path/agents/config/file reads; owned session create/get/update/list/delete; bridge shutdown preserving the external backend; owned test-process cleanup. No model inference or user provider credentials were used.

Durable execution recovery, forms/permissions, revert behavior and native MCP Tasks have fixture/contract coverage, not live inference verification. Interactive GUI clients and provider OAuth flows were not exercised. The configured Ubuntu/macOS/Windows × Node 22/24 GitHub Actions matrix has not been run on hosted runners; only local macOS evidence is claimed.

### Retained release candidate

- Archive: `artifacts/opencode-mcp-3.1.0-rc.1.tgz` (193487 bytes; 134 entries).
- Integrity: `sha512-rnGi4GwEjTSitIzuj/YT1Xrv5guImQuX/p73VD55KCTyvnGrRP0QgbtKYOTkWbvdwzIDzv6Yqdmuw67tH1BhWg==`.
- SHA-1: `5d57652801a380af57dca7defb8d53bfcef38242`.
- Evidence files: `artifacts/pack.json`, `artifacts/package-node22.json`, `artifacts/package-node24.json`, `artifacts/compat-node22.log`, `artifacts/compat-node24.log`.
- The same retained archive bytes were production-installed and tested under both Node versions. Archive inventory includes migration and compatibility documentation and excludes plans, tests, tool caches, artifacts and node_modules.
- `artifacts/` is ignored; candidate files are local review outputs, not a published release.

### Acceptance decision

The manifest accounts for all 87 tools, 10 resources, 4 resource templates and 6 prompts. V1 keeps 87 supported tools. V2 has 64 adapter-backed tools, 22 explicit planned exceptions, and one blocked operation. Unsupported/blocked V2 calls fail before mutation with `UNSUPPORTED_CAPABILITY`.

**The original milestone gate is not complete.** V2 2.0.6 command submission has no caller identifier or result receipt, so exact completion attribution cannot be preserved. `opencode_command_execute` remains blocked instead of dispatching a weaker substitute. All independent work packages and local model-free verification are delivered. Live workflow/client evidence and hosted-platform CI remain explicitly unverified as detailed above.

## Continued verification 2026-09-18

The retained `3.1.0-rc.1` archive was compared byte-for-byte against every corresponding current packaged file: all 134 files matched. Runtime and packaged documentation have not drifted from the candidate.

A remaining evidence gap was identified: prior `test:compat` runs created their own archive, while exact retained-byte testing used the fixture-backed package harness. The follow-up adds explicit retained-archive selection to native compatibility checks and checks standalone doctor against the real isolated backends. Final results will be recorded below.

Docker CLI was available, but `docker info` did not return within approximately one minute; only the probe process was terminated. No daemon or container was started/stopped. Linux and Windows remain unverified locally. Inference remains disabled without an explicitly selected provider/model.

First retained-archive follow-up run on Node 22.23.2: V1 passed, including doctor reporting a configured native provider with 3 read requests, no startup, and no mutations. V2 reached the final backend-survival probe and failed there; the harness reports a generic operation failure without raw server output. This run is not accepted as a pass. Investigation is scoped to the final probe and process exit state; original failure evidence is retained in `artifacts/compat-retained-node22.log`.

### Follow-up results

- `npm exec --yes --package=node@22 -- npm test -- --reporter=dot`: **755 passed, 3 skipped**, 26 test files. Output: `artifacts/regression-followup-node22.log`. The runtime/package content is unchanged; 13 additional harness cases account for the increased total.
- Final focused harness suite: **27 passed** on Node 22.23.2 and Node 24.21.0. Node 24 output: `artifacts/harness-followup-node24.log`.
- Exact retained candidate native checks: V1 passed on Node 22.23.2 in the initial run; V2 passed on the diagnostic rerun (`artifacts/compat-retained-node22-v2-diagnostic.log`). Both backends passed together on Node 24.21.0 (`artifacts/compat-retained-node24.log`). Every report identifies the same retained archive and SHA-512 integrity recorded above.
- Live `doctor --json --directory` checks passed against each exact backend. V1 reported its configured native provider (3 read requests); isolated V2 correctly reported no configured provider and exit 1 (6 read requests). Provider readiness was cross-checked against native provider/integration responses. Neither diagnostic attempted HTTP mutations or native startup; raw and Basic-encoded server credentials were absent from stdout/stderr. Native backends survived bridge disconnect and owned test-process cleanup completed.
- The initial V2 failure did not reproduce. The previous phase label could also cover test cleanup, so its cause cannot be established from the retained original report. Safe allowlisted error/process diagnostics and a separate cleanup phase now preserve better evidence if it recurs. **No runtime fix or resolved root cause is claimed.**
- All 134 packaged files still exactly match the retained archive after the new regression build. Only `scripts/test-compat.mjs`, `tests/compat-harness.test.ts`, and these plan/evidence records changed during this continuation.

To reproduce exact-candidate native checks without rebuilding/repacking:

```sh
npm run test:compat -- --archive /absolute/path/to/opencode-mcp-3.1.0-rc.1.tgz
```

The original 65-tool compatibility gate remains blocked by the pinned V2 command API. No inference, live OAuth/GUI verification, hosted CI, publication, push or commit was performed. The transient initial native-test failure remains recorded for future investigation; it does not justify claiming full release readiness.

## Upstream command tracking request 2026-09-18

Opened [anomalyco/opencode#49690](https://github.com/anomalyco/opencode/issues/49690): `[FEATURE]: V2 session.command invocation identity and result correlation`. The request uses the repository's feature template and includes immutable source links at V2 commit `90112f52db59a8f2ec412c66c6677193bf5dc7b8`, where the input still lacks a caller ID and output remains void/204. Duplicate searches found the earlier completed command implementation (#34429/#34849), which is linked for context; no matching correlation request was found. The report explicitly distinguishes contract inspection from a reproduced live concurrency bug. Body is retained in `plans/upstream-v2-command-issue.md`. Opening the issue does not resolve or change the capability blocker.

## PR preparation 2026-09-18

The user requested pushing this work and opening a PR, superseding the original local-only delivery boundary. No npm publication or merge is authorized. The branch was fast-forwarded to remote main `6f1f62f`, whose file tree exactly matched baseline `0de817a`; implementation contents did not change.

Before committing: Node 24.21.0 full suite passed (755 tests, 3 skipped), Node 22.23.2 coverage passed (71.95% statements, 70.70% branches, 72.40% functions, 75.19% lines), generated documentation checks passed, npm audit found zero vulnerabilities, and staged whitespace checks passed. Machine-specific absolute paths were removed from plan records. Local tool caches and retained archives are excluded from the commit. The PR is prepared as a draft with the upstream blocker and unverified live/hosted checks disclosed.
