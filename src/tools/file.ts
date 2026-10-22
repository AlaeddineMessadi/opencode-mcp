import { z } from "zod";
import { McpServer } from "../mcp-server.js";
import { OpenCodeClient } from "../client.js";
import { toolJson, toolError, toolResult, directoryParam, readOnly } from "../helpers.js";

export function registerFileTools(server: McpServer, client: OpenCodeClient) {
  server.tool(
    "opencode_find_text",
    "Search for files and directories whose path matches a pattern. OpenCode 2.x matches names and paths (no line-level text search).",
    {
      pattern: z
        .string()
        .describe("Text pattern matched against file and directory paths"),
      directory: directoryParam,
    },
    readOnly,
    async ({ pattern, directory }) => {
      try {
        const raw = await client.get("/api/fs/find", { query: pattern }, directory);
        const results = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
        if (results.length === 0) {
          return toolResult(`No matches found for pattern: ${pattern}`, false, { data: [] });
        }
        const formatted = results.map((r) => `${r.type === "directory" ? "[DIR] " : ""}${r.path ?? "?"}`).join("\n");
        return toolResult(`${results.length} match(es):\n\n${formatted}`, false, { data: results });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_find_file",
    "Find files and directories by name",
    {
      query: z.string().describe("Search string for file/directory names"),
      type: z
        .enum(["file", "directory"])
        .optional()
        .describe("Limit results to 'file' or 'directory'"),
      limit: z
        .number()
        .optional()
        .describe("Max number of results (1-200)"),
      directory: directoryParam,
    },
    readOnly,
    async ({ query, type, limit, directory }) => {
      try {
        const q: Record<string, string> = { query };
        if (type) q.type = type;
        if (limit !== undefined) q.limit = String(limit);
        const files = (await client.get("/api/fs/find", q, directory)) as Array<Record<string, unknown>>;
        if (!files || files.length === 0) {
          return toolResult(`No files found matching: ${query}`, false, { data: [] });
        }
        const formatted = files.map((f) => `${f.type === "directory" ? "[DIR] " : ""}${f.path ?? "?"}`).join("\n");
        return toolResult(formatted, false, { data: files });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_file_list",
    "List files and directories at a path",
    {
      path: z
        .string()
        .optional()
        .describe("Relative path to list (defaults to project root)"),
      directory: directoryParam,
    },
    readOnly,
    async ({ path, directory }) => {
      try {
        const q: Record<string, string> = {};
        if (path) q.path = path;
        const nodes = (await client.get("/api/fs/list", q, directory)) as Array<Record<string, unknown>>;
        if (!nodes || nodes.length === 0) {
          return toolResult("Empty directory.");
        }
        const formatted = nodes.map((n) => {
          const type = n.type === "directory" ? "[DIR]" : "     ";
          return `${type} ${n.path ?? "?"}`;
        }).join("\n");
        return toolResult(formatted);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_file_read",
    "Read the content of a file relative to the project root",
    {
      path: z.string().describe("File path to read, relative to the project root"),
      directory: directoryParam,
    },
    readOnly,
    async ({ path, directory }) => {
      try {
        const result = await client.get(`/api/fs/read/${path.split("/").map(encodeURIComponent).join("/")}`, undefined, directory);
        if (typeof result === "string") {
          return toolResult(`File: ${path}\n\n${result}`, false, { data: result });
        }
        return toolJson(result);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_file_status",
    "Get status for tracked files (VCS changes: modified, added, deleted)",
    {
      directory: directoryParam,
    },
    readOnly,
    async ({ directory }) => {
      try {
        const files = (await client.get("/api/vcs/status", undefined, directory)) as Array<Record<string, unknown>>;
        if (!files || files.length === 0) {
          return toolResult("No tracked file changes.");
        }
        const formatted = files.map((f) => {
          const status = f.status ?? "?";
          const path = f.file ?? f.path ?? "?";
          const additions = typeof f.additions === "number" ? ` (+${f.additions}` : "";
          const deletions = typeof f.deletions === "number" ? ` -${f.deletions})` : "";
          return `[${status}] ${path}${additions || deletions ? `${additions}${deletions}` : ""}`;
        }).join("\n");
        return toolResult(formatted);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
