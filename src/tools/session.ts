import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import { toolJson, toolError, formatSessionList, toolResult, directoryParam } from "../helpers.js";

export function registerSessionTools(
  server: McpServer,
  client: OpenCodeClient,
) {
  server.tool(
    "opencode_session_list",
    "List all sessions",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        const sessions = (await client.get("/session", undefined, directory)) as Array<Record<string, unknown>>;
        return toolResult(formatSessionList(sessions));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_create",
    "Create a new session. Optionally provide a parentID to create a child session, and a title.",
    {
      parentID: z.string().optional().describe("Parent session ID"),
      title: z.string().optional().describe("Session title"),
      directory: directoryParam,
    },
    async ({ parentID, title, directory }) => {
      try {
        const body: Record<string, string> = {};
        if (parentID) body.parentID = parentID;
        if (title) body.title = title;
        return toolJson(await client.post("/session", body, { directory }));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_get",
    "Get details of a specific session by ID",
    {
      id: z.string().describe("Session ID"),
      directory: directoryParam,
    },
    async ({ id, directory }) => {
      try {
        return toolJson(await client.get(`/session/${id}`, undefined, directory));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_delete",
    "Delete a session and all its data",
    {
      id: z.string().describe("Session ID to delete"),
      directory: directoryParam,
    },
    async ({ id, directory }) => {
      try {
        await client.delete(`/session/${id}`, undefined, directory);
        return toolResult(`Session ${id} deleted.`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_update",
    "Update session properties (e.g. title)",
    {
      id: z.string().describe("Session ID"),
      title: z.string().optional().describe("New title for the session"),
      directory: directoryParam,
    },
    async ({ id, title, directory }) => {
      try {
        const body: Record<string, string> = {};
        if (title !== undefined) body.title = title;
        return toolJson(await client.patch(`/session/${id}`, body, directory));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_children",
    "Get child sessions of a session",
    {
      id: z.string().describe("Parent session ID"),
      directory: directoryParam,
    },
    async ({ id, directory }) => {
      try {
        return toolJson(await client.get(`/session/${id}/children`, undefined, directory));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_status",
    "Get status for all sessions (running, idle, etc.)",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        return toolJson(await client.get("/session/status", undefined, directory));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_todo",
    "Get the todo list for a session",
    {
      id: z.string().describe("Session ID"),
      directory: directoryParam,
    },
    async ({ id, directory }) => {
      try {
        return toolJson(await client.get(`/session/${id}/todo`, undefined, directory));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_init",
    "Analyze the app and create AGENTS.md for a session",
    {
      id: z.string().describe("Session ID"),
      messageID: z.string().describe("Message ID"),
      providerID: z.string().describe("Provider ID (e.g. 'anthropic')"),
      modelID: z.string().describe("Model ID (e.g. 'claude-3-5-sonnet-20241022')"),
      directory: directoryParam,
    },
    async ({ id, messageID, providerID, modelID, directory }) => {
      try {
        await client.post(`/session/${id}/init`, { messageID, providerID, modelID }, { directory });
        return toolResult("AGENTS.md initialization started.");
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_abort",
    "Abort a running session",
    {
      id: z.string().describe("Session ID to abort"),
      directory: directoryParam,
    },
    async ({ id, directory }) => {
      try {
        await client.post(`/session/${id}/abort`, undefined, { directory });
        return toolResult(`Session ${id} aborted.`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_fork",
    "Fork an existing session, optionally at a specific message",
    {
      id: z.string().describe("Session ID to fork"),
      messageID: z.string().optional().describe("Message ID to fork at (optional)"),
      directory: directoryParam,
    },
    async ({ id, messageID, directory }) => {
      try {
        const body: Record<string, string> = {};
        if (messageID) body.messageID = messageID;
        return toolJson(await client.post(`/session/${id}/fork`, body, { directory }));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_share",
    "Share a session publicly",
    {
      id: z.string().describe("Session ID to share"),
      directory: directoryParam,
    },
    async ({ id, directory }) => {
      try {
        return toolJson(await client.post(`/session/${id}/share`, undefined, { directory }));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_unshare",
    "Unshare a previously shared session",
    {
      id: z.string().describe("Session ID to unshare"),
      directory: directoryParam,
    },
    async ({ id, directory }) => {
      try {
        return toolJson(await client.delete(`/session/${id}/share`, undefined, directory));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_diff",
    "Get the diff for a session, optionally for a specific message",
    {
      id: z.string().describe("Session ID"),
      messageID: z.string().optional().describe("Message ID (optional)"),
      directory: directoryParam,
    },
    async ({ id, messageID, directory }) => {
      try {
        const query: Record<string, string> = {};
        if (messageID) query.messageID = messageID;
        return toolJson(await client.get(`/session/${id}/diff`, query, directory));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_summarize",
    "Summarize a session using a specified model",
    {
      id: z.string().describe("Session ID"),
      providerID: z.string().describe("Provider ID (e.g. 'anthropic')"),
      modelID: z.string().describe("Model ID (e.g. 'claude-3-5-sonnet-20241022')"),
      directory: directoryParam,
    },
    async ({ id, providerID, modelID, directory }) => {
      try {
        await client.post(`/session/${id}/summarize`, { providerID, modelID }, { directory });
        return toolResult("Session summarization started.");
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_revert",
    "Revert a message in a session",
    {
      id: z.string().describe("Session ID"),
      messageID: z.string().describe("Message ID to revert"),
      partID: z.string().optional().describe("Part ID to revert (optional)"),
      directory: directoryParam,
    },
    async ({ id, messageID, partID, directory }) => {
      try {
        const body: Record<string, string> = { messageID };
        if (partID) body.partID = partID;
        await client.post(`/session/${id}/revert`, body, { directory });
        return toolResult(`Message ${messageID} reverted.`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_unrevert",
    "Restore all reverted messages in a session",
    {
      id: z.string().describe("Session ID"),
      directory: directoryParam,
    },
    async ({ id, directory }) => {
      try {
        await client.post(`/session/${id}/unrevert`, undefined, { directory });
        return toolResult("All reverted messages restored.");
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_permission",
    "Respond to a permission request in a session",
    {
      id: z.string().describe("Session ID"),
      permissionID: z.string().describe("Permission request ID"),
      response: z.string().describe("Response to the permission request"),
      remember: z.boolean().optional().describe("Whether to remember this decision"),
      directory: directoryParam,
    },
    async ({ id, permissionID, response, remember, directory }) => {
      try {
        const body: Record<string, unknown> = { response };
        if (remember !== undefined) body.remember = remember;
        await client.post(`/session/${id}/permissions/${permissionID}`, body, { directory });
        return toolResult("Permission response sent.");
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
