/**
 * MCP Prompts — reusable prompt templates for common workflows.
 *
 * These are pre-built prompts that LLMs and MCP clients can discover
 * and invoke, pre-filling arguments from the user. They guide the LLM
 * through complex multi-step OpenCode interactions.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerPrompts(server: McpServer) {
  // ─── Code Review ──────────────────────────────────────────────────
  server.prompt(
    "opencode-code-review",
    "Review code changes in an OpenCode session. Fetches the diff and provides a structured review.",
    {
      sessionId: z
        .string()
        .describe("Session ID to review changes from"),
    },
    async ({ sessionId }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Please review the code changes in OpenCode session "${sessionId}".

Steps:
1. Use opencode_review_changes with sessionId "${sessionId}" to get the diff
2. Analyze the changes for:
   - Correctness and potential bugs
   - Code style and best practices
   - Performance implications
   - Security concerns
3. Provide a structured review with specific line-level feedback
4. Suggest improvements where applicable`,
          },
        },
      ],
    }),
  );

  // ─── Debug Session ────────────────────────────────────────────────
  server.prompt(
    "opencode-debug",
    "Start a debugging session with OpenCode",
    {
      issue: z.string().describe("Description of the bug or issue"),
      context: z
        .string()
        .optional()
        .describe("Additional context (file paths, error messages, etc.)"),
    },
    async ({ issue, context }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `I need to debug an issue. Here's what's happening:

Issue: ${issue}
${context ? `\nContext: ${context}` : ""}

Steps:
1. Use opencode_context to understand the project setup
2. Use opencode_ask with the agent "build" to investigate the issue:
   - Search for relevant files with opencode_find_text and opencode_find_file
   - Read the relevant source code with opencode_file_read
   - Analyze the code and identify the root cause
3. Suggest a fix and optionally have OpenCode implement it`,
          },
        },
      ],
    }),
  );

  // ─── Project Setup ────────────────────────────────────────────────
  server.prompt(
    "opencode-project-setup",
    "Get oriented in a new project using OpenCode",
    {},
    async () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Help me understand this project.

Steps:
1. Use opencode_context to get project info, VCS status, and available agents
2. Use opencode_file_list to see the project structure
3. Look for key files: README, package.json, config files, entry points
4. Use opencode_file_read on the most important files
5. Provide a summary of:
   - What the project does
   - Tech stack and dependencies
   - Project structure
   - How to build and run it
   - Key areas of the codebase`,
          },
        },
      ],
    }),
  );

  // ─── Implement Feature ────────────────────────────────────────────
  server.prompt(
    "opencode-implement",
    "Have OpenCode implement a feature or make changes",
    {
      description: z
        .string()
        .describe("Description of what to implement"),
      requirements: z
        .string()
        .optional()
        .describe("Specific requirements or constraints"),
    },
    async ({ description, requirements }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `I want OpenCode to implement the following:

${description}
${requirements ? `\nRequirements: ${requirements}` : ""}

Steps:
1. Use opencode_context to understand the project
2. Use opencode_ask with the "build" agent to implement the feature:
   "Please implement: ${description}${requirements ? `. Requirements: ${requirements}` : ""}"
3. Use opencode_review_changes to see what was changed
4. Report back what was implemented and any follow-up items`,
          },
        },
      ],
    }),
  );

  // ─── Best Practices ─────────────────────────────────────────────────
  server.prompt(
    "opencode-best-practices",
    "Get best practices for using OpenCode MCP tools effectively. Covers tool selection, async workflows, provider configuration, and common pitfalls.",
    {},
    async () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `# OpenCode MCP Best Practices

## 1. First-Time Setup
- Always start with \`opencode_setup\` to check server health and see available providers.
- Pick a provider from the **Ready to use** list, then call \`opencode_provider_models\` to see its models.
- Test a provider with \`opencode_provider_test\` if you're unsure it's working.

## 2. Always Specify Provider and Model
CRITICAL: When calling \`opencode_ask\`, \`opencode_reply\`, \`opencode_message_send\`, or \`opencode_message_send_async\`, ALWAYS pass \`providerID\` and \`modelID\`. Without these, the agent may select a default model that returns empty responses. Use providers discovered via \`opencode_setup\` — do NOT hardcode any specific provider.

Good: \`opencode_ask({prompt: "...", providerID: "<your-provider>", modelID: "<your-model>"})\`
Bad: \`opencode_ask({prompt: "..."})\`

## 3. Choosing the Right Tool

| Task | Tool | Why |
|------|------|-----|
| Quick question | \`opencode_ask\` | One call, creates session + gets response |
| Multi-turn conversation | \`opencode_ask\` then \`opencode_reply\` | Builds on existing session |
| Complex build task (< 10 min) | \`opencode_run\` | One call, creates session + polls until done |
| Very long task (10+ min) | \`opencode_fire\` + \`opencode_check\` | Fire-and-forget with cheap progress checks |
| Monitor a running session | \`opencode_check\` | Status, todos, file counts in one call |

## 4. Writing Good Prompts for OpenCode
The agent works best with structured, specific prompts:
- Specify the tech stack explicitly
- List all features/requirements as bullet points
- Define the project structure you want
- State what tests you expect
- Say "Run npm run build and fix any errors" at the end

## 5. Monitoring Long-Running Tasks
- \`opencode_check\` — quick progress report: status, todos, file counts (cheapest)
- \`opencode_session_todo\` — see the agent's internal checklist
- \`opencode_wait\` — block until done, but has a timeout
- \`opencode_conversation\` — see full message history (expensive, lots of tokens)
- \`opencode_review_changes\` — see all file diffs (use after task completes)

## 6. Error Recovery
- If a session fails, use \`opencode_reply\` to give the agent the error and ask it to fix
- If the server is unreachable, call \`opencode_setup\` to diagnose
- If auth fails, use \`opencode_auth_set\` to update API keys
- If a session is stuck, use \`opencode_session_abort\` then retry

## 7. Tool Annotations
Tools are annotated with behavior hints:
- \`readOnlyHint: true\` — safe, doesn't change anything (setup, status, find, review)
- \`destructiveHint: true\` — permanently deletes data (session_delete, instance_dispose)
- No annotation — has side effects but is not destructive (ask, reply, send messages)

## 8. Common Pitfalls
- Don't call \`opencode_conversation\` on active sessions — it's expensive and the response is still being generated
- Don't create new sessions for each message — use \`opencode_reply\` to continue existing ones
- Don't forget the \`directory\` parameter when working with multiple projects
- Don't call \`opencode_instance_dispose\` unless you really want to shut down the server`,
          },
        },
      ],
    }),
  );

  // ─── Session Summary ──────────────────────────────────────────────
  server.prompt(
    "opencode-session-summary",
    "Summarize what happened in an OpenCode session",
    {
      sessionId: z.string().describe("Session ID to summarize"),
    },
    async ({ sessionId }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Please summarize OpenCode session "${sessionId}".

Steps:
1. Use opencode_session_get to get session metadata
2. Use opencode_conversation with sessionId "${sessionId}" to read the full history
3. Use opencode_review_changes with sessionId "${sessionId}" to see file changes
4. Provide a summary including:
   - What was discussed/requested
   - What actions were taken
   - What files were modified
   - Current status and any remaining work`,
          },
        },
      ],
    }),
  );
}
