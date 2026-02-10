import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import { toolError, formatSessionList, formatDiffResponse, resolveSessionStatus, toolResult, directoryParam, destructive, readOnly } from "../helpers.js";

/** Format a single session object into a compact human-readable summary. */
function formatSession(raw: unknown): string {
  const s = raw as Record<string, unknown>;
  if (!s || typeof s !== "object") return JSON.stringify(raw);
  const lines: string[] = [];
  if (s.id) lines.push(`ID: ${s.id}`);
  if (s.title) lines.push(`Title: ${s.title}`);
  if (s.slug) lines.push(`Slug: ${s.slug}`);
  if (s.parentID) lines.push(`Parent: ${s.parentID}`);
  // Time field may be {created, updated} timestamps (ms since epoch)
  const time = s.time as Record<string, unknown> | undefined;
  if (time?.created) {
    lines.push(`Created: ${new Date(time.created as number).toISOString()}`);
  } else if (s.createdAt) {
    lines.push(`Created: ${s.createdAt}`);
  }
  if (time?.updated) {
    lines.push(`Updated: ${new Date(time.updated as number).toISOString()}`);
  } else if (s.updatedAt) {
    lines.push(`Updated: ${s.updatedAt}`);
  }
  if (s.status) lines.push(`Status: ${s.status}`);
  if (s.version) lines.push(`Version: ${s.version}`);
  if (s.directory) lines.push(`Directory: ${s.directory}`);
  if (s.shareUrl) lines.push(`Share URL: ${s.shareUrl}`);
  // Show summary if present
  const summary = s.summary as Record<string, unknown> | string | undefined;
  if (summary) {
    const text = typeof summary === "string" ? summary : (summary as Record<string, unknown>)?.text;
    if (text) lines.push(`Summary: ${String(text).slice(0, 200)}`);
  }
  return lines.length > 0 ? lines.join("\n") : JSON.stringify(raw);
}

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
    readOnly,
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
        const session = await client.post("/session", body, { directory });
        return toolResult(`Session created.\n\n${formatSession(session)}`);
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
    readOnly,
    async ({ id, directory }) => {
      try {
        const session = await client.get(`/session/${id}`, undefined, directory);
        return toolResult(formatSession(session));
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
    destructive,
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
        const updated = await client.patch(`/session/${id}`, body, directory);
        return toolResult(formatSession(updated));
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
    readOnly,
    async ({ id, directory }) => {
      try {
        const children = (await client.get(`/session/${id}/children`, undefined, directory)) as unknown[];
        if (!children || !Array.isArray(children) || children.length === 0) {
          return toolResult("No child sessions found.");
        }
        return toolResult(formatSessionList(children));
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
    readOnly,
    async ({ directory }) => {
      try {
        const raw = await client.get("/session/status", undefined, directory);
        const statuses = raw && typeof raw === "object" && !Array.isArray(raw)
          ? raw as Record<string, unknown>
          : {};
        const entries = Object.entries(statuses);
        if (entries.length === 0) {
          return toolResult("All sessions idle.");
        }
        const lines = entries.map(([id, status]) => `- ${id}: ${resolveSessionStatus(status)}`);
        return toolResult(`## Session Status (${entries.length})\n${lines.join("\n")}`);
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
    readOnly,
    async ({ id, directory }) => {
      try {
        const raw = await client.get(`/session/${id}/todo`, undefined, directory);
        const todos = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
        if (todos.length === 0) {
          return toolResult("No todos for this session.");
        }
        const lines = todos.map((t) => {
          const done = t.status === "completed" || t.done === true || t.completed === true;
          const check = done ? "[x]" : "[ ]";
          const content = t.content ?? t.title ?? t.text ?? t.description ?? "?";
          const priority = t.priority ? ` (${t.priority})` : "";
          return `- ${check} ${content}${priority}`;
        });
        const completed = todos.filter((t) => t.status === "completed" || t.done === true || t.completed === true).length;
        return toolResult(`## Todos (${completed}/${todos.length} done)\n${lines.join("\n")}`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_init",
    "Analyze the app and create AGENTS.md for a session. NOTE: This is a long-running operation that may take 30-60+ seconds depending on project size.",
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
        const forked = await client.post(`/session/${id}/fork`, body, { directory });
        return toolResult(`Session forked.\n\n${formatSession(forked)}`);
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
        const result = await client.post(`/session/${id}/share`, undefined, { directory });
        const r = result as Record<string, unknown>;
        // API may return share URL in different locations
        const shareUrl = r.shareUrl ?? (r.share as Record<string, unknown> | undefined)?.url ?? null;
        const header = shareUrl ? `Session shared.\nURL: ${shareUrl}` : "Session shared.";
        return toolResult(`${header}\n\n${formatSession(result)}`);
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
        await client.delete(`/session/${id}/share`, undefined, directory);
        return toolResult(`Session ${id} unshared.`);
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
        const diffs = await client.get(`/session/${id}/diff`, query, directory);
        return toolResult(formatDiffResponse(diffs as unknown[]));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_summarize",
    "Summarize a session using a specified model. NOTE: This is a long-running operation that may take 30-60+ seconds.",
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

  // ─── Permission: list pending ─────────────────────────────────────────
  server.tool(
    "opencode_permission_list",
    "List all pending permission requests across all sessions. When a session is blocked waiting for approval (e.g. to run a shell command or access a file outside the project), it appears here. Respond with `opencode_session_permission`.",
    {
      directory: directoryParam,
    },
    readOnly,
    async ({ directory }) => {
      try {
        const requests = (await client.get("/permission", undefined, directory)) as Array<Record<string, unknown>>;
        if (!requests || !Array.isArray(requests) || requests.length === 0) {
          return toolResult("No pending permission requests.");
        }

        const lines = requests.map((r) => {
          const id = r.id ?? "?";
          const session = r.sessionID ?? "?";
          const perm = r.permission ?? "?";
          const patterns = Array.isArray(r.patterns) ? (r.patterns as string[]).join(", ") : "";
          const tool = r.tool as Record<string, unknown> | undefined;
          const toolName = tool?.name ?? tool?.tool ?? "";
          let line = `- **${perm}** [${id}] (session: ${session})`;
          if (toolName) line += `\n  Tool: ${toolName}`;
          if (patterns) line += `\n  Patterns: ${patterns}`;
          // Show what "always" would approve
          const always = Array.isArray(r.always) ? (r.always as string[]).join(", ") : "";
          if (always) line += `\n  Always would approve: ${always}`;
          return line;
        });

        return toolResult(
          `## Pending Permission Requests (${requests.length})\n\n` +
          lines.join("\n\n") +
          `\n\nRespond with: \`opencode_session_permission({id: "SESSION_ID", permissionID: "PERM_ID", reply: "once"|"always"|"reject"})\``
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Permission: respond ──────────────────────────────────────────────
  server.tool(
    "opencode_session_permission",
    "Respond to a permission request in a session. Use `opencode_permission_list` to see pending requests. Reply values: 'once' (approve this request only), 'always' (approve this + future matching requests for this session), 'reject' (deny the request).",
    {
      id: z.string().describe("Session ID"),
      permissionID: z.string().describe("Permission request ID"),
      reply: z.enum(["once", "always", "reject"]).describe("Response to the permission request: 'once' to approve once, 'always' to auto-approve matching future requests, 'reject' to deny"),
      directory: directoryParam,
    },
    async ({ id, permissionID, reply, directory }) => {
      try {
        // Try the new API first (POST /permission/{requestID}/reply)
        try {
          await client.post(`/permission/${permissionID}/reply`, { reply }, { directory });
          return toolResult(`Permission ${reply === "reject" ? "rejected" : "approved"} (${reply}).`);
        } catch {
          // Fall back to the deprecated session-scoped endpoint
          await client.post(`/session/${id}/permissions/${permissionID}`, { response: reply }, { directory });
          return toolResult(`Permission ${reply === "reject" ? "rejected" : "approved"} (${reply}).`);
        }
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Session search ─────────────────────────────────────────────────
  server.tool(
    "opencode_session_search",
    "Search sessions by keyword in title. Useful for finding a specific session among many.",
    {
      query: z.string().describe("Search keyword (case-insensitive match on session title)"),
      directory: directoryParam,
    },
    readOnly,
    async ({ query, directory }) => {
      try {
        const sessions = (await client.get("/session", undefined, directory)) as Array<Record<string, unknown>>;
        if (!sessions || sessions.length === 0) {
          return toolResult("No sessions found.");
        }

        const q = query.toLowerCase();
        const matches = sessions.filter((s) => {
          const title = ((s.title ?? "") as string).toLowerCase();
          const id = ((s.id ?? "") as string).toLowerCase();
          return title.includes(q) || id.includes(q);
        });

        if (matches.length === 0) {
          return toolResult(`No sessions matching: "${query}"\n\nTotal sessions: ${sessions.length}. Use \`opencode_session_list\` to see all.`);
        }

        return toolResult(
          `## Sessions matching "${query}" (${matches.length}/${sessions.length})\n${formatSessionList(matches)}`,
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
