import { McpServer } from "../mcp-server.js";
import { OpenCodeClient } from "../client.js";
import { toolResult, toolError, directoryParam, readOnly } from "../helpers.js";

export function registerGlobalTools(server: McpServer, client: OpenCodeClient) {
  server.tool(
    "opencode_health",
    "Check OpenCode 2.x server health and version",
    {
      directory: directoryParam,
    },
    readOnly,
    async ({ directory }) => {
      try {
        const info = await client.get("/api/info", undefined, directory) as Record<string, unknown>;
        const version = info?.version ?? "unknown";
        const urls = Array.isArray(info?.urls) ? (info.urls as string[]).join(", ") : "unknown";
        return toolResult(`Status: healthy\nVersion: ${version}\nURLs: ${urls}`);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
