# Release and live verification

## Local smoke checks

Build the package, start a local OpenCode server, then run:

```bash
npm run build
node scripts/mcp-smoke-test.mjs
```

The runner creates a temporary Git project and a session owned by that test run. It checks health, project scope, file/search responses, session reads, and monitoring. It deletes its own session in `finally`, closes the MCP connection, and removes its temporary directory and isolated job store. It never selects an existing session for mutation, shares a session, or changes global configuration. Git must be installed.

No model calls run by default. Tools outside these fixture checks appear as **SKIP**, with a reason; a successful smoke run does not claim coverage of those capabilities. Any unexpected tool error, failed fixture assertion, or failed session cleanup makes the command exit nonzero. Response bodies and server diagnostics are not printed because they can contain credentials or private configuration.

The runner uses a local server because the disposable project must be on the same filesystem as OpenCode. It rejects remote URLs instead of interpreting a local temporary path on another machine. Authentication uses the normal `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD` environment variables, forwarded to the MCP child; keep secrets out of command arguments. `OPENCODE_AUTO_SERVE` is always disabled for this test.

### Optional inference checks

To verify async dispatch and completion with a provider and model you have chosen:

```bash
node scripts/mcp-smoke-test.mjs --inference --provider YOUR_PROVIDER --model YOUR_MODEL
```

Alternatively, set all three environment variables: `OPENCODE_TEST_INFERENCE=true`, `OPENCODE_TEST_PROVIDER`, and `OPENCODE_TEST_MODEL`. Supplying a model alone does not enable inference. These checks can incur provider charges.

The runner sends a text-only request through `opencode_fire`, checks progress, waits for completion, then exercises `opencode_run`. It uses the same owned session, runs prompts sequentially, and aborts owned inference before session deletion. A timeout fails verification and prevents a second prompt from being queued. The temporary project's permission policy denies model tool use.

## Release checklist

1. **Choose a version that has never been published.** Check npm's version list, repository tags, GitHub releases, and prior release notes:
   ```bash
   npm view opencode-mcp versions --json
   git tag --list 'v*'
   ```
   Absence from the current npm version list is not proof a version is reusable: npm can permanently reserve previously published versions even after removal. For this package, **2.0.0 is reserved**; 2.0.1 was the compatibility release. Never retry publication under a known reserved version.

2. **Prepare the release metadata.** Update the package version and lockfile together, changelog, compatibility notes, and any generated tool reference. Check the reported MCP server version matches the package. Document changes to defaults, environment variables, runtime requirements, tool inputs, and result shapes. Review the final diff and ensure no credentials or local tooling caches are included.

3. **Run the release checks from a clean installation.**
   ```bash
   npm ci
   npm test
   npm run docs:check
   npm run test:coverage
   npm audit
   git diff --check
   ```
   Confirm the required CI matrix passed on the exact release commit. Record the tested OpenCode version. The default fixture smoke checks should pass; explicitly select a provider/model when validating inference. Record skipped live capabilities accurately.

4. **Inspect and test the actual archive.**
   ```bash
   npm pack --dry-run --json
   npm pack --json
   ```
   Inspect the file list and package metadata. Install the produced archive in a fresh temporary directory, using production dependencies only, then exercise its executable through an MCP client: initialization, tool discovery, a fixture-backed health call, and clean stdio shutdown. Repeat on the supported OS/runtime matrix where practical. This catches missing runtime dependencies or generated files that source-tree tests cannot detect. Record the archive's `integrity` value from the pack result.

5. **Publish the tested archive after release authorization.** Verify the registry account with `npm whoami`, publish that exact `.tgz`, and complete any registry-required authentication. Avoid rebuilding between archive verification and publication. If npm rejects a reserved version, select a new version and repeat metadata, checks, packing, and archive validation before retrying.

6. **Verify the registry artifact.**
   ```bash
   npm view opencode-mcp@VERSION version dist.integrity dist-tags --json
   ```
   Compare `dist.integrity` with the tested archive's integrity and confirm `latest` points to the intended version. Install the exact published version in another clean directory and rerun the package smoke checks. Create the matching Git tag and GitHub release with migration notes and validation evidence. Do not describe a release as published until npm confirms it and these post-publication checks pass.
