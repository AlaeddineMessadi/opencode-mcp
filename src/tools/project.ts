import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import { toolJson, toolError } from "../helpers.js";

export function registerProjectTools(
  server: McpServer,
  client: OpenCodeClient,
) {
  server.tool(
    "opencode_project_list",
    "List all projects known to the opencode server",
    {},
    async () => {
      try {
        return toolJson(await client.get("/project"));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_project_current",
    "Get the current active project",
    {},
    async () => {
      try {
        return toolJson(await client.get("/project/current"));
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
