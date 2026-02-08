/**
 * High-level workflow tools — composite operations that make it easy
 * for an LLM to accomplish common tasks in a single call.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import {
  formatMessageResponse,
  formatMessageList,
  formatSessionList,
  toolResult,
  toolError,
} from "../helpers.js";

export function registerWorkflowTools(
  server: McpServer,
  client: OpenCodeClient,
) {
  // ─── One-shot: create session + send prompt + return answer ─────────
  server.tool(
    "opencode_ask",
    "Ask OpenCode a question in one step. Creates a new session, sends your prompt, and returns the AI response. This is the easiest way to interact with OpenCode.",
    {
      prompt: z.string().describe("The question or instruction to send"),
      title: z
        .string()
        .optional()
        .describe("Optional title for the session"),
      providerID: z
        .string()
        .optional()
        .describe("Provider ID (e.g. 'anthropic')"),
      modelID: z
        .string()
        .optional()
        .describe("Model ID (e.g. 'claude-3-5-sonnet-20241022')"),
      agent: z
        .string()
        .optional()
        .describe("Agent to use (e.g. 'build', 'plan')"),
      system: z
        .string()
        .optional()
        .describe("Optional system prompt override"),
    },
    async ({ prompt, title, providerID, modelID, agent, system }) => {
      try {
        // 1. Create session
        const session = (await client.post("/session", {
          title: title ?? prompt.slice(0, 80),
        })) as Record<string, unknown>;
        const sessionId = session.id as string;

        // 2. Send prompt
        const body: Record<string, unknown> = {
          parts: [{ type: "text", text: prompt }],
        };
        if (providerID && modelID) {
          body.model = { providerID, modelID };
        }
        if (agent) body.agent = agent;
        if (system) body.system = system;

        const response = await client.post(
          `/session/${sessionId}/message`,
          body,
        );

        // 3. Format and return
        const formatted = formatMessageResponse(response);
        return toolResult(
          `Session: ${sessionId}\n\n${formatted}`,
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Continue a conversation ────────────────────────────────────────
  server.tool(
    "opencode_reply",
    "Send a follow-up message to an existing session. Use this to continue a conversation started with opencode_ask or opencode_session_create.",
    {
      sessionId: z.string().describe("Session ID to reply in"),
      prompt: z.string().describe("The follow-up message"),
      providerID: z.string().optional().describe("Provider ID"),
      modelID: z.string().optional().describe("Model ID"),
      agent: z.string().optional().describe("Agent to use"),
    },
    async ({ sessionId, prompt, providerID, modelID, agent }) => {
      try {
        const body: Record<string, unknown> = {
          parts: [{ type: "text", text: prompt }],
        };
        if (providerID && modelID) {
          body.model = { providerID, modelID };
        }
        if (agent) body.agent = agent;

        const response = await client.post(
          `/session/${sessionId}/message`,
          body,
        );
        const formatted = formatMessageResponse(response);
        return toolResult(formatted);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Get conversation history (formatted) ──────────────────────────
  server.tool(
    "opencode_conversation",
    "Get the full conversation history of a session, formatted for easy reading. Shows all messages with their roles and content.",
    {
      sessionId: z.string().describe("Session ID"),
      limit: z
        .number()
        .optional()
        .describe("Max messages to return (default: all)"),
    },
    async ({ sessionId, limit }) => {
      try {
        const query: Record<string, string> = {};
        if (limit !== undefined) query.limit = String(limit);
        const messages = await client.get(
          `/session/${sessionId}/message`,
          query,
        );
        const formatted = formatMessageList(
          messages as unknown[],
        );
        return toolResult(formatted);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Quick session overview ────────────────────────────────────────
  server.tool(
    "opencode_sessions_overview",
    "Get a quick overview of all sessions with their titles and status. Useful to find which session to continue working in.",
    {},
    async () => {
      try {
        const [sessions, statuses] = await Promise.all([
          client.get("/session") as Promise<Array<Record<string, unknown>>>,
          client.get("/session/status") as Promise<Record<string, unknown>>,
        ]);

        // Merge status into session info
        const enriched = sessions.map((s) => ({
          ...s,
          status: statuses[s.id as string] ?? "unknown",
        }));

        const formatted = formatSessionList(enriched);
        return toolResult(formatted);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Project context ──────────────────────────────────────────────
  server.tool(
    "opencode_context",
    "Get full project context in one call: current project, path, VCS info, config, and available agents. Useful to understand the current state before starting work.",
    {},
    async () => {
      try {
        const [project, path, vcs, config, agents] = await Promise.all([
          client.get("/project/current").catch(() => null),
          client.get("/path").catch(() => null),
          client.get("/vcs").catch(() => null),
          client.get("/config").catch(() => null),
          client.get("/agent").catch(() => null),
        ]);

        const sections: string[] = [];

        if (project) {
          sections.push(
            `## Project\n${JSON.stringify(project, null, 2)}`,
          );
        }
        if (path) {
          sections.push(`## Path\n${JSON.stringify(path, null, 2)}`);
        }
        if (vcs) {
          sections.push(
            `## VCS (Git)\n${JSON.stringify(vcs, null, 2)}`,
          );
        }
        if (config) {
          sections.push(
            `## Config\n${JSON.stringify(config, null, 2)}`,
          );
        }
        if (agents) {
          const agentList = agents as Array<Record<string, unknown>>;
          sections.push(
            `## Agents (${agentList.length})\n${agentList.map((a) => `- ${a.name ?? a.id}: ${a.description ?? "(no description)"} [${a.mode ?? "?"}]`).join("\n")}`,
          );
        }

        return toolResult(sections.join("\n\n"));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Wait for async session to complete ───────────────────────────
  server.tool(
    "opencode_wait",
    "Poll a session until it finishes processing. Use this after opencode_message_send_async to wait for the AI to complete its response.",
    {
      sessionId: z.string().describe("Session ID to wait on"),
      timeoutSeconds: z
        .number()
        .optional()
        .describe("Max seconds to wait (default: 120)"),
      pollIntervalMs: z
        .number()
        .optional()
        .describe("Polling interval in ms (default: 2000)"),
    },
    async ({ sessionId, timeoutSeconds, pollIntervalMs }) => {
      try {
        const timeout = (timeoutSeconds ?? 120) * 1000;
        const interval = pollIntervalMs ?? 2000;
        const start = Date.now();

        while (Date.now() - start < timeout) {
          const statuses = (await client.get("/session/status")) as Record<
            string,
            unknown
          >;
          const status = statuses[sessionId] as string | undefined;

          if (!status || status === "idle" || status === "completed") {
            // Fetch latest messages
            const messages = await client.get(
              `/session/${sessionId}/message`,
              { limit: "1" },
            );
            const arr = messages as unknown[];
            if (arr.length > 0) {
              return toolResult(
                `Session completed.\n\n${formatMessageResponse(arr[arr.length - 1])}`,
              );
            }
            return toolResult("Session completed (no messages).");
          }

          if (status === "error") {
            return toolResult(`Session ended with error status.`, true);
          }

          await new Promise((r) => setTimeout(r, interval));
        }

        return toolResult(
          `Timeout: session still processing after ${timeoutSeconds ?? 120}s`,
          true,
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Review changes ────────────────────────────────────────────────
  server.tool(
    "opencode_review_changes",
    "Get a formatted summary of all file changes made in a session. Shows diffs in a readable format.",
    {
      sessionId: z.string().describe("Session ID"),
      messageID: z
        .string()
        .optional()
        .describe("Specific message ID to get diff for"),
    },
    async ({ sessionId, messageID }) => {
      try {
        const query: Record<string, string> = {};
        if (messageID) query.messageID = messageID;
        const diffs = await client.get(`/session/${sessionId}/diff`, query);
        const { formatDiffResponse } = await import("../helpers.js");
        return toolResult(formatDiffResponse(diffs as unknown[]));
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
