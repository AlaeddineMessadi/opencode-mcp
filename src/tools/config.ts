import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import { toolJson, toolError, directoryParam } from "../helpers.js";

export function registerConfigTools(server: McpServer, client: OpenCodeClient) {
  server.tool(
    "opencode_config_get",
    "Get the current opencode configuration",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        return toolJson(await client.get("/config", undefined, directory));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_config_update",
    "Update the opencode configuration. Pass a partial config object with fields to update.",
    {
      config: z
        .record(z.string(), z.unknown())
        .describe("Partial config object with fields to update"),
      directory: directoryParam,
    },
    async ({ config, directory }) => {
      try {
        return toolJson(await client.patch("/config", config, directory));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_config_providers",
    "List all configured providers and their default models",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        return toolJson(await client.get("/config/providers", undefined, directory));
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
