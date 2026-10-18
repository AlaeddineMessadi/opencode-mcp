import { operate } from "../backends/adapter.js";
import { z } from "zod";
import { McpServer } from "../mcp-server.js";
import { OpenCodeClient } from "../client.js";
import { toolJson, toolError, toolResult, redactSecrets, safeStringify, directoryParam } from "../helpers.js";

export function registerConfigTools(server: McpServer, client: OpenCodeClient) {
  server.tool(
    "opencode_config_get",
    "Get the current opencode configuration",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        const config = await operate(client, "configuration.get", { directory: directory });
        const c = redactSecrets(config) as Record<string, unknown>;

        if (client.getBackendIdentity?.().kind === "v2") return toolResult(`## V2 Configuration Sources\nThese ordered sources are not an effective merged configuration.\n${safeStringify(c)}`, false, { data: c });
        // Build a compact summary instead of dumping entire config
        const lines: string[] = [];
        for (const [k, v] of Object.entries(c)) {
          if (v && typeof v === "object" && !Array.isArray(v)) {
            const keys = Object.keys(v as Record<string, unknown>);
            if (keys.length <= 5) {
              // Small objects: show inline
              const inner = Object.entries(v as Record<string, unknown>)
                .map(([sk, sv]) => {
                  if (sv && typeof sv === "object") return `${sk}: {..}`;
                  return `${sk}: ${sv}`;
                })
                .join(", ");
              lines.push(`${k}: { ${inner} }`);
            } else {
              lines.push(`${k}: {${keys.length} entries}`);
            }
          } else if (Array.isArray(v)) {
            if (v.length <= 3) {
              lines.push(`${k}: ${JSON.stringify(v)}`);
            } else {
              lines.push(`${k}: [${v.length} items]`);
            }
          } else {
            lines.push(`${k}: ${v}`);
          }
        }

        return toolResult(
          `## OpenCode Config\n${lines.join("\n")}\n\nUse \`opencode_config_update\` to modify specific settings.`,
        );
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
        return toolJson(redactSecrets(await operate(client, "configuration.update", { body: config, directory: directory })));
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
        const raw = await operate(client, "providers.configured", { directory: directory });
        const wrapper = raw as Record<string, unknown>;

        // API returns { providers: [...], default: { providerId: modelId, ... } }
        const providerList = Array.isArray(wrapper?.providers)
          ? wrapper.providers as Array<Record<string, unknown>>
          : Array.isArray(raw)
            ? raw as Array<Record<string, unknown>>
            : [];
        const defaults = (wrapper?.default ?? {}) as Record<string, string>;

        if (providerList.length === 0) {
          return toolResult("No configured providers found.");
        }

        const lines = providerList.map((p) => {
          const id = (p.id ?? "?") as string;
          const name = (p.name ?? id) as string;
          const models = p.models;
          const modelCount =
            Array.isArray(models)
              ? models.length
              : models && typeof models === "object"
                ? Object.keys(models).length
                : 0;
          const defaultModel = defaults[id] ?? "";
          const defaultStr = defaultModel ? ` (default: ${defaultModel})` : "";
          return `- ${id} (${name}): ${modelCount} model${modelCount !== 1 ? "s" : ""}${defaultStr}`;
        });

        // Show defaults summary if there are entries not in the provider list
        const extraDefaults = Object.entries(defaults).filter(
          ([id]) => !providerList.some((p) => p.id === id),
        );
        const extraLines = extraDefaults.map(([id, model]) => `- ${id}: ${model}`);

        let output = `## Configured Providers (${providerList.length})\n${lines.join("\n")}`;
        if (extraLines.length > 0) {
          output += `\n\n## Additional Default Models\n${extraLines.join("\n")}`;
        }
        output += `\n\nUse \`opencode_provider_models\` with a provider ID to see full model details.`;

        return toolResult(output);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
