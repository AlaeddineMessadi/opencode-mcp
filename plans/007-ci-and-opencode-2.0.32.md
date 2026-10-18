# CI cleanup and OpenCode 2.0.32 — 2026-10-18

User scope: fix PR #29's macOS/Node 24 CI failure, then check OpenCode 2.0.32 compatibility. No merge, npm publication, global CLI replacement, or inference is authorized by this continuation.

## Cleanup diagnosis and fix

The original [macOS/Node 24 job](https://github.com/AlaeddineMessadi/opencode-mcp/actions/runs/35317065224/job/105510934788) failed in `backend-cleanup`. Its diagnostics omitted the error code. A local run with the same Node 24.20.0 reproduced that phase on V1, with `EPERM` exposed by the expanded safe code allowlist (`artifacts/compat-2032-final-node24.log`). This isolates a process-cleanup failure independent of V2 API behavior; the old hosted log cannot prove the identical errno.

Darwin's [killpg1 implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c) excludes zombie processes from group iteration and can return EPERM when no eligible group members remain. The helper previously treated this transient state as a fatal permission failure. It now retries Darwin EPERM for at most one second per signal/probe, allowing children to be reaped, and still throws persistent EPERM. ESRCH is accepted for both signals as well as probes to handle a group disappearing between calls. Only explicitly owned groups are signalled; the native harness still checks that the port closes.

Regression tests cover transient Darwin EPERM at TERM/probe/KILL, disappearance at TERM/KILL, persistent permission failure, and a real wrapper/server process tree. No blanket permission-error suppression was introduced.

An unrelated 30ms cancellation fixture timed out during filesystem setup in a parallel coverage run. It now injects a TimeoutError through the caller's abort signal only after interrupt dispatch starts, preserving the unknown/no-replay assertion without depending on scheduler speed. Production cancellation code is unchanged.

## 2.0.32 compatibility

- Pin `@opencode/client` and the isolated `@opencode/cli` target to 2.0.32; preserve V1 SDK and target 1.18.31.
- `project.list` now takes input before request options; forward the abort signal in the correct position.
- The new client preserves base URL prefixes. Remove our 2.0.6 workaround, which otherwise doubles the prefix. Existing HTTP tests caught the regression; event tests now also cover `/bridge` and `/api` prefixes.
- Published client/service declarations and core sources were inspected. Discovery still uses the same registration contract; prompt/compact still commit staged reverts, so guards remain.
- Command invocation identity and receipts are still absent. [Upstream #49690](https://github.com/anomalyco/opencode/issues/49690) remains open. V2 remains 64 supported tools, 22 intentional exceptions, and one blocked command.
- Upstream now accepts session-create parentID. This bridge still rejects it pending semantic validation; the error/documentation no longer claim the upstream option is absent.
- Refresh six vulnerable dependencies within existing declared ranges; audit is clean. No new dependency or global npm configuration is added. The explicit 2.0.32 install used a command-local release-age override because the requested version was newer than the user's default installation delay.

## Verification

- macOS arm64, Node 24.20.0: full regression 764 passed / 3 skipped (`artifacts/resume-tests-node24.log`).
- macOS arm64, Node 22.23.3: coverage suite 764 passed / 3 skipped; statements 72.05%, branches 70.85%, functions 72.56%, lines 75.24% (`artifacts/resume-coverage-node22.log`).
- Node 24.20.0: real isolated V1 1.18.31 and V2 2.0.32 plus installed bridge archive passed (`artifacts/compat-2032-cleanup-fixed-node24.log`). Includes runtime identity, read-only doctor, project list/current, paths, agents, configuration, file reads, session CRUD/list, bridge disconnect survival, process cleanup and port closure.
- Node 22.23.3: production archive executable, initialization, 87-tool catalog, fixture calls and EOF shutdown passed (`artifacts/package-2032-node22.log`).
- Node 22.23.3: the same V1/V2 native checks passed (`artifacts/compat-2032-node22.log`). Both Node versions tested the archive with integrity `sha512-ZD7tAE4YPF9Mrj82RecxLxxVGTkFwZ9JkGC3QsDGwVWfIZfSNUiDU6eQ6p4wGCRW2m7DnDnYd31WlfxyvNJxog==`.
- Generated docs check, audit (zero advisories), and whitespace checks passed. All six hosted Ubuntu/macOS/Windows × Node 22/24 jobs passed at `3454942` in [run 39153690429](https://github.com/AlaeddineMessadi/opencode-mcp/actions/runs/39153690429).

Live inference, durable execution recovery, forms/permissions, OAuth and GUI clients remain unverified. Existing fixture coverage is not live evidence. The retained September RC archive is unchanged and does not contain this continuation.

## Related work

The `Review repository contribution` chat owns a separate uncommitted fix for issue #31 in `codex/issue31-startup-diagnostics`. It makes the V1 launcher reject V2 promptly. Those files were not changed or copied here. PR #34 is a contributor's OpenChamber authentication change awaiting corrections; it has not been integrated. Our migration guide explains the V2 connection settings and published 3.0.0 limitation. No reply to bonsai or other contributor was posted during this work.
