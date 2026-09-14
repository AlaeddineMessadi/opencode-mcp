# Contributing to opencode-mcp

## Setup

Use Node.js 22 or newer and Git. Fork and clone the repository, then:

```bash
npm ci
npm test
```

`npm test` builds the CLI and runs the regression suite. Automated tests use local fixtures; they do not require an OpenCode installation, provider credentials, or paid model calls.

For manual use, build with `npm run build`, start an OpenCode server explicitly, and configure your MCP client to run `node` with the absolute path to `dist/index.js`. `npm run dev` rebuilds on edits; restart the MCP connection to load the updated process.

## Development Workflow

1. Create a focused branch from `main`.
2. Implement the change and add regression coverage for its meaningful failure modes.
3. Run `npm run docs:generate` when changing registration schemas, and update workflow/migration documentation when behavior changes.
4. Run:
   ```bash
   npm test
   npm run docs:check
   npm run test:coverage
   npm audit
   git diff --check
   ```
5. Review your diff and open a pull request describing the problem, resulting behavior, and validation.

Use descriptive commits such as `fix: preserve async job state after timeout` or `feat: add project resource templates`. Keep credentials, live session data, generated test projects, and personal MCP configuration out of commits.

## Project Structure

- `src/index.ts`: startup and registration.
- `src/mcp-server.ts`: MCP registration adapter and shared output contracts.
- `src/client.ts`: SDK-backed HTTP/SSE transport.
- `src/server-manager.ts`: explicit server connection and opt-in child lifecycle.
- `src/async.ts`: async observation and correlation.
- `src/helpers.ts`: formatting, redaction, shared inputs.
- `src/tools/`: low-level API tools and combined workflows.
- `src/resources.ts`, `src/prompts.ts`: resources and prompt templates.
- `tests/`: unit, HTTP, stdio, and smoke-runner regression tests.

## Adding or Changing a Tool

Use the registration adapter in the appropriate tool group. Include an input schema, truthful behavior annotations, and machine-readable outputs alongside readable text. Preserve intentional global/project scope and propagate cancellation, deadlines, and request metadata where applicable.

Use shared result and error helpers. Do not swallow transport failures into successful empty results, automatically retry ambiguous mutations, or infer async completion from an absent busy status alone. Inputs for permissions/questions must reflect an explicit response, not an inferred approval.

The generated tools reference must stay synchronized with registered schemas and profiles. Add contract coverage when changing the public API; use integration coverage for transport or protocol behavior rather than testing only a mocked handler.

## Live Tests and Releases

The default live runner uses a disposable local Git project and only sessions it created:

```bash
npm run build
node scripts/mcp-smoke-test.mjs
```

Inference is disabled unless explicitly enabled with a provider/model pair. Read [live verification and releasing](docs/releasing.md) before running model checks or preparing a publication. PASS applies only to checked capabilities; intentional SKIP entries are not coverage.

For bug reports, include the OpenCode version, package version, MCP client, Node version, client/server operating systems, and whether the OpenCode server is local, remote, or in WSL. Describe whether the issue concerns an existing server or an auto-started child. Sanitize credentials and private source/session content.

Changes to runtime requirements, startup defaults, tool inputs, result schemas, or job recovery should include migration notes in the changelog. This branch's new features are unreleased; merging a PR does not publish npm automatically.
