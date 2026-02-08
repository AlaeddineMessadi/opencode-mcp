import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import { toolJson, toolError, toolResult, directoryParam } from "../helpers.js";

export function registerProviderTools(
  server: McpServer,
  client: OpenCodeClient,
) {
  server.tool(
    "opencode_provider_list",
    "List all providers, default models, and connected providers",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        return toolJson(await client.get("/provider", undefined, directory));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_provider_auth_methods",
    "Get available authentication methods for all providers",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        return toolJson(await client.get("/provider/auth", undefined, directory));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // Auth routes run OUTSIDE the directory middleware in the OpenCode server,
  // so these tools do not accept a directory parameter.

  server.tool(
    "opencode_provider_oauth_authorize",
    "Start OAuth authorization for a provider",
    {
      providerId: z.string().describe("Provider ID to authorize"),
    },
    async ({ providerId }) => {
      try {
        return toolJson(
          await client.post(`/provider/${providerId}/oauth/authorize`),
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_provider_oauth_callback",
    "Handle OAuth callback for a provider",
    {
      providerId: z.string().describe("Provider ID"),
      callbackData: z
        .record(z.string(), z.unknown())
        .describe("OAuth callback data"),
    },
    async ({ providerId, callbackData }) => {
      try {
        await client.post(
          `/provider/${providerId}/oauth/callback`,
          callbackData,
        );
        return toolResult("OAuth callback processed.");
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_auth_set",
    "Set authentication credentials for a provider (e.g. API key). Credentials are stored globally and shared across all projects.",
    {
      providerId: z.string().describe("Provider ID (e.g. 'anthropic')"),
      type: z.string().describe("Auth type (e.g. 'api')"),
      key: z.string().describe("API key or credential value"),
    },
    async ({ providerId, type, key }) => {
      try {
        await client.put(`/auth/${providerId}`, { type, key });
        return toolResult(`Auth credentials set for ${providerId}.`);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
