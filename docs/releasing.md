# Release and live verification

## V1/V2 evidence requirements

The compatibility foundation targets `opencode-ai@1.18.31` for V1 and `@opencode/cli@2.0.6` for V2, with `@opencode/client@2.0.6` pinned. Run each in a disposable installation and isolated state directory. Do not replace a global OpenCode executable or attach to a user's shared service for mutation tests.

Fixture tests verify transport contracts, normalization, request guards, job correlation, and CLI behavior. They do not establish live model/provider compatibility. Likewise, doctor's `matchesIntegrationTarget` is a version comparison, not live verification evidence. Record the exact backend, command, exit status, covered operations, and skipped capabilities for each live run. Inference must remain opt-in with an explicitly selected provider/model.

The generated [capability inventory](compatibility.md) currently lists 64 V2 tool mappings, 22 intentional V1-only exceptions, and one upstream-blocked operation. `opencode_command_execute` remains blocked because the V2 2.0.6 contract cannot correlate exact command completion. Passing tests does not fulfill that missing behavior, and no detached command may be substituted. Keep this limitation in release notes until an upstream contract and its regression tests resolve it.

## Verify the installed archive and isolated backends

```bash
npm run test:package
npm run test:compat
```

`test:package` installs the produced archive with production dependencies into a disposable consumer and checks its executable against an HTTP fixture. `test:compat` builds and packs the bridge, installs each pinned native backend into temporary directories, and exercises that installed bridge against the real isolated backend. It checks runtime versions, catalog/read operations, owned-session create/read/update/list/delete, and backend survival after MCP disconnect. These commands do not publish anything or replace a global executable.

To run one native backend:

```bash
npm run test:compat -- --backend v1
npm run test:compat -- --backend v2
```

The default is `--backend all`; inference is disabled. Temporary homes, state, project, and job stores are removed after the run. Authentication for the owned test server is kept in memory and passed to its bridge; the V2 foreground password is read only from that owned server's documented startup line. Failure reports include safe phase labels, never raw server output or credential values.

To opt in to one model request, choose the provider/model explicitly. Forward only the credential environment variable required by that provider:

```bash
npm run test:compat -- --backend v2 --inference \
  --provider YOUR_PROVIDER --model YOUR_MODEL \
  --credential-env OPENAI_API_KEY
```

Here `OPENAI_API_KEY` is an example variable name; use the relevant existing credential variable for the selected provider. The harness takes its value from the invoking environment, not an argument. Repeat `--credential-env` for additional required credential names. Provider/model/credential arguments without `--inference` are rejected. This optional check can incur provider charges and does not exercise OAuth or GUI interaction. Record the emitted `checks` and `skips` rather than interpreting one successful request as complete capability coverage.

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
   npm run test:package
   npm run test:compat
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
