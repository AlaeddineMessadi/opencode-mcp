import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import { toolJson, toolError, directoryParam } from "../helpers.js";

export function registerProjectTools(
  server: McpServer,
  client: OpenCodeClient,
) {
  server.tool(
    "opencode_project_list",
    "List all projects known to the opencode server",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        return toolJson(await client.get("/project", undefined, directory));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_project_current",
    "Get the current active project",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        return toolJson(await client.get("/project/current", undefined, directory));
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
