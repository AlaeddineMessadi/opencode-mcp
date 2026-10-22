import { z } from "zod";
import { McpServer } from "../mcp-server.js";
import { OpenCodeClient } from "../client.js";
import { toolError, formatSessionList, formatDiffResponse, toolResult, directoryParam, destructive, readOnly } from "../helpers.js";

/** Format a single session object into a compact human-readable summary. */
function formatSession(raw: unknown): string {
  const s = raw as Record<string, unknown>;
  if (!s || typeof s !== "object") return JSON.stringify(raw);
  const lines: string[] = [];
  if (s.id) lines.push(`ID: ${s.id}`);
  if (s.title) lines.push(`Title: ${s.title}`);
  if (s.parentID) lines.push(`Parent: ${s.parentID}`);
  const time = s.time as Record<string, unknown> | undefined;
  if (time?.created) {
    lines.push(`Created: ${new Date(time.created as number).toISOString()}`);
  }
  if (time?.updated) {
    lines.push(`Updated: ${new Date(time.updated as number).toISOString()}`);
  }
  if (s.outcome) lines.push(`Last outcome: ${s.outcome}`);
  const location = s.location as Record<string, unknown> | undefined;
  if (location?.directory) lines.push(`Directory: ${location.directory}`);
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
        const sessions = (await client.get("/api/session", undefined, directory)) as Array<Record<string, unknown>>;
        return toolResult(formatSessionList(sessions), false, { data: sessions });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_create",
    "Create a new session. Optionally provide a parentID, agent, model, and title.",
    {
      parentID: z.string().optional().describe("Parent session ID"),
      title: z.string().optional().describe("Session title"),
      agent: z.string().optional().describe("Agent ID to start the session with"),
      providerID: z.string().optional().describe("Provider ID for the session model"),
      modelID: z.string().optional().describe("Model ID for the session model"),
      directory: directoryParam,
    },
    async ({ parentID, title, agent, providerID, modelID, directory }) => {
      try {
        // OpenCode 2.x binds a session to a location at creation time via the
        // request body; the x-opencode-directory header does not scope creates.
        const body: Record<string, unknown> = {};
        if (parentID) body.parentID = parentID;
        if (title) body.title = title;
        if (agent) body.agent = agent;
        if (providerID && modelID) body.model = { id: modelID, providerID };
        else if (providerID) body.model = { id: "", providerID };
        const session = await client.post("/api/session", { ...body, ...(directory ? { location: { directory } } : {}) }, { directory }) as Record<string, unknown>;
        if (typeof session?.id !== "string") throw new Error("OpenCode returned a session without an ID");
        return toolResult(`Session created.\n\n${formatSession(session)}`, false, { sessionId: session.id, session });
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
        const session = await client.get(`/api/session/${encodeURIComponent(id)}`, undefined, directory);
        return toolResult(formatSession(session), false, { data: session });
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
        await client.delete(`/api/session/${encodeURIComponent(id)}`, undefined, directory);
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
        const updated = await client.patch(`/api/session/${encodeURIComponent(id)}`, body, directory);
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
        // OpenCode 2.x has no dedicated children route; sessions expose
        // parentID, so children are the list filtered by that parent.
        const sessions = (await client.get("/api/session", undefined, directory)) as Array<Record<string, unknown>>;
        const children = sessions.filter((s) => s?.parentID === id);
        if (!children.length) {
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
    "Get running sessions and the last outcome of each session",
    {
      directory: directoryParam,
    },
    readOnly,
    async ({ directory }) => {
      try {
        const [active, sessions] = await Promise.all([
          client.get("/api/session/active", undefined, directory).catch(() => null),
          client.get("/api/session", undefined, directory).catch(() => null),
        ]);
        const running = (active && typeof active === "object" && !Array.isArray(active) ? active : {}) as Record<string, unknown>;
        const runningIDs = Object.keys(running);
        const list = (Array.isArray(sessions) ? sessions : []) as Array<Record<string, unknown>>;
        const byId = new Map(list.map((s) => [s.id as string, s]));
        const lines: string[] = [];
        for (const id of runningIDs) {
          const session = byId.get(id);
          lines.push(`- ${id}: running${session?.title ? ` (${session.title})` : ""}`);
        }
        for (const session of list) {
          if (runningIDs.includes(session.id as string)) continue;
          if (session.outcome) lines.push(`- ${session.id}: ${session.outcome}${session.title ? ` (${session.title})` : ""}`);
        }
        if (lines.length === 0) return toolResult("All sessions idle.", false, { data: { running: runningIDs } });
        return toolResult(`## Session Status\n${lines.join("\n")}`, false, { data: { running: runningIDs } });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_abort",
    "Interrupt a running session",
    {
      id: z.string().describe("Session ID to interrupt"),
      resume: z.enum(["true", "false"]).optional().describe("Whether the session may resume afterwards (default false)"),
      directory: directoryParam,
    },
    async ({ id, resume, directory }) => {
      try {
        const suffix = resume ? `?resume=${resume}` : "";
        await client.post(`/api/session/${encodeURIComponent(id)}/interrupt${suffix}`, undefined, { directory });
        return toolResult(`Session ${id} interrupted.`);
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
      messageID: z.string().optional().describe("Message ID to fork before (optional)"),
      directory: directoryParam,
    },
    async ({ id, messageID, directory }) => {
      try {
        const body: Record<string, string> = {};
        if (messageID) body.before = messageID;
        const forked = await client.post(`/api/session/${encodeURIComponent(id)}/fork`, body, { directory });
        return toolResult(`Session forked.\n\n${formatSession(forked)}`);
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
        if (messageID) query.from = messageID;
        const diffs = await client.get(`/api/session/${encodeURIComponent(id)}/diff`, query, directory);
        return toolResult(formatDiffResponse(diffs as unknown[]));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_summarize",
    "Compact (summarize) a session's history to reclaim context. NOTE: This is a long-running operation.",
    {
      id: z.string().describe("Session ID"),
      directory: directoryParam,
    },
    async ({ id, directory }) => {
      try {
        await client.post(`/api/session/${encodeURIComponent(id)}/compact`, {}, { directory });
        return toolResult("Session compaction started.");
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_revert",
    "Revert a session to a specific message (stages and commits the revert)",
    {
      id: z.string().describe("Session ID"),
      messageID: z.string().describe("Message ID to revert to"),
      files: z.boolean().optional().describe("Also revert file changes (default true)"),
      directory: directoryParam,
    },
    async ({ id, messageID, files, directory }) => {
      try {
        await client.post(`/api/session/${encodeURIComponent(id)}/revert/stage`, { messageID, ...(files !== undefined ? { files } : {}) }, { directory });
        await client.post(`/api/session/${encodeURIComponent(id)}/revert/commit`, undefined, { directory });
        return toolResult(`Session reverted to ${messageID}.`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_session_unrevert",
    "Discard staged (uncommitted) revert changes in a session",
    {
      id: z.string().describe("Session ID"),
      directory: directoryParam,
    },
    async ({ id, directory }) => {
      try {
        await client.delete(`/api/session/${encodeURIComponent(id)}/revert`, undefined, directory);
        return toolResult("Staged revert changes discarded.");
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
        const requests = (await client.get("/api/permission/request", undefined, directory)) as Array<Record<string, unknown>>;
        if (!requests || !Array.isArray(requests) || requests.length === 0) {
          return toolResult("No pending permission requests.");
        }

        const lines = requests.map((r) => {
          const id = r.id ?? "?";
          const session = r.sessionID ?? "?";
          const action = r.action ?? "?";
          const resources = Array.isArray(r.resources) ? (r.resources as string[]).join(", ") : "";
          const message = typeof r.message === "string" ? r.message : "";
          let line = `- **${action}** [${id}] (session: ${session})`;
          if (resources) line += `\n  Resources: ${resources}`;
          if (message) line += `\n  ${message.slice(0, 200)}`;
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
      message: z.string().optional().describe("Optional message accompanying the decision"),
      directory: directoryParam,
    },
    async ({ id, permissionID, reply, message, directory }) => {
      try {
        await client.post(
          `/api/session/${encodeURIComponent(id)}/permission/${encodeURIComponent(permissionID)}/reply`,
          { decision: reply, ...(message !== undefined ? { message } : {}) },
          { directory },
        );
        return toolResult(`Permission ${reply === "reject" ? "rejected" : "approved"} (${reply}).`);
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
        const sessions = (await client.get("/api/session", undefined, directory)) as Array<Record<string, unknown>>;
        if (!sessions || sessions.length === 0) {
          return toolResult("No sessions found.", false, { data: [] });
        }

        const q = query.toLowerCase();
        const matches = sessions.filter((s) => {
          const title = ((s.title ?? "") as string).toLowerCase();
          const id = ((s.id ?? "") as string).toLowerCase();
          return title.includes(q) || id.includes(q);
        });

        if (matches.length === 0) {
          return toolResult(`No sessions matching: "${query}"\n\nTotal sessions: ${sessions.length}. Use \`opencode_session_list\` to see all.`, false, { data: [] });
        }

        return toolResult(
          `## Sessions matching "${query}" (${matches.length}/${sessions.length})\n${formatSessionList(matches)}`, false, { data: matches },
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
