import type { OperationInputs, OperationResults } from "./operations.js";
import { observeV2Session, type V2ObservationState } from "./v2-observation.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { OpenCode, type SessionInfo, type SessionMessageInfo } from "@opencode/client";
import { OpenCodeClient, OpenCodeSubmissionError, OpenCodeError } from "../client.js";
import { createMessageId } from "../jobs.js";
import { assertPromptOptions, assertSessionSelection, assertNoStagedRevert } from "./v2-guards.js";
import { validateFormValues } from "./v2-forms.js";
import { translateMcpConfig } from "./v2-mcp.js";
import type { BackendAdapter, OperationArgs, Operation } from "./adapter.js";
import { BackendCapabilityError } from "./contracts.js";
import { normalizeSession, normalizeMessage, normalizeMessages, normalizeProviders, pageArray } from "./normalization.js";
import { createRequestContext, withAbort, abortableSleep, throwIfAborted } from "../async.js";
import { normalizeDirectory, applyModelDefaults } from "../helpers.js";

const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const required = (value: string | undefined, name: string): string => { if (!value) throw new Error(`${name} is required`); return value; };
export class V2Adapter implements BackendAdapter {
  readonly api: ReturnType<typeof OpenCode.make>;
  private readonly mutation = new AsyncLocalStorage<{ submitted: boolean; method?: string; path?: string; recovery?: {sessionId:string;messageId?:string} }>();
  constructor(client: OpenCodeClient) {
    const base = new URL(client.getBaseUrl());
    this.api = OpenCode.make({ baseUrl: client.getBaseUrl(), headers: client.connectionHeaders, fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const prefix = base.pathname.replace(/\/$/, "");
      if (prefix && prefix !== "/" && url.origin === base.origin) url.pathname = prefix + url.pathname;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const write = method !== "GET" && method !== "HEAD";
      throwIfAborted(init?.signal ?? undefined);
      const state = this.mutation.getStore();
      if (write && state) { state.submitted = true; state.method = method; state.path = url.pathname; }
      try {
        const response = await fetch(input instanceof Request ? new Request(url, input) : url, init);
        if (!response.ok) throw new OpenCodeError(`V2 ${method} request rejected (${response.status})`, response.status, method, url.pathname, await response.text());
        return response;
      } catch (error) {
        if (write && !(error instanceof OpenCodeError)) throw new OpenCodeSubmissionError(method, url.pathname, error);
        throw error;
      }
    } });
  }
  execute<K extends Operation>(operation: K, args: OperationInputs[K]): Promise<OperationResults[K]> {
    return this.request(operation, args) as Promise<OperationResults[K]>;
  }
  private async request(operation: Operation, args: OperationArgs): Promise<unknown> {
    const context = createRequestContext(args);
    const state: {submitted:boolean;method:string;path:string;recovery?:{sessionId:string;messageId?:string}} = { submitted: false, method: "POST", path: operation as string, ...(args.sessionId ? {recovery:{sessionId:args.sessionId}} : {}) };
    return this.mutation.run(state, async () => {
      try { throwIfAborted(context.signal); return await withAbort(this.perform(operation, args, { signal: context.signal }), context.signal); }
      catch (error) { const normalized = unwrapV2Error(error); if (state.submitted && (!(normalized instanceof OpenCodeError) || normalized.method === "GET")) { const uncertain = normalized instanceof OpenCodeSubmissionError ? normalized : new OpenCodeSubmissionError(state.method, state.path, normalized); throw Object.assign(uncertain, state.recovery); } throw normalized; }
      finally { context.dispose(); }
    });
  }
  private async perform(operation: Operation, args: OperationArgs, options: { signal: AbortSignal }): Promise<unknown> {
    const api = this.api, location = args.directory ? { directory: args.directory } : undefined;
    const q = args.query ?? {}, body = object(args.body);
    const sessionID = () => required(args.sessionId, "sessionId");
    switch (operation) {
      case "lifecycle.health": { const info = await api.server.info(options); if (!info || typeof info.version !== "string" || typeof info.pid !== "number" || !Array.isArray(info.urls)) throw new Error("Malformed V2 server information"); return { healthy: true, version: info.version, backend: "v2" }; }
      case "configuration.get": return { backend: "v2", sources: await api.config.get({ location }, options), effectiveConfiguration: false };
      case "projects.list": return (await api.project.list(options)).map(project => ({ ...project, worktree: project.canonical }));
      case "projects.current": { const value = await api.location.get({ location }, options); return { ...value.project, worktree: value.project.directory, directory: value.directory }; }
      case "files.paths": { const value = await api.location.get({ location }, options); return { directory: value.directory, worktree: value.project.directory, backend: "v2" }; }
      case "files.vcs": return (await api.vcs.get({ location }, options)).data;
      case "files.status": return (await api.vcs.status({ location }, options)).data.map(file => ({ file: file.file, status: file.status, additions: file.additions, deletions: file.deletions, raw: { backend: "v2", value: file } }));
      case "files.list": return (await api.file.list({ location, path: q.path }, options)).data.map(entry => ({ path: entry.path, type: entry.type, name: entry.path.split(/[\\/]/).at(-1), raw: { backend: "v2", value: entry } }));
      case "files.find": {
        const directory = normalizeDirectory(q.directory ?? args.directory);
        const limit = q.limit !== undefined ? Number(q.limit) : 100;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("File search limit must be an integer from 1 to 200");
        const result = await api.file.find({ location: directory ? { directory } : location, query: q.query ?? "", type: q.type as "file" | "directory" | undefined, limit }, options);
        return Object.assign(result.data.slice(0, limit).map(entry => entry.path), { pagination: { complete: result.data.length < limit, bounded: result.data.length >= limit, continuationAvailable: false } });
      }
      case "files.read": {
        const bytes = await api.file.read({ location, path: required(q.path, "path") }, options);
        try { return { type: "text", content: new TextDecoder("utf-8", { fatal: true }).decode(bytes), backend: "v2" }; }
        catch { return { type: "binary", encoding: "base64", content: Buffer.from(bytes).toString("base64"), backend: "v2" }; }
      }
      case "configuration.agents": return (await api.agent.list({ location }, options)).data;
      case "configuration.commands": return (await api.command.list({ location }, options)).data;
      case "configuration.mcp": return Object.fromEntries((await api.mcp.list({ location }, options)).data.map(server => [server.name, { name: server.name, status: server.status.status, integrationID: server.integrationID, raw: { backend: "v2", value: server } }]));
      case "providers.list": case "providers.configured": {
        const providers = await api.provider.list({ location }, options);
        const models = await api.model.list({ location }, options);
        const integrations = await api.integration.list({ location }, options);
        const result = normalizeProviders(providers.data, models.data, integrations.data);
        return operation === "providers.configured" ? { providers: result.all.filter(provider => provider.configured), default: result.default } : result;
      }
      case "providers.authMethods": {
        const providers = await api.provider.list({ location }, options);
        const integrations = await api.integration.list({ location }, options);
        return Object.fromEntries(providers.data.map(provider => [provider.id, integrations.data.find(integration => integration.id === provider.integrationID)?.methods.map(method => ({ ...method, integrationID: provider.integrationID })) ?? []]));
      }
      case "sessions.list": case "sessions.children": {
        const currentLocation = await api.location.get({ location }, options);
        const values: SessionInfo[] = []; let cursor: string | undefined = q.cursor; const seen = new Set<string>();
        const limit = q.limit !== undefined ? Number(q.limit) : undefined;
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) throw new Error("limit must be a positive integer");
        do {
          const page = await api.session.list({ directory: currentLocation.directory, parentID: operation === "sessions.children" ? sessionID() : undefined, cursor, limit: limit ? Math.min(100, limit-values.length) : 100, search: q.search }, options);
          values.push(...page.data); cursor = page.cursor.next ?? undefined;
          if (!cursor || (limit && values.length >= limit)) break;
          if (seen.has(cursor)) throw new Error("V2 returned a repeated session pagination cursor"); seen.add(cursor);
        } while (true);
        return pageArray(values.map(normalizeSession), cursor);
      }
      case "sessions.get": return normalizeSession(await this.scopedSession(args, options));
      case "sessions.status": {
        const currentLocation = await api.location.get({ location }, options);
        const statuses = await api.session.active(options);
        const entries = await Promise.all(Object.entries(statuses).map(async ([id, state]) => {
          const info = await api.session.get({ sessionID: id }, options); return info.location.directory === currentLocation.directory ? [id, state] as const : undefined;
        }));
        return Object.fromEntries(entries.filter(entry => entry !== undefined));
      }
      case "messages.list": {
        if (args.directory) await this.scopedSession(args, options);
        const values: SessionMessageInfo[] = []; let cursor: string | undefined = q.cursor; const seen = new Set<string>();
        const limit = q.limit !== undefined ? Number(q.limit) : undefined;
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) throw new Error("limit must be a positive integer");
        do {
          const page = await api.message.list({ sessionID: sessionID(), cursor, limit: limit ? Math.min(100, limit-values.length) : 100 }, options);
          values.push(...page.data); cursor = page.cursor.next ?? undefined;
          if (!cursor || (limit && values.length >= limit)) break;
          if (seen.has(cursor)) throw new Error("V2 returned a repeated message pagination cursor"); seen.add(cursor);
        } while (true);
        return pageArray(normalizeMessages(values, sessionID()), cursor);
      }
      case "messages.get": {
        if (args.directory) await this.scopedSession(args, options);
        return normalizeMessage(await api.session.message.get({ sessionID: sessionID(), messageID: required(args.messageId, "messageId") }, options), sessionID());
      }
      case "permissions.list": return (await api.permission.request.list({ location }, options)).data.map(request => ({ id: request.id, sessionID: request.sessionID, permission: request.action, patterns: request.resources, always: request.save, backend: "v2", approvalScope: "project", rejectionScope: "session", raw: { backend: "v2", value: request } }));
      case "forms.list": return (await api.form.list({ location }, options)).data.map(form => ({ ...form, backend: "v2" }));
      case "sessions.create": {
        assertPromptOptions(body);
        if (body.parentID !== undefined) throw new BackendCapabilityError("session_create.parentID", "V2 session creation has no parentID equivalent; use an explicit fork instead.");
        const model = body.model ?? applyModelDefaults();
        if (body.variant && !model) throw new BackendCapabilityError("session.variant", "Select a provider and model before requesting a V2 model variant.");
        return normalizeSession(await api.session.create({ title: body.title, agent: body.agent,
          model: model ? { id: model.modelID, providerID: model.providerID, ...(body.variant ? { variant: body.variant } : {}) } : undefined, location }, options));
      }
      case "sessions.remove": await this.scopedSession(args, options); return api.session.remove({ sessionID: sessionID() }, options);
      case "sessions.update": await this.scopedSession(args, options); await api.session.update({ sessionID: sessionID(), title: body.title }, options); return normalizeSession(await api.session.get({ sessionID: sessionID() }, options));
      case "sessions.abort": await this.scopedSession(args, options); return api.session.interrupt({ sessionID: sessionID() }, options);
      case "sessions.fork": {
        await this.scopedSession(args, options);
        if (body.messageID !== undefined) await api.session.message.get({ sessionID: sessionID(), messageID: required(body.messageID, "messageID") }, options);
        const value = await api.session.fork({ sessionID: sessionID(), before: body.messageID }, options);
        return { ...normalizeSession(value), forkBoundary: body.messageID ? { type: "before", messageId: body.messageID } : { type: "through-current-history" } };
      }
      case "sessions.compact": {
        const session = await this.scopedSession(args, options);
        assertNoStagedRevert(session);
        assertSessionSelection(session, { model: body.providerID && body.modelID ? { providerID: body.providerID, modelID: body.modelID } : undefined, variant: body.variant });
        return api.session.compact({ sessionID: sessionID(), delivery: "queue" }, options);
      }
      case "sessions.revert": {
        if (body.partID !== undefined) throw new BackendCapabilityError("session_revert.partID", "V2 cannot revert individual message parts.");
        await this.scopedSession(args, options);
        const staged = await api.session.revert.stage({ sessionID: sessionID(), messageID: required(body.messageID, "messageID"), files: true }, options);
        return { staged, committed: false, reversible: true };
      }
      case "sessions.unrevert": await this.scopedSession(args, options); return api.session.revert.clear({ sessionID: sessionID() }, options);
      case "sessions.diff": {
        if (q.messageID && (q.from || q.to)) throw new Error("Supply a V2 from/to range without the V1 messageID parameter");
        if (!q.from || !q.to) throw new BackendCapabilityError("session_diff.range", "V2 requires explicit from and to message IDs; its default is only the newest turn, not the entire session.");
        await this.scopedSession(args, options);
        const history = await this.perform("messages.list", args, options) as ReturnType<typeof normalizeMessages>;
        const from = history.findIndex(message => message.info.id === q.from), to = history.findIndex(message => message.info.id === q.to);
        if (from < 0 || to < 0 || from > to) throw new Error("Invalid diff range; from and to must identify ordered messages in this session");
        if (history.slice(from, to + 1).some(message => message.info.role === "location-switched")) throw new BackendCapabilityError("session_diff.location", "V2 cross-location diff ranges are unsupported.");
        const diffs = await api.session.diff({ sessionID: sessionID(), from: q.from, to: q.to }, options);
        return Object.assign(diffs, { attribution: "turn", range: { from: q.from, to: q.to } });
      }
      case "messages.enqueue": case "messages.send": {
        assertPromptOptions(body);
        const session = await this.scopedSession(args, options); assertSessionSelection(session, body);
        assertNoStagedRevert(session);
        const parts = Array.isArray(body.parts) ? body.parts : [];
        if (parts.some(part => part.type !== "text")) throw new BackendCapabilityError("prompt.parts", "This V2 compatibility prompt accepts text parts only.");
        const id = body.messageID ?? createMessageId();
        const dispatchState = this.mutation.getStore(); if (dispatchState) dispatchState.recovery = { sessionId: sessionID(), messageId: id };
        const receipt = await api.session.prompt({ sessionID: sessionID(), id, text: parts.map(part => part.text ?? "").join("\n"), delivery: "queue" }, options);
        if (receipt.id !== id) throw new OpenCodeSubmissionError("POST", "session.prompt", new Error("V2 inbox receipt does not match the persisted prompt identifier"));
        if (operation === "messages.enqueue") return receipt;
        return this.waitPrompt(sessionID(), id, options);
      }
      case "messages.command": throw new BackendCapabilityError("command_execute", "V2 2.0.6 command submission returns no receipt and accepts no caller identifier. Exact execution completion cannot be correlated safely; no command was submitted.");
      case "messages.shell": {
        const session = await this.scopedSession(args, options); assertSessionSelection(session, body);
        const id = createMessageId();
        const dispatchState = this.mutation.getStore(); if (dispatchState) dispatchState.recovery = { sessionId: sessionID(), messageId: id };
        await api.session.shell({ sessionID: sessionID(), id, command: required(body.command, "command") }, options);
        while (true) {
          try {
            const result = await api.session.message.get({ sessionID: sessionID(), messageID: id }, options);
            if (result.type === "shell" && result.status !== "running") return { ...normalizeMessage(result, sessionID()), execution: { completed: true, status: result.status, exitCode: result.exit }, isError: result.status !== "exited" || result.exit !== 0 };
          } catch (error) { if (!isV2NotFound(error)) throw error; }
          await abortableSleep(100, options.signal);
        }
      }
      case "providers.authorize": {
        const integration = await this.resolveIntegration(required(args.providerId, "providerId"), body.integrationId, options);
        const method = body.methodId ? integration.methods.find(method => "id" in method && method.id === body.methodId) : integration.methods[body.method ?? 0];
        if (!method || method.type !== "oauth") throw new Error("Select an OAuth method returned by provider_auth_methods");
        const values = body.values ?? body.inputs;
        if (method.form) validateFormValues(method.form, values ?? {});
        const result = await api.integration.oauth.connect({ integrationID: integration.id, methodID: method.id, answer: values }, options);
        return { ...result.data, attemptId: result.data.attemptID, integrationId: integration.id, methodId: method.id };
      }
      case "providers.callback": {
        const attemptID = required(body.attemptId, "attemptId from the matching OAuth authorization");
        const integration = await this.resolveIntegration(required(args.providerId, "providerId"), body.integrationId, options);
        return api.integration.oauth.complete({ integrationID: integration.id, attemptID, code: body.code }, options);
      }
      case "providers.setAuth": {
        if (body.type !== "api") throw new BackendCapabilityError("auth_set.type", "V2 auth_set supports API keys; use the OAuth authorization workflow for OAuth.");
        const integration = await this.resolveIntegration(required(args.providerId, "providerId"), body.integrationId, options);
        if (!integration.methods.some(method => method.type === "key")) throw new BackendCapabilityError("auth_set.method", "This integration does not publish a key authentication method.");
        return api.integration.connect.key({ integrationID: integration.id, key: required(body.key, "key") }, options);
      }
      case "permissions.reply": {
        if (!["once", "always", "reject"].includes(body.reply)) throw new Error("Choose an explicit permission reply: once, always, or reject");
        const sessionId = args.sessionId ?? body.sessionId;
        if (!sessionId) throw new Error("V2 permission replies require explicit session identity");
        if (body.reply === "always" && body.scope !== "project") throw new BackendCapabilityError("permission.scope", "V2 always saves matching approvals for the entire project; explicitly acknowledge scope: project.");
        if (body.reply === "reject" && body.scope !== "session") throw new BackendCapabilityError("permission.scope", "V2 reject rejects every pending permission in this session; explicitly acknowledge scope: session.");
        await this.scopedSession({ ...args, sessionId }, options);
        await api.permission.reply({ sessionID: sessionId, requestID: required(args.requestId, "requestId"), decision: body.reply, message: body.message }, options);
        return { reply: body.reply, scope: body.reply === "always" ? "project" : body.reply === "reject" ? "session" : "request" };
      }
      case "forms.reply": case "forms.reject": {
        const requestId = required(args.requestId, "requestId");
        let sessionId = args.sessionId ?? body.sessionId;
        if (!sessionId) {
          const matches = (await api.form.list({ location }, options)).data.filter(form => form.id === requestId);
          if (matches.length !== 1) throw new Error("Provide sessionId to identify the V2 form unambiguously");
          sessionId = matches[0].sessionID;
        }
        await this.scopedSession({ ...args, sessionId }, options);
        if (operation === "forms.reject") return api.session.form.cancel({ sessionID: sessionId, formID: requestId }, options);
        const form = await api.session.form.get({ sessionID: sessionId, formID: requestId }, options);
        if (form.state.status !== "pending") throw new Error("This form is no longer pending");
        if (body.answers !== undefined && body.values !== undefined) throw new Error("Supply values or answers, not both");
        if (body.answers !== undefined && body.values === undefined) throw new BackendCapabilityError("question.answers", "V2 forms require typed field-keyed values; use the fields returned by question_list.");
        const values = validateFormValues(form.fields, body.values);
        return api.session.form.reply({ sessionID: sessionId, formID: requestId, answer: values }, options);
      }
      case "configuration.mcpAdd": {
        const config = translateMcpConfig(body.config);
        await api.mcp.add({ server: required(body.name, "name"), location, config }, options);
        return { name: body.name, configured: true };
      }
      default: throw new BackendCapabilityError(operation, `${operation} has no implemented V2 mapping`);
    }
  }
  private async scopedSession(args: OperationArgs, options: { signal: AbortSignal }) {
    const session = await this.api.session.get({ sessionID: required(args.sessionId, "sessionId") }, options);
    if (!session || session.id !== args.sessionId || typeof session.location?.directory !== "string") throw new Error("V2 returned a malformed or mismatched session");
    if (args.directory) {
      const location = await this.api.location.get({ location: { directory: args.directory } }, options);
      if (location.directory !== session.location.directory) throw new Error("Session location does not match the supplied directory");
    }
    return session;
  }
  private async resolveIntegration(providerId: string, explicit: string | undefined, options: { signal: AbortSignal }) {
    const providers = await this.api.provider.list(undefined, options);
    const matches = providers.data.filter(provider => provider.id === providerId);
    if (matches.length !== 1 || !matches[0].integrationID) throw new Error("Provider has no unambiguous integration mapping");
    const integrationID = matches[0].integrationID;
    if (explicit && explicit !== integrationID) throw new Error("Explicit integration does not match the provider mapping");
    const integrations = await this.api.integration.list(undefined, options);
    const candidates = integrations.data.filter(value => value.id === integrationID);
    if (candidates.length !== 1) throw new Error("Provider integration mapping is missing or ambiguous");
    return candidates[0];
  }
  private async waitPrompt(sessionID: string, messageID: string, options: { signal: AbortSignal }): Promise<unknown> {
    let state: V2ObservationState | undefined;
    while (true) {
      throwIfAborted(options.signal);
      const observed = await observeV2Session(this.api, sessionID, messageID, options, state);
      state = observed.state;
      if (observed.snapshot.status === "completed") return observed.snapshot.result;
      if (["failed", "cancelled", "input_required"].includes(observed.snapshot.status)) return {
        info: { id: messageID, sessionID, role: "assistant", error: { name: observed.snapshot.status, message: observed.snapshot.text ?? "OpenCode needs input or execution stopped; inspect the session before retrying." } },
        parts: [{ type: "text", text: observed.snapshot.text ?? JSON.stringify(observed.snapshot.inputs ?? observed.snapshot.error) }],
        observation: observed.snapshot,
      };
      await abortableSleep(100, options.signal);
    }
  }
}
function isV2NotFound(error: unknown): boolean {
  const normalized = unwrapV2Error(error);
  return normalized instanceof OpenCodeError && normalized.status === 404 || !!normalized && typeof normalized === "object" && "_tag" in normalized && String(normalized._tag).includes("NotFound");
}


export function unwrapV2Error(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    if (current instanceof OpenCodeError || current instanceof OpenCodeSubmissionError) return current;
    if (!current || typeof current !== "object" || !("cause" in current)) break;
    current = current.cause;
  }
  return error;
}
