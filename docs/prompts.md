# Prompts Reference

MCP Prompts are guided workflow templates that your client can offer as selectable actions. They structure multi-step interactions with OpenCode.

## Available Prompts (6)

### `opencode-code-review`

Review code changes in an OpenCode session.

| Argument | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | yes | Session ID to review |

**What it does:**
1. Fetches the diff with `opencode_review_changes`
2. Analyzes changes for correctness, style, performance, and security
3. Provides structured line-level feedback
4. Suggests improvements

---

### `opencode-debug`

Start a guided debugging session.

| Argument | Type | Required | Description |
|---|---|---|---|
| `issue` | string | yes | Description of the bug |
| `context` | string | no | Additional context (file paths, error messages) |

**What it does:**
1. Gets project context with `opencode_context`
2. Searches for relevant files
3. Reads and analyzes source code
4. Identifies root cause and suggests a fix

---

### `opencode-project-setup`

Get oriented in a new project.

*No arguments.*

**What it does:**
1. Gets project info, VCS status, and available agents
2. Lists the project structure
3. Reads key files (README, package.json, configs, entry points)
4. Provides a summary: what the project does, tech stack, structure, how to build/run

---

### `opencode-implement`

Have OpenCode implement a feature or make changes.

| Argument | Type | Required | Description |
|---|---|---|---|
| `description` | string | yes | What to implement |
| `requirements` | string | no | Specific requirements or constraints |

**What it does:**
1. Gets project context
2. Sends the implementation request to OpenCode's build agent
3. Reviews the changes made
4. Reports what was implemented and any follow-up items

---

### `opencode-best-practices`

Get guidance on using opencode-mcp effectively.

*No arguments.*

**What it does:**
Provides structured advice on:
- Initial setup and provider configuration
- Tool selection (which tools to use for which tasks)
- Session management and monitoring patterns
- Common pitfalls and how to avoid them
- Recommended workflows for common scenarios

---

### `opencode-session-summary`

Summarize what happened in an OpenCode session.

| Argument | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | yes | Session ID to summarize |

**What it does:**
1. Gets session metadata
2. Reads the full conversation history
3. Reviews file changes
4. Provides a summary: what was discussed, actions taken, files modified, remaining work
