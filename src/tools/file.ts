import { operate } from "../backends/adapter.js";
import { z } from "zod";
import { McpServer } from "../mcp-server.js";
import { OpenCodeClient } from "../client.js";
import { toolJson, toolError, toolResult, directoryParam, readOnly } from "../helpers.js";

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
    readOnly,
    async ({ pattern, directory }) => {
      try {
        const raw = await operate(client, "files.findText", { query: { pattern }, directory: directory });
        const results = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
        if (results.length === 0) {
          return toolResult(`No matches found for pattern: ${pattern}`, false, { data: [] });
        }
        const formatted = results.map((r) => {
          // The API returns path as {text: "file.ts"} and lines as {text: "content\n"}
          const rawPath = r.path ?? r.file ?? r.name ?? "";
          const filePath = typeof rawPath === "string"
            ? rawPath
            : (rawPath as Record<string, unknown>)?.text ?? (rawPath as Record<string, unknown>)?.path ?? (rawPath as Record<string, unknown>)?.name ?? String(rawPath);
          const lineNum = r.line_number ?? r.lineNumber ?? r.line ?? "?";
          const rawLines = r.lines ?? r.text ?? r.content ?? "";
          const lineText = typeof rawLines === "string"
            ? rawLines.trim()
            : (rawLines as Record<string, unknown>)?.text != null
              ? String((rawLines as Record<string, unknown>).text).trim()
              : JSON.stringify(rawLines);
          return `${filePath}:${lineNum}  ${lineText}`;
        }).join("\n");
        return toolResult(`${results.length} match(es):\n\n${formatted}`, false, { data: results });
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
    readOnly,
    async ({ query, type, searchDirectory, limit, directory }) => {
      try {
        const q: Record<string, string> = { query };
        if (type) q.type = type;
        if (searchDirectory) q.directory = searchDirectory;
        if (limit !== undefined) q.limit = String(limit);
        const files = (await operate(client, "files.find", { query: q, directory: directory })) as string[];
        if (!files || files.length === 0) {
          return toolResult(`No files found matching: ${query}`, false, { data: [] });
        }
        return toolResult(files.join("\n"), false, { data: files });
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
    readOnly,
    async ({ query, directory }) => {
      try {
        const raw = await operate(client, "files.findSymbol", { query: { query }, directory: directory });
        const symbols = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
        if (symbols.length === 0) {
          return toolResult(`No symbols found matching: ${query}`, false, { data: [] });
        }
        const lines = symbols.map((s) => {
          const name = s.name ?? s.symbol ?? "?";
          const kind = s.kind ? ` (${s.kind})` : "";
          const location = s.location && typeof s.location === "object"
            ? s.location as { uri?: string; range?: { start?: { line?: number } } }
            : undefined;
          const loc = location?.uri ?? (typeof s.location === "string" ? s.location : s.path ?? s.file ?? "");
          const line = typeof location?.range?.start?.line === "number"
            ? location.range.start.line + 1 : s.line ?? s.lineNumber ?? "";
          const locStr = loc ? ` — ${loc}${line ? `:${line}` : ""}` : "";
          return `- ${name}${kind}${locStr}`;
        });
        return toolResult(`${symbols.length} symbol(s) matching "${query}":\n\n${lines.join("\n")}`, false, { data: symbols });
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
    readOnly,
    async ({ path, directory }) => {
      try {
        const q: Record<string, string> = { path: path || "." };
        const nodes = (await operate(client, "files.list", { query: q, directory: directory })) as Array<Record<string, unknown>>;
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
    readOnly,
    async ({ path, directory }) => {
      try {
        const result = (await operate(client, "files.read", { query: { path }, directory: directory })) as Record<string, unknown>;
        if (typeof result.content === "string") {
          return toolResult(`File: ${path}\n\n${result.content}`, false, { data: result });
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
    readOnly,
    async ({ directory }) => {
      try {
        const files = (await operate(client, "files.status", { directory: directory })) as Array<Record<string, unknown>>;
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
