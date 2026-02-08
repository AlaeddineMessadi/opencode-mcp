# Prompts Reference

MCP Prompts are pre-built workflow templates that guide an LLM through multi-step OpenCode interactions. They are discoverable by MCP clients and can be invoked with arguments.

## Available Prompts

### `opencode-code-review`

Review code changes in an OpenCode session.

**Arguments:**

| Name | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | yes | Session ID to review |

**What it does:**
1. Fetches the diff using `opencode_review_changes`
2. Analyzes changes for correctness, style, performance, and security
3. Provides structured line-level feedback
4. Suggests improvements

---

### `opencode-debug`

Start a guided debugging session.

**Arguments:**

| Name | Type | Required | Description |
|---|---|---|---|
| `issue` | string | yes | Description of the bug |
| `context` | string | no | Additional context (file paths, errors, etc.) |

**What it does:**
1. Gets project context with `opencode_context`
2. Searches for relevant files
3. Reads and analyzes source code
4. Identifies root cause and suggests a fix

---

### `opencode-project-setup`

Get oriented in a new project.

**Arguments:** None

**What it does:**
1. Gets project info, VCS status, and available agents
2. Lists the project structure
3. Reads key files (README, package.json, configs, entry points)
4. Provides a summary: what the project does, tech stack, structure, how to build/run

---

### `opencode-implement`

Have OpenCode implement a feature or make changes.

**Arguments:**

| Name | Type | Required | Description |
|---|---|---|---|
| `description` | string | yes | What to implement |
| `requirements` | string | no | Specific requirements or constraints |

**What it does:**
1. Gets project context
2. Sends the implementation request to OpenCode's build agent
3. Reviews the changes made
4. Reports what was implemented and any follow-up items

---

### `opencode-session-summary`

Summarize what happened in an OpenCode session.

**Arguments:**

| Name | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | yes | Session ID to summarize |

**What it does:**
1. Gets session metadata
2. Reads the full conversation history
3. Reviews file changes
4. Provides a summary: what was discussed, actions taken, files modified, remaining work
