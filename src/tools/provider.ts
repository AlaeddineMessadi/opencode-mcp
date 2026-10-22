import { z } from "zod";
import { McpServer } from "../mcp-server.js";
import { OpenCodeClient } from "../client.js";
import { toolJson, toolError, toolResult, directoryParam } from "../helpers.js";

/**
 * A v2 provider is usable when an active credential exists for its integration
 * or its settings carry an API key.
 */
function providerHasCredential(
  provider: Record<string, unknown>,
  credentials: Array<Record<string, unknown>>,
): boolean {
  const integrationID = typeof provider.integrationID === "string" ? provider.integrationID : provider.id;
  if (credentials.some((c) => c.active === true && (c.integrationID === integrationID || c.integrationID === provider.id))) return true;
  const settings = provider.settings as Record<string, unknown> | undefined;
  return typeof settings?.apiKey === "string" && settings.apiKey.length > 0;
}

export function registerProviderTools(
  server: McpServer,
  client: OpenCodeClient,
) {
  server.tool(
    "opencode_provider_list",
    "List all providers with their configuration status. Returns a compact summary — use opencode_provider_models to see models for a specific provider.",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        const [providersRaw, credentialsRaw] = await Promise.all([
          client.get("/api/provider", undefined, directory).catch(() => null),
          client.get("/api/credential", undefined, directory).catch(() => null),
        ]);
        const providers = (Array.isArray(providersRaw) ? providersRaw : []) as Array<Record<string, unknown>>;
        const credentials = (Array.isArray(credentialsRaw) ? credentialsRaw : []) as Array<Record<string, unknown>>;

        if (providers.length === 0) {
          return toolResult("No providers configured.");
        }

        const configured = providers.filter((p) => providerHasCredential(p, credentials));
        const unconfigured = providers.filter((p) => !providerHasCredential(p, credentials));

        const lines: string[] = [];
        if (configured.length > 0) {
          lines.push("**Configured:**");
          for (const p of configured) {
            const activation = typeof p.activation === "string" ? ` [${p.activation}]` : "";
            lines.push(`- ${p.id}${activation}`);
          }
        } else {
          lines.push("**No providers configured.** Use `opencode_auth_set` or OAuth via `opencode_provider_oauth_authorize`.");
        }

        if (unconfigured.length > 0) {
          lines.push(`\n**Not configured:** ${unconfigured.length} more providers available`);
          const popularIds = new Set(["anthropic", "openai", "google", "openrouter", "groq", "deepseek", "mistral"]);
          const popular = unconfigured.filter((p) => popularIds.has(p.id as string)).slice(0, 5);
          for (const p of popular) lines.push(`- ${p.id}`);
          const rest = unconfigured.length - popular.length;
          if (rest > 0) lines.push(`- ... and ${rest} more`);
        }

        return toolResult(
          `## Providers (${configured.length} configured / ${providers.length} total)\n${lines.join("\n")}\n\nUse \`opencode_provider_models\` with a provider ID to see its models.`,
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
      limit: z
        .number()
        .optional()
        .describe("Max models to show (default 30). Use 0 for all."),
      directory: directoryParam,
    },
    async ({ providerId, limit, directory }) => {
      try {
        const [modelsRaw, providersRaw] = await Promise.all([
          client.get("/api/model", undefined, directory),
          client.get("/api/provider", undefined, directory).catch(() => null),
        ]);
        const providers = (Array.isArray(providersRaw) ? providersRaw : []) as Array<Record<string, unknown>>;
        if (!providers.some((p) => p.id === providerId)) {
          const allIds = providers.map((p) => p.id);
          const shown = allIds.slice(0, 10);
          const rest = allIds.length - shown.length;
          const available = shown.join(", ") + (rest > 0 ? ` ... and ${rest} more` : "");
          return toolResult(
            `Provider "${providerId}" not found. Available: ${available || "none"}\n\nUse \`opencode_provider_list\` to see all providers.`,
            true,
          );
        }

        const models = (Array.isArray(modelsRaw) ? modelsRaw : []) as Array<Record<string, unknown>>;
        const modelList = models.filter((m) => m.providerID === providerId);
        if (modelList.length === 0) {
          return toolResult(`Provider "${providerId}" has no models available.`);
        }

        const maxItems = limit === 0 ? modelList.length : (limit ?? 30);
        const shown = modelList.slice(0, maxItems);
        const lines = shown.map((m) => {
          const id = m.id ?? m.modelID ?? "?";
          const name = m.name && m.name !== m.id ? ` — ${m.name}` : "";
          return `- ${id}${name}`;
        });
        const truncNote = modelList.length > maxItems
          ? `\n\n... and ${modelList.length - maxItems} more. Use \`limit: 0\` to see all.`
          : "";

        return toolResult(
          `## ${providerId} — ${modelList.length} model${modelList.length !== 1 ? "s" : ""}\n${lines.join("\n")}${truncNote}`,
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_provider_auth_methods",
    "List integrations and the connection methods they support (API key, environment variable, OAuth, command). Provider IDs map to integration IDs.",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        const raw = await client.get("/api/integration", undefined, directory);
        const integrations = (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown>>;
        if (integrations.length === 0) {
          return toolResult("No integrations available.");
        }
        const lines = integrations.map((integration) => {
          const methods = (Array.isArray(integration.methods) ? integration.methods : []) as Array<Record<string, unknown>>;
          const connections = (Array.isArray(integration.connections) ? integration.connections : []) as Array<Record<string, unknown>>;
          const methodDescs = methods.map((m) => {
            if (m.type === "env") return `env(${(m.names as string[] | undefined)?.join(", ") ?? ""})`;
            return String(m.type ?? "?");
          });
          return `- ${integration.id}: ${methodDescs.join(", ") || "none"}${connections.length ? ` (${connections.length} connection(s))` : ""}`;
        });
        return toolResult(`## Integrations (${integrations.length})\n${lines.join("\n")}`, false, { data: raw });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // Integration routes are addressed by integration ID (provider IDs map to the
  // same value in most cases), so these tools do not take a directory.

  server.tool(
    "opencode_provider_oauth_authorize",
    "Start OAuth authorization for a provider's integration",
    {
      providerId: z.string().describe("Provider/integration ID to authorize"),
      methodID: z.string().optional().describe("Specific method ID to use (defaults to the first OAuth method)"),
    },
    async ({ providerId, methodID }) => {
      try {
        let method = methodID;
        if (!method) {
          // The server requires a methodID; default to the integration's first OAuth method.
          const integrations = await client.get<Array<{ id?: string; methods?: Array<{ id?: string; type?: string }> }>>("/api/integration");
          const entry = Array.isArray(integrations) ? integrations.find((item) => item?.id === providerId) : undefined;
          method = entry?.methods?.find((item) => item?.type === "oauth" && item.id)?.id;
          if (!method) throw new Error(`No OAuth method is available for ${providerId}; pass methodID or see opencode_provider_auth_methods.`);
        }
        return toolJson(
          await client.post(`/api/integration/${encodeURIComponent(providerId)}/connect/oauth`, { methodID: method }),
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_provider_oauth_callback",
    "Complete OAuth authorization for a provider's integration with the callback code",
    {
      providerId: z.string().describe("Provider/integration ID"),
      attemptID: z.string().describe("Authorization attempt ID returned by opencode_provider_oauth_authorize"),
      code: z.string().optional().describe("Authorization code (when the redirect supplies one)"),
    },
    async ({ providerId, attemptID, code }) => {
      try {
        await client.post(
          `/api/integration/${encodeURIComponent(providerId)}/connect/oauth/${encodeURIComponent(attemptID)}/complete`,
          code !== undefined ? { code } : {},
        );
        return toolResult("OAuth callback processed.");
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_auth_set",
    "Set an API key credential for a provider's integration. Credentials are stored globally and shared across all projects.",
    {
      providerId: z.string().describe("Provider/integration ID (e.g. 'anthropic')"),
      key: z.string().describe("API key value"),
      label: z.string().optional().describe("Optional label for the stored credential"),
    },
    async ({ providerId, key, label }) => {
      try {
        await client.post("/api/credential", {
          integrationID: providerId,
          value: { type: "key", key },
          activate: true,
          ...(label ? { label } : {}),
        });
        return toolResult(`Credentials set for ${providerId}.`);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
