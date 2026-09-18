import type { SessionInfo, SessionMessageInfo, ProviderInfo, ModelInfo, IntegrationInfo } from "@opencode/client";
import type { Session, Message, Providers } from "./contracts.js";
export function normalizeSession(value: SessionInfo): Session {
  if (!value || typeof value.id !== "string" || !value.id || typeof value.location?.directory !== "string" || !Number.isFinite(value.time?.created) || !Number.isFinite(value.time?.updated)) throw new Error("Malformed V2 session response");
  return { id: value.id, title: value.title, parentID: value.parentID, directory: value.location.directory,
    time: value.time, agent: value.agent, model: value.model ? { providerID: value.model.providerID, modelID: value.model.id, variant: value.model.variant } : undefined,
    raw: { backend: "v2", value } };
}
export function normalizeMessage(value: SessionMessageInfo, sessionID: string, parentID?: string): Message {
  if (!value || typeof value.id !== "string" || !value.id || typeof value.type !== "string" || !Number.isFinite(value.time?.created)) throw new Error("Malformed V2 message response");
  const info: Message["info"] = { id: value.id, sessionID, role: value.type, time: value.time };
  let parts: Message["parts"] = [];
  if (value.type === "user") parts = [{ type: "text", text: value.text }, ...(value.files ?? []).map(file => ({ type: "file", url: `data:${file.mime};base64,${file.data}`, filename: file.name }))];
  if (value.type === "assistant") { info.parentID = parentID; info.finish = value.finish; info.error = value.error;
    parts = value.content.map(part => part.type === "tool" ? { type: "tool", tool: part.name, callID: part.id, state: part.state, time: part.time } : { ...part }); }
  if (value.type === "shell") parts = [{ type: "text", text: `${value.command}\n${value.output?.output ?? ""}\nStatus: ${value.status}; exit: ${value.exit ?? "unknown"}${value.output?.truncated ? " (output truncated by backend)" : ""}` }];
  return { info, parts, raw: { backend: "v2", value } };
}
export function normalizeMessages(values: SessionMessageInfo[], sessionID: string): Message[] {
  return [...values].sort((a,b) => a.time.created - b.time.created || a.id.localeCompare(b.id)).map(value => {
    return normalizeMessage(value, sessionID);
  });
}
export type PageArray<T> = T[] & { pagination: { complete: boolean; cursor?: string } };
export function pageArray<T>(values: T[], cursor?: string | null): PageArray<T> {
  return Object.assign(values, { pagination: { complete: !cursor, ...(cursor ? { cursor } : {}) } });
}
export function normalizeProviders(providers: ProviderInfo[], models: ModelInfo[], integrations: IntegrationInfo[]): Providers {
  return { all: providers.map(provider => {
    const integration = integrations.find(item => item.id === provider.integrationID);
    const connected = !!integration?.connections.length;
    return { id: provider.id, name: provider.name, integrationID: provider.integrationID, activation: provider.activation,
      // Activation is not credential verification. Only configured connections are reported.
      configured: connected, source: connected ? "integration" : undefined,
      models: Object.fromEntries(models.filter(model => model.providerID === provider.id).map(model => [model.id, { id: model.id, name: model.name, limit: model.limit, status: model.status, enabled: model.enabled }])),
      raw: { backend: "v2", value: { id: provider.id, activation: provider.activation, integrationID: provider.integrationID } } };
  }), connected: providers.filter(provider => integrations.some(item => item.id === provider.integrationID && item.connections.length)).map(provider => provider.id), default: {} };
}
