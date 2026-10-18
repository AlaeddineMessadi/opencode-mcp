import { z } from "zod";
import type { McpAddInput } from "@opencode/client";
import { BackendCapabilityError } from "./contracts.js";
const timeout = z.object({ startup: z.number().positive().optional(), catalog: z.number().positive().optional(), execution: z.number().positive().optional() }).strict();
const oauth = z.object({ client_id: z.string().optional(), client_secret: z.string().optional(), scope: z.string().optional(), callback_port: z.number().int().positive().optional(), redirect_uri: z.string().optional(), auth_server_metadata_url: z.string().optional() }).strict();
const shared = { disabled: z.boolean().optional(), codemode: z.boolean().optional(), timeout: timeout.optional(), protocol: z.enum(["legacy", "auto", "2026-07-28"]).optional() };
const schema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("local"), command: z.array(z.string()).min(1), cwd: z.string().optional(), environment: z.record(z.string(), z.string()).optional(), ...shared }).strict(),
  z.object({ type: z.literal("remote"), url: z.string().url(), headers: z.record(z.string(), z.string()).optional(), oauth: z.union([oauth, z.literal(false)]).optional(), ...shared }).strict(),
]);
export function translateMcpConfig(value: unknown): McpAddInput["config"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP config must be an object");
  const config = structuredClone(value) as Record<string, unknown>;
  if (config.enabled !== undefined) {
    if (typeof config.enabled !== "boolean") throw new Error("MCP enabled must be boolean");
    if (config.disabled !== undefined && config.disabled !== !config.enabled) throw new BackendCapabilityError("mcp.config", "Conflicting enabled and disabled fields");
    config.disabled = !config.enabled; delete config.enabled;
  }
  // V1 timeout covers tool/catalog calls. Both are translated explicitly.
  if (typeof config.timeout === "number") config.timeout = { catalog: config.timeout, execution: config.timeout };
  if (config.oauth && typeof config.oauth === "object") {
    const auth = config.oauth as Record<string, unknown>;
    for (const [oldName, nextName] of Object.entries({ clientId: "client_id", clientSecret: "client_secret", redirectUri: "redirect_uri", callbackPort: "callback_port", authServerMetadataUrl: "auth_server_metadata_url" })) {
      if (auth[oldName] !== undefined) { if (auth[nextName] !== undefined && auth[nextName] !== auth[oldName]) throw new BackendCapabilityError("mcp.config.oauth", `Conflicting ${oldName} and ${nextName}`); auth[nextName] = auth[oldName]; delete auth[oldName]; }
    }
  }
  const result = schema.safeParse(config);
  if (!result.success) throw new BackendCapabilityError("mcp.config", "Unsupported or invalid MCP configuration fields; use the documented V2-compatible fields.");
  return result.data;
}
