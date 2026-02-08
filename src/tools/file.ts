import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import { toolJson, toolError, toolResult, directoryParam } from "../helpers.js";

export function registerFileTools(server: McpServer, client: OpenCodeClient) {
  server.tool(
    "opencode_find_text",
    "Search for text patterns in project files (regex supported). Returns file paths, line numbers, and matching lines.",
    {
      pattern: z
        .string()
        .describe("Text or regex pattern to search for in files"),
      directory: directoryParam,
    },
    async ({ pattern, directory }) => {
      try {
        const results = (await client.get("/find", { pattern }, directory)) as Array<Record<string, unknown>>;
        if (!results || results.length === 0) {
          return toolResult(`No matches found for pattern: ${pattern}`);
        }
        const formatted = results.map((r) => {
          const path = r.path ?? "";
          const lineNum = r.line_number ?? "?";
          const lines = r.lines ?? "";
          return `${path}:${lineNum}  ${typeof lines === "string" ? lines.trim() : JSON.stringify(lines)}`;
        }).join("\n");
        return toolResult(`${results.length} match(es):\n\n${formatted}`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_find_file",
    "Find files and directories by name (fuzzy match)",
    {
      query: z.string().describe("Search string for file/directory names"),
      type: z
        .enum(["file", "directory"])
        .optional()
        .describe("Limit results to 'file' or 'directory'"),
      searchDirectory: z
        .string()
        .optional()
        .describe("Override the project root for the search"),
      limit: z
        .number()
        .optional()
        .describe("Max number of results (1-200)"),
      directory: directoryParam,
    },
    async ({ query, type, searchDirectory, limit, directory }) => {
      try {
        const q: Record<string, string> = { query };
        if (type) q.type = type;
        if (searchDirectory) q.directory = searchDirectory;
        if (limit !== undefined) q.limit = String(limit);
        const files = (await client.get("/find/file", q, directory)) as string[];
        if (!files || files.length === 0) {
          return toolResult(`No files found matching: ${query}`);
        }
        return toolResult(files.join("\n"));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_find_symbol",
    "Find workspace symbols by name (functions, classes, variables, etc.)",
    {
      query: z.string().describe("Symbol name to search for"),
      directory: directoryParam,
    },
    async ({ query, directory }) => {
      try {
        return toolJson(await client.get("/find/symbol", { query }, directory));
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
        .describe("Path to list (defaults to project root)"),
      directory: directoryParam,
    },
    async ({ path, directory }) => {
      try {
        const q: Record<string, string> = {};
        if (path) q.path = path;
        const nodes = (await client.get("/file", q, directory)) as Array<Record<string, unknown>>;
        if (!nodes || nodes.length === 0) {
          return toolResult("Empty directory.");
        }
        const formatted = nodes.map((n) => {
          const type = n.type === "directory" ? "[DIR]" : "     ";
          return `${type} ${n.name ?? n.path ?? "?"}`;
        }).join("\n");
        return toolResult(formatted);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_file_read",
    "Read the content of a file",
    {
      path: z.string().describe("File path to read"),
      directory: directoryParam,
    },
    async ({ path, directory }) => {
      try {
        const result = (await client.get("/file/content", { path }, directory)) as Record<string, unknown>;
        if (typeof result.content === "string") {
          return toolResult(`File: ${path}\n\n${result.content}`);
        }
        return toolJson(result);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_file_status",
    "Get status for tracked files (VCS changes: modified, added, deleted, etc.)",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        const files = (await client.get("/file/status", undefined, directory)) as Array<Record<string, unknown>>;
        if (!files || files.length === 0) {
          return toolResult("No tracked file changes.");
        }
        const formatted = files.map((f) => {
          const status = f.status ?? f.type ?? "?";
          const path = f.path ?? f.file ?? "?";
          return `[${status}] ${path}`;
        }).join("\n");
        return toolResult(formatted);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
