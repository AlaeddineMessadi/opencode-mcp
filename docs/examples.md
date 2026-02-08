# Usage Examples

Real-world examples of using `opencode-mcp` tools from an MCP client.

## One-Shot Code Question

Ask OpenCode a question and get an answer in a single call:

**Tool:** `opencode_ask`

```json
{
  "prompt": "Explain the authentication flow in this project",
  "title": "Auth flow explanation"
}
```

Returns: A new session with OpenCode's response as formatted text.

## Multi-Turn Conversation

Start a session and have a back-and-forth:

**1. First message** — `opencode_ask`:

```json
{
  "prompt": "What testing framework does this project use?",
  "title": "Testing exploration"
}
```

**2. Follow up** — `opencode_reply`:

```json
{
  "sessionId": "<session-id-from-step-1>",
  "prompt": "Show me an example of how to write a new test"
}
```

**3. Follow up again** — `opencode_reply`:

```json
{
  "sessionId": "<session-id-from-step-1>",
  "prompt": "Now add a test for the UserService.create method"
}
```

## Get Project Context

Quickly understand a project you've never seen before:

**Tool:** `opencode_context`

```json
{}
```

Returns: Project info, current path, VCS details (branch, status, recent commits), configuration, and available agents — all in one call.

## Code Review Workflow

Review changes made in a coding session:

**1. Get session overview** — `opencode_sessions_overview`:

```json
{}
```

**2. Review the changes** — `opencode_review_changes`:

```json
{
  "sessionId": "<session-id>"
}
```

Returns: Formatted diffs showing what files were changed and how.

**3. Get full conversation** — `opencode_conversation`:

```json
{
  "sessionId": "<session-id>"
}
```

Returns: The full conversation history with formatted messages.

## Search the Codebase

Find code across the project:

**Search for text/regex** — `opencode_find_text`:

```json
{
  "query": "TODO|FIXME|HACK",
  "regex": true
}
```

**Find files by name** — `opencode_find_file`:

```json
{
  "query": "config"
}
```

**Find symbols** — `opencode_find_symbol`:

```json
{
  "query": "handleAuth"
}
```

## Implement a Feature

Use OpenCode to implement something:

**Tool:** `opencode_ask`

```json
{
  "prompt": "Add input validation to the POST /api/users endpoint. Validate that email is a valid email, name is non-empty, and age is a positive integer. Return 400 with descriptive error messages on validation failure.",
  "title": "Add user input validation"
}
```

Then check what it did:

**Tool:** `opencode_review_changes`

```json
{
  "sessionId": "<session-id>"
}
```

## Async Operations

For long-running tasks, send the prompt without waiting and poll later:

**1. Send async** — `opencode_message_send_async`:

```json
{
  "sessionId": "<session-id>",
  "content": "Refactor the entire authentication module to use JWT tokens"
}
```

**2. Wait for completion** — `opencode_wait`:

```json
{
  "sessionId": "<session-id>",
  "pollIntervalMs": 3000,
  "maxWaitMs": 120000
}
```

## Manage Providers & Auth

**List available providers** — `opencode_provider_list`:

```json
{}
```

**Set an API key** — `opencode_auth_set`:

```json
{
  "providerId": "anthropic",
  "token": "sk-ant-..."
}
```

## Monitor Server Events

Poll for real-time events from the OpenCode server:

**Tool:** `opencode_events_poll`

```json
{
  "durationMs": 5000
}
```

Returns: Events collected over 5 seconds (session updates, message progress, etc.).

## Use MCP Prompts

MCP prompts provide guided workflow templates. Your client presents these as selectable prompts.

### Code Review Prompt

Select the `opencode-code-review` prompt and provide a `sessionId`. The client will receive a structured prompt that guides it through reviewing the session's diffs.

### Debug Prompt

Select `opencode-debug` and provide:
- `issue`: Description of the problem
- `context` (optional): Additional context (file paths, error messages)

The client receives a step-by-step debugging workflow.

### Implementation Prompt

Select `opencode-implement` and provide:
- `description`: What to build
- `requirements` (optional): Specific requirements

The client receives a structured implementation plan that uses OpenCode to build the feature.
