import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import { toolJson, toolError, formatSessionList, toolResult } from "../helpers.js";

export function registerSessionTools(
  server: McpServer,
  client: OpenCodeClient,
) {
  server.tool(
    "opencode_session_list",
    "List all sessions",
    {},
    async () => {
      try {
        const sessions = (await client.get("/session")) as Array<Record<string, unknown>>;
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
    },
    async ({ parentID, title }) => {
      try {
        const body: Record<string, string> = {};
        if (parentID) body.parentID = parentID;
        if (title) body.title = title;
        return toolJson(await client.post("/session", body));
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
    },
    async ({ id }) => {
      try {
        return toolJson(await client.get(`/session/${id}`));
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
    },
    async ({ id }) => {
      try {
        await client.delete(`/session/${id}`);
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
    },
    async ({ id, title }) => {
      try {
        const body: Record<string, string> = {};
        if (title !== undefined) body.title = title;
        return toolJson(await client.patch(`/session/${id}`, body));
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
    },
    async ({ id }) => {
      try {
        return toolJson(await client.get(`/session/${id}/children`));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_status",
    "Get status for all sessions (running, idle, etc.)",
    {},
    async () => {
      try {
        return toolJson(await client.get("/session/status"));
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
    },
    async ({ id }) => {
      try {
        return toolJson(await client.get(`/session/${id}/todo`));
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
    },
    async ({ id, messageID, providerID, modelID }) => {
      try {
        await client.post(`/session/${id}/init`, { messageID, providerID, modelID });
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
    },
    async ({ id }) => {
      try {
        await client.post(`/session/${id}/abort`);
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
    },
    async ({ id, messageID }) => {
      try {
        const body: Record<string, string> = {};
        if (messageID) body.messageID = messageID;
        return toolJson(await client.post(`/session/${id}/fork`, body));
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
    },
    async ({ id }) => {
      try {
        return toolJson(await client.post(`/session/${id}/share`));
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
    },
    async ({ id }) => {
      try {
        return toolJson(await client.delete(`/session/${id}/share`));
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
    },
    async ({ id, messageID }) => {
      try {
        const query: Record<string, string> = {};
        if (messageID) query.messageID = messageID;
        return toolJson(await client.get(`/session/${id}/diff`, query));
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
    },
    async ({ id, providerID, modelID }) => {
      try {
        await client.post(`/session/${id}/summarize`, { providerID, modelID });
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
    },
    async ({ id, messageID, partID }) => {
      try {
        const body: Record<string, string> = { messageID };
        if (partID) body.partID = partID;
        await client.post(`/session/${id}/revert`, body);
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
    },
    async ({ id }) => {
      try {
        await client.post(`/session/${id}/unrevert`);
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
    },
    async ({ id, permissionID, response, remember }) => {
      try {
        const body: Record<string, unknown> = { response };
        if (remember !== undefined) body.remember = remember;
        await client.post(`/session/${id}/permissions/${permissionID}`, body);
        return toolResult("Permission response sent.");
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
