import { z } from "zod";
import { McpServer } from "../mcp-server.js";
import { OpenCodeClient } from "../client.js";
import { createRequestContext } from "../async.js";
import { createMessageId } from "../jobs.js";
import {
  toolResult,
  toolError,
  formatMessageResponse,
  analyzeMessageResponse,
  formatMessageList,
  applyModelDefaults,
  directoryParam,
} from "../helpers.js";

/** Switch the model a session uses (OpenCode 2.x selects models per session). */
export async function switchSessionModel(
  client: OpenCodeClient,
  sessionId: string,
  providerID: string,
  modelID: string,
  variant?: string,
  directory?: string,
): Promise<void> {
  await client.post(
    `/api/session/${encodeURIComponent(sessionId)}/model`,
    { model: { id: modelID, providerID, ...(variant ? { variant } : {}) } },
    { directory },
  );
}

export function registerMessageTools(
  server: McpServer,
  client: OpenCodeClient,
) {
  server.tool(
    "opencode_message_list",
    "List all messages in a session (newest first) with formatted output showing roles and content",
    {
      sessionId: z.string().describe("Session ID"),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of messages to return"),
      directory: directoryParam,
    },
    async ({ sessionId, limit, directory }) => {
      try {
        const query: Record<string, string> = {};
        if (limit !== undefined) query.limit = String(limit);
        const messages = await client.get(
          `/api/session/${encodeURIComponent(sessionId)}/message`,
          query,
          directory,
        );
        return toolResult(formatMessageList(messages as unknown[]), false, { data: messages });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_message_get",
    "Get details of a specific message in a session",
    {
      sessionId: z.string().describe("Session ID"),
      messageId: z.string().describe("Message ID"),
      directory: directoryParam,
    },
    async ({ sessionId, messageId, directory }) => {
      try {
        const msg = await client.get(
          `/api/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`,
          undefined,
          directory,
        );
        return toolResult(formatMessageResponse(msg), false, { data: msg });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_message_send",
    "Send a prompt to a session and wait for the turn to finish. OpenCode 2.x prompts are queued in the session inbox; this tool waits for the run to complete and returns the assistant's answer.",
    {
      sessionId: z.string().describe("Session ID"),
      text: z.string().describe("The text message to send"),
      providerID: z
        .string()
        .optional()
        .describe("Provider ID (e.g. 'anthropic'); switches the session model when combined with modelID"),
      modelID: z
        .string()
        .optional()
        .describe("Model ID (e.g. 'claude-sonnet-4'); switches the session model when combined with providerID"),
      variant: z.string().optional().describe("Model variant (e.g. 'fast', 'smart')"),
      agent: z.string().optional().describe("Agent to use"),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(600000)
        .optional()
        .describe("How long to wait for the run to finish (default 300000 ms)"),
      directory: directoryParam,
    },
    async ({ sessionId, text, providerID, modelID, variant, agent, timeoutMs, directory }) => {
      try {
        const model = applyModelDefaults(providerID, modelID);
        if (model) {
          await switchSessionModel(client, sessionId, model.providerID, model.modelID, variant, directory);
        } else if (variant) {
          // No explicit model: read the session's current model and switch variant.
          const session = await client.get(`/api/session/${encodeURIComponent(sessionId)}`, undefined, directory).catch(() => null);
          const current = (session as Record<string, unknown> | null)?.model as Record<string, string> | undefined;
          if (current?.id && current?.providerID) {
            await switchSessionModel(client, sessionId, current.providerID, current.id, variant, directory);
          }
        }
        const body: Record<string, unknown> = { text };
        if (agent) body.agent = agent;
        const submitted = await client.post(`/api/session/${encodeURIComponent(sessionId)}/prompt`, body, { directory }) as Record<string, unknown>;
        const messageId = typeof submitted?.id === "string" ? submitted.id : undefined;

        // Wait for the session to become idle, then read the answer.
        const context = createRequestContext({ timeout: timeoutMs ?? 300000 });
        try {
          await client.post(`/api/experimental/session/${encodeURIComponent(sessionId)}/wait`, undefined, {
            signal: context.signal, deadline: context.deadline, directory,
          });
        } finally {
          context.dispose();
        }

        const messages = (await client.get(`/api/session/${encodeURIComponent(sessionId)}/message`, { limit: "50" }, directory)) as Array<Record<string, unknown>>;
        // Messages arrive newest-first. Find the assistant answer for this turn:
        // the newest assistant message at or after our user message.
        const ordered = [...messages].reverse();
        const userIndex = messageId ? ordered.findIndex((m) => m.id === messageId) : -1;
        const tail = userIndex >= 0 ? ordered.slice(userIndex) : ordered;
        const assistant = [...tail].reverse().find((m) => m.type === "assistant");
        // The idle marker that closes this turn follows our user message; without
        // a known message ID fall back to the newest one.
        const idle = userIndex >= 0 ? tail.find((m) => m.type === "idle") : [...ordered].reverse().find((m) => m.type === "idle");

        const response = assistant ?? submitted;
        const analysis = analyzeMessageResponse(response);
        const formatted = formatMessageResponse(response);
        const parts: string[] = [];
        if (formatted) parts.push(formatted);
        if (analysis.warning) {
          parts.push(`\n--- WARNING ---\n${analysis.warning}`);
        }
        if (idle?.outcome === "failed") {
          parts.push(`\n--- WARNING ---\nThe run failed${idle.error ? `: ${JSON.stringify(idle.error)}` : ""}.`);
        }
        return toolResult(
          parts.join("\n\n") || "Empty response.",
          analysis.hasError || idle?.outcome === "failed",
          { data: response },
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_message_send_async",
    "Send a prompt asynchronously and return its messageId. Pass sessionId and messageId to opencode_wait to observe this exact turn.",
    {
      sessionId: z.string().describe("Session ID"),
      text: z.string().describe("The text message to send"),
      providerID: z
        .string()
        .optional()
        .describe("Provider ID (e.g. 'anthropic'); switches the session model when combined with modelID"),
      modelID: z
        .string()
        .optional()
        .describe("Model ID (e.g. 'claude-sonnet-4'); switches the session model when combined with providerID"),
      variant: z.string().optional().describe("Model variant (e.g. 'fast', 'smart')"),
      agent: z.string().optional().describe("Agent to use"),
      directory: directoryParam,
    },
    async ({ sessionId, text, providerID, modelID, variant, agent, directory }) => {
      const messageId = createMessageId();
      try {
        const model = applyModelDefaults(providerID, modelID);
        if (model) {
          await switchSessionModel(client, sessionId, model.providerID, model.modelID, variant, directory);
        } else if (variant) {
          const session = await client.get(`/api/session/${encodeURIComponent(sessionId)}`, undefined, directory).catch(() => null);
          const current = (session as Record<string, unknown> | null)?.model as Record<string, string> | undefined;
          if (current?.id && current?.providerID) {
            await switchSessionModel(client, sessionId, current.providerID, current.id, variant, directory);
          }
        }
        const body: Record<string, unknown> = { id: messageId, text };
        if (agent) body.agent = agent;
        await client.post(`/api/session/${encodeURIComponent(sessionId)}/prompt`, body, { directory });
        return toolResult(
          `Message sent asynchronously. Use opencode_wait({sessionId: "${sessionId}", messageId: "${messageId}"}) to observe this exact turn.`,
          false,
          { data: { sessionId, messageId, status: "submitted" } },
        );
      } catch (e) {
        return { ...toolError(e), structuredContent: { data: { sessionId, messageId } } };
      }
    },
  );

  server.tool(
    "opencode_command_execute",
    "Execute a slash command in a session (e.g. /init, /review)",
    {
      sessionId: z.string().describe("Session ID"),
      command: z
        .string()
        .describe("The slash command to execute (e.g. 'init', 'review')"),
      arguments: z
        .string()
        .optional()
        .describe("Arguments for the command (sent as the command text)"),
      directory: directoryParam,
    },
    async ({ sessionId, command, arguments: args, directory }) => {
      try {
        const body: Record<string, unknown> = { name: command, text: args ?? "" };
        const result = await client.post(
          `/api/session/${encodeURIComponent(sessionId)}/command`,
          body,
          { directory },
        );
        return toolResult(formatMessageResponse(result), false, { data: result });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_shell_execute",
    "Run a shell command through the opencode session",
    {
      sessionId: z.string().describe("Session ID"),
      command: z.string().describe("Shell command to execute"),
      directory: directoryParam,
    },
    async ({ sessionId, command, directory }) => {
      try {
        const result = await client.post(
          `/api/session/${encodeURIComponent(sessionId)}/shell`,
          { command },
          { directory },
        );
        return toolResult(formatMessageResponse(result), false, { data: result });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
