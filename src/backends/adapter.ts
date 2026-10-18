import { BackendCapabilityError } from "./contracts.js";
import type { OperationInputs, OperationResults } from "./operations.js";
import type { OpenCodeClient } from "../client.js";
import { normalizeDirectory, applyModelDefaults } from "../helpers.js";
import { createRequestContext, withAbort, throwIfAborted, type RequestOptions } from "../async.js";
import { v1Routes, type Operation } from "./v1-routes.js";
import { V2Adapter } from "./v2.js";
export type { Operation } from "./v1-routes.js";
/** Semantic operation inputs shared by the transport adapters. Paths stay server-side. */
export interface OperationArgs extends RequestOptions {
  sessionId?: string; messageId?: string; requestId?: string; providerId?: string;
  directory?: string; query?: Record<string, string>; body?: unknown;
}
export interface BackendAdapter { execute<K extends Operation>(operation: K, args: OperationInputs[K]): Promise<OperationResults[K]> }
export class V1Adapter implements BackendAdapter {
  constructor(private readonly client: OpenCodeClient) {}
  execute<K extends Operation>(operation: K, args: OperationInputs[K]): Promise<OperationResults[K]> {
    return this.request(operation, args) as Promise<OperationResults[K]>;
  }
  private request(operation: Operation, args: OperationArgs): Promise<unknown> {
    if (operation === "sessions.diff" && (args.query?.from || args.query?.to)) throw new BackendCapabilityError("session_diff.range", "Explicit from/to ranges are V2-only; V1 accepts messageID.", "v1");
    if (operation === "providers.callback" && typeof (args.body as { method?: unknown })?.method !== "number") throw new Error("V1 OAuth callback requires the method index used for authorization");
    if (operation === "forms.reply" && !Array.isArray((args.body as { answers?: unknown })?.answers)) throw new Error("V1 question replies require answers arrays");
    const route = v1Routes[operation];
    const path = route.path.replace(/:(sessionId|messageId|requestId|providerId)/g, (_, key: keyof OperationArgs) => {
      const value = args[key]; if (typeof value !== "string" || !value) throw new Error(`${key} is required`);
      return encodeURIComponent(value);
    });
    const { directory, query, body, signal, deadline, timeout } = args;
    const options = { ...(signal ? { signal } : {}), ...(deadline !== undefined ? { deadline } : {}), ...(timeout !== undefined ? { timeout } : {}) };
    const bounded = signal !== undefined || deadline !== undefined || timeout !== undefined;
    switch (route.method) {
      case "GET": return bounded ? this.client.get(path, query, directory, options) : "directory" in args || query !== undefined ? this.client.get(path, query, directory) : this.client.get(path);
      case "POST": return bounded || "directory" in args ? this.client.post(path, body, { ...options, directory }) : this.client.post(path, body);
      case "PATCH": return bounded ? this.client.patch(path, body, directory, options) : this.client.patch(path, body, directory);
      case "PUT": return bounded ? this.client.put(path, body, directory, options) : directory !== undefined ? this.client.put(path, body, directory) : this.client.put(path, body);
      case "DELETE": return bounded ? this.client.delete(path, query, directory, options) : this.client.delete(path, query, directory);
    }
  }
}
const adapters = new WeakMap<OpenCodeClient, BackendAdapter>();
export function backend(client: OpenCodeClient): BackendAdapter {
  let adapter = adapters.get(client);
  if (!adapter) { adapter = client.getBackendIdentity?.().kind === "v2" ? new V2Adapter(client) : new V1Adapter(client); adapters.set(client, adapter); }
  return adapter;
}
export function operate<K extends Operation>(client: OpenCodeClient, operation: K, args: OperationInputs[K] = {} as OperationInputs[K]): Promise<OperationResults[K]> {
  client.assertBackendAvailable?.();
  normalizeDirectory(args.directory);
  return backend(client).execute(operation, args);
}

/** Configured model defaults belong only to new V2 sessions. */
export function selectModel(client: OpenCodeClient, providerID?: string, modelID?: string, newSession = false) {
  if (client.getBackendIdentity?.().kind === "v2" && [providerID, modelID].some(value => value !== undefined && !value.trim())) throw new Error("V2 providerID and modelID must be nonempty when supplied");
  if (client.getBackendIdentity?.().kind === "v2" && Boolean(providerID) !== Boolean(modelID)) throw new Error("V2 model selection requires both providerID and modelID");
  if (client.getBackendIdentity?.().kind === "v2" && !newSession) return providerID && modelID ? { providerID, modelID } : undefined;
  return applyModelDefaults(providerID, modelID);
}

/** Shared event contract. V2 global transport is filtered by the resolved server location. */
export async function* events(client: OpenCodeClient, scope: "project" | "global", args: OperationArgs = {}) {
  client.assertBackendAvailable?.();
  const adapter = backend(client);
  if (!(adapter instanceof V2Adapter)) { yield* client.subscribeSSE(scope === "global" ? "/global/event" : "/event", args); return; }
  const context = createRequestContext(args);
  let iterator: AsyncIterator<import("@opencode/client").OpenCodeEvent> | undefined;
  try {
    throwIfAborted(context.signal);
    const directory = scope === "project" ? (await withAbort(adapter.api.location.get({ location: args.directory ? { directory: normalizeDirectory(args.directory) } : undefined }, { signal: context.signal }), context.signal)).directory : undefined;
    iterator = adapter.api.event.subscribe({ signal: context.signal })[Symbol.asyncIterator]();
    while (true) {
      const next = await withAbort(iterator.next(), context.signal);
      if (next.done) return;
      const event = next.value;
      if (scope === "project" && (!("location" in event) || event.location?.directory !== directory)) continue;
      yield { event: event.type, data: JSON.stringify(event) };
    }
  } finally {
    context.abort();
    if (iterator?.return) void iterator.return().catch(() => {});
    context.dispose();
  }
}
