import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import { toolJson, toolError } from "../helpers.js";

export function registerGlobalTools(server: McpServer, client: OpenCodeClient) {
  server.tool(
    "opencode_health",
    "Check server health and version",
    {},
    async () => {
      try {
        return toolJson(await client.get("/global/health"));
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
