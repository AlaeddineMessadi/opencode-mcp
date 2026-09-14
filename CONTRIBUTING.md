# Contributing to opencode-mcp

Thanks for your interest in contributing! This project is open to everyone.

## Getting Started

1. **Fork** the repository
2. **Clone** your fork:
   ```bash
   git clone https://github.com/<your-username>/opencode-mcp.git
   cd opencode-mcp
   ```
3. **Install dependencies**:
   ```bash
   npm install
   ```
4. **Build**:
   ```bash
   npm run build
   ```
5. **Test locally**: start an OpenCode server (`opencode serve`) and run:
   ```bash
   npm start
   ```

## Development Workflow

1. Create a branch from `main`:
   ```bash
   git checkout -b feat/my-feature
   ```
2. Make your changes in `src/`
3. Build and verify:
   ```bash
   npm test
   npm audit
   git diff --check
   ```
4. Test manually against a running OpenCode server
5. Commit with a descriptive message:
   ```bash
   git commit -m "feat: add support for X"
   ```
6. Push and open a pull request against `main`

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:`: new feature
- `fix:`: bug fix
- `chore:`: maintenance (deps, config, CI)
- `docs:`: documentation changes
- `refactor:`: code restructuring without behavior change

## What to Contribute

- New tools wrapping OpenCode API endpoints
- Bug fixes for existing tools
- Better error handling or response formatting
- Documentation improvements
- MCP client configuration examples
- Tests

## Project Structure

```
src/
  index.ts          Entry point
  client.ts         HTTP client (retry, SSE, errors)
  helpers.ts        Response formatting utilities
  resources.ts      MCP Resources
  prompts.ts        MCP Prompts
  tools/            Tool implementations (one file per domain)
```

## Adding a New Tool

1. Find the appropriate file in `src/tools/` (or create a new one)
2. Register the tool with `server.tool(name, description, schema, handler)`
3. Use `toolResult()`, `toolError()`, and `toolJson()` from `helpers.ts`
4. Add the tool to the README and `docs/tools.md`

## Code Style

- TypeScript with ES modules (`"type": "module"`)
- Use the helper functions from `helpers.ts` instead of raw `JSON.stringify`
- Handle errors gracefully: return `toolError()` instead of throwing

## Questions?

Open an [issue](https://github.com/AlaeddineMessadi/opencode-mcp/issues) for questions, bugs, or feature requests.


## Regression Tests

`npm test` builds the CLI and runs unit, HTTP transport and stdio process tests. The automated tests use local fixtures and do not require an OpenCode install or paid model calls. Node.js 22 or newer is recommended for development because Vitest 4 requires it; the published CLI supports Node.js 18 and newer.

Report the OpenCode version, MCP version, client OS, server OS and whether the server is local, remote, or running in WSL. Keep one issue's fix in a focused commit and reference its issue in the PR. Changes to startup defaults or tool parameters should include migration notes.
