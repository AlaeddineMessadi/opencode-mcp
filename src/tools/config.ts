import { z } from "zod";
import { McpServer } from "../mcp-server.js";
import { OpenCodeClient } from "../client.js";
import { toolJson, toolError, toolResult, redactSecrets, directoryParam } from "../helpers.js";

export function registerConfigTools(server: McpServer, client: OpenCodeClient) {
  server.tool(
    "opencode_config_get",
    "Get the current opencode configuration",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        const config = await client.get("/api/config", undefined, directory);
        const redacted = redactSecrets(config);

        // OpenCode 2.x returns a list of layered config documents:
        // [{ type: "document", path, info }, ...]. Summarize each layer.
        const lines: string[] = [];
        if (Array.isArray(redacted)) {
          for (const doc of redacted as Array<Record<string, unknown>>) {
            const path = typeof doc?.path === "string" ? doc.path : "(unknown source)";
            const info = (doc?.info ?? {}) as Record<string, unknown>;
            const keys = Object.keys(info);
            lines.push(`- ${path}: {${keys.length} entries${keys.length <= 8 ? ` ${keys.join(", ")}` : ""}}`);
          }
          if (lines.length === 0) lines.push("(no configuration documents)");
          return toolResult(
            `## OpenCode Config (${lines.length} layer(s))\n${lines.join("\n")}\n\nUse \`opencode_config_update\` to modify supported settings.`,
          );
        }

        // Fallback for object-shaped configuration.
        const c = redacted as Record<string, unknown>;
        for (const [k, v] of Object.entries(c)) {
          if (v && typeof v === "object" && !Array.isArray(v)) {
            lines.push(`${k}: {${Object.keys(v as Record<string, unknown>).length} entries}`);
          } else if (Array.isArray(v)) {
            lines.push(`${k}: [${v.length} items]`);
          } else {
            lines.push(`${k}: ${v}`);
          }
        }
        return toolResult(`## OpenCode Config\n${lines.join("\n")}`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_config_update",
    "Update opencode configuration. OpenCode 2.x supports patching the default shell (`shell` field); pass a partial object with fields to update.",
    {
      config: z
        .record(z.string(), z.unknown())
        .describe("Partial config object with fields to update (2.x servers support `shell`)"),
      directory: directoryParam,
    },
    async ({ config, directory }) => {
      try {
        return toolJson(redactSecrets(await client.patch("/api/experimental/config", config, directory)));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_config_providers",
    "List all configured providers and the default model",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        const [providersRaw, modelsRaw, defaultsRaw] = await Promise.all([
          client.get("/api/provider", undefined, directory).catch(() => null),
          client.get("/api/model", undefined, directory).catch(() => null),
          client.get("/api/model/default", undefined, directory).catch(() => null),
        ]);
        const providerList = (Array.isArray(providersRaw) ? providersRaw : []) as Array<Record<string, unknown>>;
        const models = (Array.isArray(modelsRaw) ? modelsRaw : []) as Array<Record<string, unknown>>;

        if (providerList.length === 0) {
          return toolResult("No configured providers found.");
        }

        const byProvider = new Map<string, number>();
        for (const model of models) {
          const providerID = typeof model?.providerID === "string" ? model.providerID : "?";
          byProvider.set(providerID, (byProvider.get(providerID) ?? 0) + 1);
        }
        const defaults = (defaultsRaw ?? null) as Record<string, unknown> | null;
        const defaultLine = defaults && typeof defaults === "object"
          ? `\n\nDefault model: ${String((defaults as any).providerID ?? "?")}/${String((defaults as any).id ?? "?")}`
          : "";

        const lines = providerList.map((p) => {
          const id = (p.id ?? "?") as string;
          const name = (p.name ?? id) as string;
          const modelCount = byProvider.get(id) ?? 0;
          const activation = typeof p.activation === "string" ? ` [${p.activation}]` : "";
          return `- ${id} (${name}${activation}): ${modelCount} model${modelCount !== 1 ? "s" : ""}`;
        });

        return toolResult(
          `## Configured Providers (${providerList.length})\n${lines.join("\n")}${defaultLine}\n\nUse \`opencode_provider_models\` with a provider ID to see full model details.`,
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
