import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import { toolJson, toolError, directoryParam } from "../helpers.js";

export function registerGlobalTools(server: McpServer, client: OpenCodeClient) {
  server.tool(
    "opencode_health",
    "Check server health and version",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        return toolJson(await client.get("/global/health", undefined, directory));
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
