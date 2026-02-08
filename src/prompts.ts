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
