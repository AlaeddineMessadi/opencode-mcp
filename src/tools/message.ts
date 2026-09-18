import { operate, selectModel } from "../backends/adapter.js";
import { z } from "zod";
import { McpServer } from "../mcp-server.js";
import { OpenCodeClient } from "../client.js";
import { createMessageId } from "../jobs.js";
import {
  toolResult,
  toolError,
  formatMessageResponse,
  analyzeMessageResponse,
  formatMessageList,
  applyModelDefaults,
  directoryParam,
  outputFormatParam,
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
      cursor: z.string().optional().describe("V2 continuation cursor"),
      directory: directoryParam,
    },
    async ({ sessionId, limit, cursor, directory }) => {
      try {
        const query: Record<string, string> = {};
        if (limit !== undefined) query.limit = String(limit);
        if (cursor) query.cursor = cursor;
        const messages = await operate(client, "messages.list", { sessionId: sessionId, query: query, directory: directory });
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
        const msg = await operate(client, "messages.get", { sessionId: sessionId, messageId: messageId, directory: directory });
        return toolResult(formatMessageResponse(msg), false, { data: msg });
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
      variant: z.string().optional().describe("Model variant (e.g. 'fast', 'smart')"),
      agent: z.string().optional().describe("Agent to use"),
      noReply: z
        .boolean()
        .optional()
        .describe(
          "If true, inject context without triggering AI response (useful for plugins)",
        ),
      system: z.string().optional().describe("System prompt override"),
      format: outputFormatParam,
      directory: directoryParam,
    },
    async ({
      sessionId,
      text,
      providerID,
      modelID,
      variant,
      agent,
      noReply,
      system,
      format,
      directory,
    }) => {
      try {
        const body: Record<string, unknown> = {
          parts: [{ type: "text", text }],
        };
        const model = selectModel(client, providerID, modelID);
        if (model) body.model = model;
        if (variant || client.getBackendIdentity?.().kind === "v2" && variant !== undefined) body.variant = variant;
        if (agent || client.getBackendIdentity?.().kind === "v2" && agent !== undefined) body.agent = agent;
        if (noReply !== undefined) body.noReply = noReply;
        if (system) body.system = system;
        if (format) body.format = format;
        const response = await operate(client, "messages.send", { sessionId: sessionId, body: body, ...({ directory }) });

        const analysis = analyzeMessageResponse(response);
        const formatted = formatMessageResponse(response);
        const parts: string[] = [];
        if (formatted) parts.push(formatted);
        if (analysis.warning) {
          parts.push(`\n--- WARNING ---\n${analysis.warning}`);
        }
        return toolResult(
          parts.join("\n\n") || "Empty response.",
          analysis.hasError,
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
        .describe("Provider ID (e.g. 'anthropic')"),
      modelID: z
        .string()
        .optional()
        .describe("Model ID (e.g. 'claude-3-5-sonnet-20241022')"),
      variant: z.string().optional().describe("Model variant (e.g. 'fast', 'smart')"),
      agent: z.string().optional().describe("Agent to use"),
      format: outputFormatParam,
      directory: directoryParam,
    },
    async ({ sessionId, text, providerID, modelID, variant, agent, format, directory }) => {
      const messageId = createMessageId();
      try {
        const body: Record<string, unknown> = {
          messageID: messageId,
          parts: [{ type: "text", text }],
        };
        const model = selectModel(client, providerID, modelID);
        if (model) body.model = model;
        if (variant || client.getBackendIdentity?.().kind === "v2" && variant !== undefined) body.variant = variant;
        if (agent || client.getBackendIdentity?.().kind === "v2" && agent !== undefined) body.agent = agent;
        if (format) body.format = format;
        await operate(client, "messages.enqueue", { sessionId: sessionId, body: body, ...({ directory }) });
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
      variant: z.string().optional().describe("Model variant"),
      directory: directoryParam,
    },
    async ({
      sessionId,
      command,
      arguments: args,
      agent,
      providerID,
      modelID,
      variant,
      directory,
    }) => {
      try {
        const body: Record<string, unknown> = {
          command,
          arguments: args ?? "",
        };
        if (agent || client.getBackendIdentity?.().kind === "v2" && agent !== undefined) body.agent = agent;
        const cmdModel = selectModel(client, providerID, modelID);
        if (cmdModel) body.model = `${cmdModel.providerID}/${cmdModel.modelID}`;
        if (variant || client.getBackendIdentity?.().kind === "v2" && variant !== undefined) body.variant = variant;
        const result = await operate(client, "messages.command", { sessionId: sessionId, body: body, ...({ directory }) });
        return toolResult(formatMessageResponse(result), (result as { isError?: boolean })?.isError === true, { data: result });
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
        const shellModel = selectModel(client, providerID, modelID);
        if (shellModel) body.model = shellModel;
        const result = await operate(client, "messages.shell", { sessionId: sessionId, body: body, ...({ directory }) });
        return toolResult(formatMessageResponse(result), (result as { isError?: boolean })?.isError === true, { data: result });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
