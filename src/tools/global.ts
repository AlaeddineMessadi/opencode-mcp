import { McpServer } from "../mcp-server.js";
import { OpenCodeClient } from "../client.js";
import { toolResult, toolError, directoryParam, readOnly } from "../helpers.js";

export function registerGlobalTools(server: McpServer, client: OpenCodeClient) {
  server.tool(
    "opencode_health",
    "Check server health and version",
    {
      directory: directoryParam,
    },
    readOnly,
    async ({ directory }) => {
      try {
        const raw = await client.get("/global/health", undefined, directory) as Record<string, unknown>;
        const status = raw.healthy ? "healthy" : "unhealthy";
        const version = raw.version ?? "unknown";
        return toolResult(`Status: ${status}\nVersion: ${version}`);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
