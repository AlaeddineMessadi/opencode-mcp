# 001: Capability manifest and typed adapters

Planned at: `0de817a919969821eceb8f29059a0ad9d3518a18`

Scope: first milestone of the user-approved OpenCode MCP compatibility foundation. Work only in `<foundation-worktree>`, branch `codex/v1-v2-foundation`. Preserve original checkout and historical plans. No publishing, pushing, registry submissions, global CLI replacement, implicit V2 startup, telemetry, remote transport, budgets, or future roadmap features. Keep V1 SDK and V1 record schema intact; pin V2 client 2.0.6. Preserve full/essential tool names and defaults.

Verification: focused contract/regression tests before integration; final gates `npm test`, `npm run docs:check`, `npm run test:coverage`, `npm audit`, `git diff --check`, `npm run test:package`, `npm run test:compat`. Tests must distinguish fixtures from live backend evidence. Isolated live targets are opencode-ai@1.18.31 and @opencode/cli@2.0.6; inference is opt-in.

Stop an individual operation and report the exact incompatibility if published upstream contracts cannot preserve its required behavior. Never implement a weaker silent substitute. Ambiguous writes are never replayed.

## Implementation

Implement typed backend domains for sessions, messages, providers, files, permissions, configuration, events and lifecycle. Characterize existing V1 behavior and move handlers off route assembly. One manifest covers all 87 tools, resources/templates/prompts. Exactly 65 V2 tools and 22 V1-only tools: config_update; session_todo/init/share/unshare; find_text/symbol; instance_dispose; lsp_status; formatter_status; tool_ids/list; log; all nine tui tools. Unsupported calls return structured UNSUPPORTED_CAPABILITY before mutation. Generate documentation from the manifest.

## Dependency

None; establish this contract first.

## Done criteria

Implementation, generated capability documentation and focused tests agree. Run focused tests, `npm run build`, and all relevant final gates. Report unavailable upstream behavior explicitly. Reviewer maintains index.

## Final status — 2026-09-17

Implemented; catalog coverage and V1 regression passed. See [final verification evidence](verification.md#final-candidate-evidence-2026-09-17). The overall 65-tool V2 acceptance gate remains blocked by the command API; fixture coverage is not live workflow verification.
