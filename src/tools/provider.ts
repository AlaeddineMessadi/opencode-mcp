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
    "List all configured providers with their connection status. Returns a compact summary — use opencode_provider_models to see models for a specific provider.",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        const providers = (await client.get("/provider", undefined, directory)) as Array<
          Record<string, unknown>
        >;
        if (!providers || providers.length === 0) {
          return toolResult("No providers configured.");
        }

        const lines = providers.map((p) => {
          const id = p.id ?? p.name ?? "?";
          const connected =
            p.connected ?? p.authenticated ?? p.status === "connected";
          const models = p.models as Array<Record<string, unknown>> | undefined;
          const modelCount = models?.length ?? 0;
          const status = connected ? "connected" : "not configured";
          return `- ${id}: ${status} (${modelCount} model${modelCount !== 1 ? "s" : ""})`;
        });

        return toolResult(
          `## Providers (${providers.length})\n${lines.join("\n")}\n\nUse \`opencode_provider_models\` with a provider ID to see its models.`,
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_provider_models",
    "List available models for a specific provider. Call opencode_provider_list first to see provider IDs.",
    {
      providerId: z
        .string()
        .describe("Provider ID (e.g. 'anthropic', 'openrouter', 'google')"),
      directory: directoryParam,
    },
    async ({ providerId, directory }) => {
      try {
        const providers = (await client.get("/provider", undefined, directory)) as Array<
          Record<string, unknown>
        >;
        const provider = providers?.find(
          (p) => (p.id ?? p.name) === providerId,
        );

        if (!provider) {
          const available = providers
            ?.map((p) => p.id ?? p.name)
            .join(", ");
          return toolResult(
            `Provider "${providerId}" not found. Available: ${available || "none"}`,
            true,
          );
        }

        const connected =
          provider.connected ??
          provider.authenticated ??
          provider.status === "connected";
        const models = provider.models as
          | Array<Record<string, unknown>>
          | undefined;

        if (!models || models.length === 0) {
          return toolResult(
            `Provider "${providerId}" (${connected ? "connected" : "NOT CONFIGURED"}) has no models available.`,
          );
        }

        const lines = models.map((m) => {
          const id = m.id ?? m.name ?? "?";
          const name = m.name && m.name !== m.id ? ` — ${m.name}` : "";
          return `- ${id}${name}`;
        });

        return toolResult(
          `## ${providerId} (${connected ? "connected" : "NOT CONFIGURED"}) — ${models.length} model${models.length !== 1 ? "s" : ""}\n${lines.join("\n")}`,
        );
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
