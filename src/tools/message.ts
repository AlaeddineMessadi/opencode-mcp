import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import {
  toolResult,
  toolError,
  formatMessageResponse,
  formatMessageList,
  directoryParam,
} from "../helpers.js";

export function registerMessageTools(
  server: McpServer,
  client: OpenCodeClient,
) {
  server.tool(
    "opencode_message_list",
    "List all messages in a session with formatted output showing roles and content",
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
          `/session/${sessionId}/message`,
          query,
          directory,
        );
        return toolResult(formatMessageList(messages as unknown[]));
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
          `/session/${sessionId}/message/${messageId}`,
          undefined,
          directory,
        );
        return toolResult(formatMessageResponse(msg));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_message_send",
    "Send a prompt message to a session and wait for the AI response. Use parts to send text, and optionally specify a model.",
    {
      sessionId: z.string().describe("Session ID"),
      text: z.string().describe("The text message to send"),
      providerID: z
        .string()
        .optional()
        .describe("Provider ID (e.g. 'anthropic')"),
      modelID: z
        .string()
        .optional()
        .describe("Model ID (e.g. 'claude-3-5-sonnet-20241022')"),
      agent: z.string().optional().describe("Agent to use"),
      noReply: z
        .boolean()
        .optional()
        .describe(
          "If true, inject context without triggering AI response (useful for plugins)",
        ),
      system: z.string().optional().describe("System prompt override"),
      directory: directoryParam,
    },
    async ({
      sessionId,
      text,
      providerID,
      modelID,
      agent,
      noReply,
      system,
      directory,
    }) => {
      try {
        const body: Record<string, unknown> = {
          parts: [{ type: "text", text }],
        };
        if (providerID && modelID) {
          body.model = { providerID, modelID };
        }
        if (agent) body.agent = agent;
        if (noReply !== undefined) body.noReply = noReply;
        if (system) body.system = system;
        const response = await client.post(
          `/session/${sessionId}/message`,
          body,
          { directory },
        );
        return toolResult(formatMessageResponse(response));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_message_send_async",
    "Send a prompt message asynchronously (fire-and-forget, does not wait for response). Use opencode_wait to poll for completion.",
    {
      sessionId: z.string().describe("Session ID"),
      text: z.string().describe("The text message to send"),
      providerID: z
        .string()
        .optional()
        .describe("Provider ID (e.g. 'anthropic')"),
      modelID: z
        .string()
        .optional()
        .describe("Model ID (e.g. 'claude-3-5-sonnet-20241022')"),
      agent: z.string().optional().describe("Agent to use"),
      directory: directoryParam,
    },
    async ({ sessionId, text, providerID, modelID, agent, directory }) => {
      try {
        const body: Record<string, unknown> = {
          parts: [{ type: "text", text }],
        };
        if (providerID && modelID) {
          body.model = { providerID, modelID };
        }
        if (agent) body.agent = agent;
        await client.post(`/session/${sessionId}/prompt_async`, body, { directory });
        return toolResult(
          "Message sent asynchronously. Use opencode_wait or opencode_message_list to check for responses.",
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_command_execute",
    "Execute a slash command in a session (e.g. /init, /undo, /redo)",
    {
      sessionId: z.string().describe("Session ID"),
      command: z
        .string()
        .describe("The slash command to execute (e.g. 'init', 'undo')"),
      arguments: z
        .string()
        .optional()
        .describe("Arguments for the command"),
      agent: z.string().optional().describe("Agent to use"),
      providerID: z.string().optional().describe("Provider ID"),
      modelID: z.string().optional().describe("Model ID"),
      directory: directoryParam,
    },
    async ({
      sessionId,
      command,
      arguments: args,
      agent,
      providerID,
      modelID,
      directory,
    }) => {
      try {
        const body: Record<string, unknown> = {
          command,
          arguments: args ?? "",
        };
        if (agent) body.agent = agent;
        if (providerID && modelID) {
          body.model = { providerID, modelID };
        }
        const result = await client.post(
          `/session/${sessionId}/command`,
          body,
          { directory },
        );
        return toolResult(formatMessageResponse(result));
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
      agent: z.string().describe("Agent to use for the shell command"),
      providerID: z.string().optional().describe("Provider ID"),
      modelID: z.string().optional().describe("Model ID"),
      directory: directoryParam,
    },
    async ({ sessionId, command, agent, providerID, modelID, directory }) => {
      try {
        const body: Record<string, unknown> = { command, agent };
        if (providerID && modelID) {
          body.model = { providerID, modelID };
        }
        const result = await client.post(
          `/session/${sessionId}/shell`,
          body,
          { directory },
        );
        return toolResult(formatMessageResponse(result));
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
