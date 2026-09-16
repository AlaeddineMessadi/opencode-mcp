import { z } from "zod";
import { McpServer } from "../mcp-server.js";
import { OpenCodeClient } from "../client.js";
import { toolJson, toolError, toolResult, directoryParam, isProviderConfigured } from "../helpers.js";

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
        const raw = await client.get("/provider", undefined, directory);
        const providers = (
          raw && typeof raw === "object" && "all" in (raw as Record<string, unknown>)
            ? (raw as Record<string, unknown>).all
            : raw
        ) as Array<Record<string, unknown>>;

        if (!Array.isArray(providers) || providers.length === 0) {
          return toolResult("No providers configured.");
        }

        const countModels = (p: Record<string, unknown>) => {
          const m = p.models;
          return Array.isArray(m) ? m.length : m && typeof m === "object" ? Object.keys(m).length : 0;
        };

        const configured = providers.filter(isProviderConfigured);
        const unconfigured = providers.filter((p) => !isProviderConfigured(p));

        const lines: string[] = [];

        if (configured.length > 0) {
          lines.push("**Configured:**");
          for (const p of configured) {
            const id = p.id ?? p.name ?? "?";
            const mc = countModels(p);
            const envVars = Array.isArray(p.env) ? ` (via ${(p.env as string[]).join(", ")})` : "";
            lines.push(`- ${id}: ${mc} model${mc !== 1 ? "s" : ""}${envVars}`);
          }
        } else {
          lines.push("**No providers configured.** Use `opencode_auth_set` or set environment variables.");
        }

        if (unconfigured.length > 0) {
          lines.push(`\n**Not configured:** ${unconfigured.length} more providers available`);
          // Show up to 5 popular ones
          const popularIds = new Set(["anthropic", "openai", "google", "openrouter", "groq", "deepseek", "mistral", "huggingface"]);
          const popular = unconfigured.filter((p) => popularIds.has(p.id as string)).slice(0, 5);
          if (popular.length > 0) {
            for (const p of popular) {
              const id = p.id ?? "?";
              const mc = countModels(p);
              lines.push(`- ${id}: ${mc} model${mc !== 1 ? "s" : ""}`);
            }
            const rest = unconfigured.length - popular.length;
            if (rest > 0) lines.push(`- ... and ${rest} more`);
          }
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
        const raw = await client.get("/provider", undefined, directory);
        const providers = (
          raw && typeof raw === "object" && "all" in (raw as Record<string, unknown>)
            ? (raw as Record<string, unknown>).all
            : raw
        ) as Array<Record<string, unknown>>;

        if (!Array.isArray(providers)) {
          return toolError("Unexpected provider response format.");
        }

        const provider = providers.find(
          (p) => (p.id ?? p.name) === providerId,
        );

        if (!provider) {
          const allIds = providers.map((p) => p.id ?? p.name);
          const shown = allIds.slice(0, 10);
          const rest = allIds.length - shown.length;
          const available = shown.join(", ") + (rest > 0 ? ` ... and ${rest} more` : "");
          return toolResult(
            `Provider "${providerId}" not found. Available: ${available || "none"}\n\nUse \`opencode_provider_list\` to see all providers.`,
            true,
          );
        }

        const configured = isProviderConfigured(provider);
        const rawModels = provider.models;
        const modelList: Array<Record<string, unknown>> = Array.isArray(rawModels)
          ? rawModels
          : rawModels && typeof rawModels === "object"
            ? Object.values(rawModels as Record<string, unknown>)
            : [];

        if (modelList.length === 0) {
          return toolResult(
            `Provider "${providerId}" (${configured ? "configured" : "NOT CONFIGURED"}) has no models available.`,
          );
        }

        const maxItems = limit === 0 ? modelList.length : (limit ?? 30);
        const shown = modelList.slice(0, maxItems);
        const lines = shown.map((m: Record<string, unknown>) => {
          const id = m.id ?? m.name ?? "?";
          const name = m.name && m.name !== m.id ? ` — ${m.name}` : "";
          return `- ${id}${name}`;
        });

        const truncNote = modelList.length > maxItems
          ? `\n\n... and ${modelList.length - maxItems} more. Use \`limit: 0\` to see all.`
          : "";

        return toolResult(
          `## ${providerId} (${configured ? "configured" : "NOT CONFIGURED"}) — ${modelList.length} model${modelList.length !== 1 ? "s" : ""}\n${lines.join("\n")}${truncNote}`,
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
        const raw = await client.get("/provider/auth", undefined, directory);
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          const entries = Object.entries(raw as Record<string, unknown>);
          if (entries.length === 0) {
            return toolResult("No authentication methods available.");
          }
          const lines = entries.map(([providerId, methods]) => {
            const arr = Array.isArray(methods) ? methods as Array<Record<string, unknown>> : [];
            const methodDescs = arr.map((m, index) => {
              const type = m.type ?? "?";
              const label = m.label ?? "";
              return `[${index}] ${label ? `${type} (${label})` : String(type)}`;
            });
            return `- ${providerId}: ${methodDescs.join(", ") || "none"}`;
          });
          return toolResult(`## Auth Methods (${entries.length} providers)\n${lines.join("\n")}`, false, { data: raw });
        }
        return toolJson(raw);
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
      method: z.number().int().nonnegative().default(0).describe("Auth method index from opencode_provider_auth_methods (default 0)"),
      inputs: z.record(z.string(), z.string()).optional().describe("Additional inputs requested by the selected authentication method"),
    },
    async ({ providerId, method, inputs }) => {
      try {
        return toolJson(
          await client.post(`/provider/${encodeURIComponent(providerId)}/oauth/authorize`, { method: method ?? 0, ...(inputs ? { inputs } : {}) }),
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
      callbackData: z.object({
        method: z.number().int().nonnegative().describe("The method index used for authorization"),
        code: z.string().optional().describe("Authorization code for methods that request one"),
      }).describe("OAuth callback data"),
    },
    async ({ providerId, callbackData }) => {
      try {
        await client.post(
          `/provider/${encodeURIComponent(providerId)}/oauth/callback`,
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
