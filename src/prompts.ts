/**
 * MCP Prompts — reusable prompt templates for common workflows.
 *
 * These are pre-built prompts that LLMs and MCP clients can discover
 * and invoke, pre-filling arguments from the user. They guide the LLM
 * through complex multi-step OpenCode interactions.
 */

import { z } from "zod";
import { McpServer } from "./mcp-server.js";

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
1. Confirm the session's project directory and use opencode_review_changes with sessionId "${sessionId}" and that directory to get the diff
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
1. Use opencode_setup and opencode_context with the intended absolute project directory
2. Discover a configured provider/model, or use both configured defaults
3. Use opencode_ask for a short investigation or opencode_fire for longer work. Ask OpenCode to identify the root cause and relevant evidence before changing files
4. Keep the returned jobId, sessionId, and messageId. For background work, observe with opencode_check or opencode_job_get
5. If input_required, present the pending question or permission and forward the user's explicit response with opencode_job_input
6. Suggest a fix and implement it within the user's authorized scope. Report evidence and validation`,
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
1. Use opencode_setup and opencode_context with the intended absolute project directory
2. If file tools are advertised, use opencode_file_list and opencode_file_read to inspect README, package metadata, configuration, and entry points
3. Otherwise ask OpenCode to inspect those files without changing them, using a configured provider/model through opencode_ask
4. Provide a summary of:
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
1. Use opencode_setup and opencode_context with the intended absolute project directory; discover a configured provider/model or use both configured defaults
2. Use opencode_run or opencode_fire with the "build" agent and an explicit project directory to implement the feature:
   "Please implement: ${description}${requirements ? `. Requirements: ${requirements}` : ""}. Run the relevant tests and report their results."
3. Save jobId, sessionId, and messageId. Observe existing work with opencode_job_get, opencode_check, or opencode_wait; a timeout is not a reason to dispatch the same task again
4. If input_required, present the pending question or permission and use opencode_job_input only with the user's explicit answer
5. After completion, use opencode_review_changes for the same session and directory
6. Report what was implemented, the test results, and any remaining work`,
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

## Setup and Model Selection
- Start with opencode_setup and opencode_context for the intended absolute project directory.
- Discover provider/model IDs with opencode_provider_list and opencode_provider_models.
- Pass providerID and modelID together, or configure both OPENCODE_DEFAULT_PROVIDER and OPENCODE_DEFAULT_MODEL.
- A provider test invokes a model and can incur charges; use it when model verification is needed.

## Choosing Tools
- opencode_ask and opencode_reply: short questions and follow-up conversations.
- opencode_run: dispatch work and observe it for a bounded period; capable clients can use the native MCP Tasks extension.
- opencode_fire: dispatch and return immediately. Save jobId, sessionId, and messageId.
- opencode_check or opencode_job_get: inspect existing work. opencode_wait observes until completion, required input, or its deadline.
- opencode_job_list: rediscover retained jobs after reconnecting.
- opencode_review_changes: inspect changes after completion; use bounded opencode_conversation reads for details.

## State and Required Input
- Read structuredContent.status: accepted, running, input_required, completed, failed, cancelled, or unknown.
- A timedOut response ends observation; the OpenCode task may still be running.
- input_required means a pending permission or question needs a response. Use opencode_job_input for an interactive form when supported, or submit explicit responses.
- Only approve permissions that the user has authorized. Do not change the project to blanket permission allow to bypass a pending request.
- Use question_list/question_reply/question_reject and permission_list/session_permission for low-level control when needed.

## Recovery and Cancellation
- Check existing work before retrying a failed or ambiguous submission; do not automatically submit the prompt twice.
- Cancelling an observation or disconnecting MCP does not itself request a remote abort. Use opencode_job_cancel or opencode_session_abort to stop work explicitly.
- Persisted handles/results expire after 24 hours; expiry does not abort the OpenCode session.
- OpenCode must remain running for background execution. An auto-started child closes with MCP, while an externally managed server can keep working.
- Poll for status; this server does not promise push notifications or wake an idle assistant.

## Writing Useful Requests
- State the expected behavior, constraints, and relevant tests.
- Use optional variant values supported by the selected model.
- Use format: {type: "json_schema", schema: {...}} when a machine-readable model answer is needed.

## Common Pitfalls
- Use an absolute directory on the OpenCode host, including for follow-ups. A session alone is not filesystem isolation; parallel edits should use separate projects or worktrees.
- Static resources use the default project. Use encoded project/session resource templates for another directory; resource subscriptions are not implemented.
- The essential profile advertises fewer tools. Use only tools actually listed by the client; select full for specialist APIs.
- Every tool has behavior annotations, but hints do not grant authorization. Coding workflows remain capable of changing files according to OpenCode permissions.
- Large JSON responses use a truncation envelope; its preview is a text prefix, not a complete JSON document.`,
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
1. Confirm the session's project directory and use opencode_check with sessionId "${sessionId}" to inspect its current state
2. Use bounded opencode_conversation reads with the same sessionId and directory to inspect relevant history
3. Use opencode_review_changes with sessionId "${sessionId}" and that directory to see file changes
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
