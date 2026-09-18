import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, rmdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { OpenCodeClient, OpenCodeError, OpenCodeSubmissionError } from "./client.js";
import { abortableSleep, createRequestContext, throwIfAborted, withAbort, withRequestOptions, type RequestOptions } from "./async.js";
import { formatMessageResponse, normalizeDirectory } from "./helpers.js";
import { backend, operate, selectModel } from "./backends/adapter.js";
import { V2Adapter, unwrapV2Error } from "./backends/v2.js";
import { assertPromptOptions } from "./backends/v2-guards.js";
import { validateFormValues } from "./backends/v2-forms.js";
import { BackendCapabilityError, type BackendIdentity } from "./backends/contracts.js";
import { initialV2Observation, observeV2Session, type V2ObservationState } from "./backends/v2-observation.js";
import type { FormField } from "@opencode/client";

export type JobStatus = "accepted" | "running" | "input_required" | "completed" | "failed" | "cancelled" | "unknown";
export interface PendingInput {
  id: string;
  kind: "question" | "permission";
  sessionID: string;
  [key: string]: unknown;
}
export interface JobSnapshot {
  backend?: "v1" | "v2";
  backendIdentity?: BackendIdentity;
  jobId?: string;
  sessionId?: string;
  messageId?: string;
  directory?: string;
  status: JobStatus;
  result?: unknown;
  text?: string;
  error?: unknown;
  inputs?: PendingInput[];
  session?: unknown;
  createdAt?: number;
  updatedAt?: number;
  expiresAt?: number;
}
export interface JobStartArgs {
  prompt: string;
  sessionId?: string;
  title?: string;
  directory?: string;
  model?: { providerID: string; modelID: string };
  variant?: string;
  agent?: string;
  format?: unknown;
}
export interface JobInputResponse {
  id: string;
  kind: "question" | "permission";
  answers?: string[][];
  reply?: "once" | "always" | "reject";
  reject?: boolean;
  message?: string;
  sessionId?: string;
  values?: Record<string, string | number | boolean | string[]>;
  scope?: "project" | "session";
}
export interface JobServiceOptions {
  /** null creates a process-local store for isolated tests or ephemeral clients. */
  storeRoot?: string | null;
  /** Opaque identity supplied by the caller, including auth identity if used. */
  scope?: string;
  directory?: string;
  ttlMs?: number;
}
interface StoredJobBase extends JobSnapshot {
  jobId: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  /** Persisted before sending each reply: an uncertain reply is never replayed. */
  responses: Record<string, { digest: string; state: "sending" | "sent" | "unknown" }>;
  cancelRequested?: boolean;
}
interface StoredV1Job extends StoredJobBase { version: 1 }
interface StoredV2Job extends StoredJobBase {
  version: 2;
  backendIdentity: BackendIdentity;
  observation: V2ObservationState;
  receipt?: { id: string; sessionID: string };
}
type StoredJob = StoredV1Job | StoredV2Job;
const terminal = (status: JobStatus) => ["completed", "failed", "cancelled"].includes(status);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const segment = (value: string) => encodeURIComponent(value);

function publicSnapshot(job: StoredJob): JobSnapshot {
  const { version: _version, responses: _responses, cancelRequested: _cancelRequested, ...snapshot } = job;
  delete (snapshot as { observation?: V2ObservationState }).observation;
  delete (snapshot as { receipt?: unknown }).receipt;
  snapshot.backend = job.version === 2 ? "v2" : "v1";
  return structuredClone(snapshot);
}
function requestError(error: unknown): { name: string; message: string; status?: number } {
  // Persist operational diagnostics, never the submitted prompt or request body.
  if (error instanceof OpenCodeSubmissionError) return { name: error.name, message: "Submission outcome unknown; check this job before retrying." };
  if (error instanceof OpenCodeError) return { name: error.name, message: "OpenCode rejected the request", status: error.status };
  if (error instanceof BackendCapabilityError) return { name: error.name, message: error.message,
    ...{ code: error.code, capability: error.capability, backend: error.backend } };
  return { name: error instanceof Error ? error.name : "Error", message: "The request could not be completed" };
}

/** Match upstream's ascending message ID layout (12 hex timestamp + 14 random characters).
 * See OpenCode v1.18.31 packages/opencode/src/id/id.ts. The supplied prefix is msg_. */
let lastTimestamp = 0;
let idCounter = 0;
export function createMessageId(): string {
  const now = Date.now();
  idCounter = now === lastTimestamp ? idCounter + 1 : 1;
  lastTimestamp = now;
  const encoded = (BigInt(now) * 4096n + BigInt(idCounter)).toString(16).slice(-12).padStart(12, "0");
  return `msg_${encoded}${randomBytes(7).toString("hex")}`;
}

async function pendingInputs(client: OpenCodeClient, sessionId: string, directory: string | undefined, options: RequestOptions): Promise<PendingInput[]> {
  const values = await Promise.all((["question", "permission"] as const).map(async (kind) => {
    try {
      const response = await client.get<unknown>(`/${kind}`, undefined, directory, options);
      if (!Array.isArray(response)) throw new Error(`Invalid ${kind} list response`);
      return response.filter((input: any) => input?.sessionID === sessionId && typeof input.id === "string")
        .map((input: any) => ({ ...input, kind } as PendingInput));
    } catch (error) {
      if (error instanceof OpenCodeError && error.status === 404) return [];
      throw error;
    }
  }));
  return values.flat();
}

/** Observe a specific dispatched turn, or the latest user turn in a legacy session. */
export async function observeSession(
  client: OpenCodeClient, sessionId: string, directory?: string, messageId?: string, options: RequestOptions = {},
): Promise<JobSnapshot> {
  if (!sessionId) throw new Error("sessionId is required");
  if (client.getBackendIdentity?.().kind === "v2") {
    const adapter = backend(client) as V2Adapter;
    const context = createRequestContext(options);
    const request = { signal: context.signal, deadline: context.deadline };
    try {
      if (directory) {
        const session = await withAbort(adapter.api.session.get({ sessionID: sessionId }, request), context.signal);
        if (session.location.directory !== directory) throw new Error("Session belongs to a different server directory");
      }
      const target = messageId ?? (await withAbort(adapter.api.message.list({ sessionID: sessionId, type: "user", order: "desc", limit: 1 }, request), context.signal)).data[0]?.id;
      if (!target) return { backend: "v2", sessionId, directory, status: "unknown", inputs: [] };
      return (await observeV2Session(adapter.api, sessionId, target, request)).snapshot;
    } finally { context.dispose(); }
  }
  directory = normalizeDirectory(directory);
  const context = createRequestContext(options);
  const request = { signal: context.signal, deadline: context.deadline };
  let historyIncomplete = false;
  const readMessages = async () => {
    const path = `/session/${segment(sessionId)}/message`;
    try {
      return await client.get<unknown>(path, { limit: "100" }, directory, request);
    } catch (error) {
      // OpenCode 1.18.31 cannot encode persisted OutputFormat class instances
      // on user messages. A latest-assistant-only read avoids that broken row.
      // Require a known parent ID; partial history cannot establish ownership.
      if (!messageId || !isOutputFormatEncodingError(error)) throw error;
      historyIncomplete = true;
      try {
        return await client.get<unknown>(path, { limit: "1" }, directory, request);
      } catch (latestError) {
        // Before the assistant exists, even the latest row is the broken user.
        if (!isOutputFormatEncodingError(latestError)) throw latestError;
        return [];
      }
    }
  };
  try {
    const [statuses, session, response] = await Promise.all([
      client.get<Record<string, any>>("/session/status", undefined, directory, request),
      client.get<any>(`/session/${segment(sessionId)}`, undefined, directory, request),
      readMessages(),
    ]);
    if (!Array.isArray(response)) throw new Error("Invalid session message response");
    const messages = [...response].sort((a: any, b: any) =>
      (a?.info?.time?.created ?? 0) - (b?.info?.time?.created ?? 0) || String(a?.info?.id ?? "").localeCompare(String(b?.info?.id ?? "")));
    const latestUser = messages.filter((message: any) => message?.info?.role === "user").at(-1);
    const target = messageId ?? latestUser?.info?.id;
    const assistant = messages.filter((message: any) => message?.info?.role === "assistant" && (!target || message.info.parentID === target)).at(-1);
    const rawStatus = statuses?.[sessionId];
    const state = typeof rawStatus === "string" ? rawStatus : rawStatus?.type ?? rawStatus?.state ?? "idle";
    const snapshot: JobSnapshot = { sessionId, directory, messageId: target, status: "accepted", session };
    if (assistant) {
      snapshot.result = assistant.info.structured ?? assistant;
      snapshot.text = formatMessageResponse(assistant);
      if (assistant.info.error) {
        snapshot.error = assistant.info.error;
        snapshot.status = assistant.info.error.name === "MessageAbortedError" ? "cancelled" : "failed";
        return snapshot;
      }
      // A tool-call step can complete while the turn continues. Require idle,
      // a completed assistant and a final finish reason when supplied.
      // Validated structured output itself ends the turn, even though OpenCode
      // preserves the StructuredOutput step's "tool-calls" finish reason.
      if ((state === "idle" || (target && latestUser && latestUser.info.id !== target)) && typeof assistant.info.time?.completed === "number" &&
          (assistant.info.structured !== undefined || !["tool-calls", "unknown"].includes(assistant.info.finish))) {
        snapshot.status = "completed";
        return snapshot;
      }
    }
    if (state === "error" || state === "failed") {
      snapshot.status = "failed";
      snapshot.error = rawStatus?.error ?? { name: "SessionError", message: "Session reported an error" };
      return snapshot;
    }
    if (state === "busy" || state === "retry" || state === "running") snapshot.status = "running";
    if (historyIncomplete) {
      snapshot.status = "unknown";
      snapshot.error = { name: "MessageHistoryUnavailable", message: "OpenCode could not serialize message history. No completed result for the requested turn is available yet; observe this job again without resubmitting." };
      snapshot.inputs = [];
      return snapshot;
    }
    // A session can contain another active turn. Never offer its permissions
    // as inputs for an older job, even if that job's result is unavailable.
    if (target && latestUser && latestUser.info.id !== target) {
      snapshot.status = "unknown";
      snapshot.inputs = [];
      return snapshot;
    }
    snapshot.inputs = await pendingInputs(client, sessionId, directory, request);
    if (snapshot.inputs.length) snapshot.status = "input_required";
    return snapshot;
  } finally {
    context.dispose();
  }
}

function isOutputFormatEncodingError(error: unknown): boolean {
  if (!(error instanceof OpenCodeError) || error.status !== 400 || error.method !== "GET") return false;
  try {
    const body = JSON.parse(error.body);
    return body?.name === "BadRequest" && body.data?.kind === "Body" &&
      typeof body.data.message === "string" &&
      /^Expected OutputFormat(?:JsonSchema|Text), got /.test(body.data.message) &&
      body.data.message.includes('["info"]["format"]');
  } catch {
    return false;
  }
}

/** Durable ownership and observation handles. Prompt execution remains owned by OpenCode. */
export class JobService {
  private readonly store: string | null;
  private readonly ttl: number;
  private readonly directory?: string;
  private readonly memory = new Map<string, StoredJob>();
  private readonly memoryLocks = new Set<string>();

  constructor(private readonly client: OpenCodeClient, options: JobServiceOptions = {}) {
    this.ttl = options.ttlMs ?? 24 * 60 * 60 * 1000;
    if (!Number.isFinite(this.ttl) || this.ttl <= 0) throw new Error("Job TTL must be positive");
    this.directory = normalizeDirectory(options.directory);
    const scope = hash(JSON.stringify([client.getBaseUrl(), options.scope ?? "default"]));
    this.store = options.storeRoot === null ? null : join(options.storeRoot ?? join(process.platform === "win32" ? (process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")) : (process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state")), "opencode-mcp", "tasks"), scope);
  }

  selectModel(providerID?: string, modelID?: string, newSession = false) {
    return selectModel(this.client, providerID, modelID, newSession);
  }

  private checkId(jobId: string): void {
    if (!/^job_[a-f0-9]{32}$/.test(jobId)) throw new Error("Invalid job ID");
  }
  private async prepare(): Promise<void> {
    if (this.store) {
      await mkdir(this.store, { recursive: true, mode: 0o700 });
      await chmod(this.store, 0o700);
    }
  }
  private async read(jobId: string): Promise<StoredJob> {
    this.checkId(jobId);
    let job: StoredJob;
    try {
      if (!this.store) job = structuredClone(this.memory.get(jobId))!;
      else {
        try { job = JSON.parse(await readFile(join(this.store, `${jobId}.json`), "utf8")); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          job = JSON.parse(await readFile(join(this.store, "v2", `${jobId}.json`), "utf8"));
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Job not found in this server and credential scope");
      throw error;
    }
    if (!job || ![1, 2].includes(job.version) || job.jobId !== jobId ||
      (job.version === 2 && (job.backendIdentity?.kind !== "v2" || job.observation?.version !== 1))) throw new Error("Job not found or invalid job record");
    if (job.expiresAt <= Date.now()) {
      if (this.store) await rm(join(this.recordDirectory(job), `${jobId}.json`), { force: true });
      else this.memory.delete(jobId);
      throw new Error("Job expired; observe its OpenCode session directly if still available");
    }
    return job;
  }
  private async save(job: StoredJob): Promise<void> {
    job.updatedAt = Date.now();
    if (!this.store) { this.memory.set(job.jobId, structuredClone(job)); return; }
    await this.prepare();
    const directory = this.recordDirectory(job);
    if (job.version === 2) { await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700); }
    const path = join(directory, `${job.jobId}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(job), "utf8");
      await handle.sync();
      await handle.close();
      await rename(temporary, path);
    } finally {
      await handle.close().catch(() => {});
      await rm(temporary, { force: true });
    }
  }

  private recordDirectory(job: StoredJob): string {
    return job.version === 2 ? join(this.store!, "v2") : this.store!;
  }
  private assertActiveBackend(job: StoredJob): void {
    const kind = this.client.getBackendIdentity?.().kind ?? "v1";
    if (kind !== (job.version === 2 ? "v2" : "v1")) {
      throw new Error(`Active job belongs to ${job.version === 2 ? "v2" : "v1"}; connect to its recorded backend to observe or control it`);
    }
    this.client.assertBackendAvailable?.();
  }

  private async locked<T>(jobId: string, options: RequestOptions, action: () => Promise<T>): Promise<T> {
    this.checkId(jobId);
    const operation = createRequestContext(options);
    try { await this.prepare(); } catch (error) { operation.dispose(); throw error; }
    const context = createRequestContext({ signal: operation.signal, deadline: operation.deadline, timeout: Math.min(options.timeout ?? 5000, 5000) });
    let release: (() => Promise<void>) | undefined;
    try {
      while (!release) {
        throwIfAborted(context.signal);
        if (!this.store) {
          if (!this.memoryLocks.has(jobId)) {
            this.memoryLocks.add(jobId);
            release = async () => { this.memoryLocks.delete(jobId); };
          }
        } else {
          const lock = join(this.store, `${jobId}.lock`);
          try {
            await mkdir(lock, { mode: 0o700 });
            await open(join(lock, "owner.json"), "wx", 0o600).then(async (file) => {
              try { await file.writeFile(JSON.stringify({ pid: process.pid, host: hostname() })); }
              finally { await file.close(); }
            });
            release = async () => {
              await rm(join(lock, "owner.json"), { force: true });
              // No recursive deletion: a competing recovery guard must never
              // be removed by the previous owner.
              await rmdir(lock);
            };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            await this.recoverDeadOwner(lock);
          }
        }
        if (!release) await abortableSleep(25, context.signal);
      }
    } catch (error) {
      operation.dispose();
      throw error;
    } finally { context.dispose(); }
    try {
      throwIfAborted(operation.signal);
      return await withRequestOptions({ signal: operation.signal, deadline: operation.deadline }, action);
    } finally {
      operation.dispose();
      await release?.();
    }
  }

  private async recoverDeadOwner(lock: string): Promise<void> {
    let owner: { pid: number; host: string };
    try { owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")); }
    catch (error) {
      // Missing/partial metadata may belong to a live process still acquiring
      // the lock. Fail closed after the bounded lock wait, never steal it.
      if (["ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "") || error instanceof SyntaxError) return;
      throw error;
    }
    if (owner.host !== hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) return;
    try { process.kill(owner.pid, 0); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return; }
    // Only one process may reclaim this directory. Once the directory is
    // removed no operation below touches that pathname again.
    let guard;
    try { guard = await open(join(lock, "recovery"), "wx", 0o600); }
    catch (error) {
      if (["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    await guard.close();
    try {
      const current = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
      if (current.pid !== owner.pid || current.host !== owner.host) return;
      await rm(join(lock, "owner.json"));
    } finally { await rm(join(lock, "recovery"), { force: true }); }
    try { await rmdir(lock); }
    catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }

  async start(args: JobStartArgs, options: RequestOptions = {}): Promise<JobSnapshot> {
    if (typeof args.prompt !== "string" || !args.prompt.trim()) throw new Error("prompt is required");
    const v2 = this.client.getBackendIdentity?.().kind === "v2";
    if (v2) assertPromptOptions(args);
    const directory = normalizeDirectory(args.directory ?? this.directory);
    const now = Date.now();
    const messageId = createMessageId();
    const job: StoredJob = {
      ...(v2 ? { version: 2 as const, backendIdentity: this.client.getBackendIdentity(), observation: initialV2Observation(messageId) } : { version: 1 as const }),
      jobId: `job_${randomUUID().replaceAll("-", "")}`, sessionId: args.sessionId, messageId,
      directory, status: "unknown", createdAt: now, updatedAt: now, expiresAt: now + this.ttl, responses: {},
    };
    return this.locked(job.jobId, options, async () => {
      const context = createRequestContext(options);
      const request = { signal: context.signal, deadline: context.deadline, directory };
      try {
        throwIfAborted(context.signal);
        await this.save(job); // Record ownership before the first remote mutation.
        try {
          if (!job.sessionId) {
            const session = v2
              ? await operate(this.client, "sessions.create", { ...request, body: {
                title: args.title ?? "MCP delegated task", model: args.model, variant: args.variant, agent: args.agent,
              } })
              : await this.client.post<{ id: string }>("/session", { title: args.title ?? "MCP delegated task" }, request);
            if (typeof session?.id !== "string" || !session.id) throw new Error("OpenCode returned no session ID");
            job.sessionId = session.id;
            await this.save(job);
          }
          const body = {
            messageID: job.messageId, parts: [{ type: "text" as const, text: args.prompt }],
            ...(args.model ? { model: args.model } : {}), ...(args.variant ? { variant: args.variant } : {}),
            ...(args.agent ? { agent: args.agent } : {}), ...(args.format ? { format: args.format } : {}),
          };
          if (job.version === 2) {
            const receipt = await operate(this.client, "messages.enqueue", {
              ...request, sessionId: job.sessionId, body,
            });
            if (receipt?.id !== job.messageId || receipt?.sessionID !== job.sessionId) throw new Error("V2 prompt receipt identity mismatch");
            job.receipt = { id: receipt.id, sessionID: receipt.sessionID };
            job.observation.admitted = true; job.observation.queued = true;
          } else await this.client.post(`/session/${segment(job.sessionId)}/prompt_async`, body, request);
          job.status = "accepted";
        } catch (error) {
          job.status = error instanceof OpenCodeError || error instanceof BackendCapabilityError ? "failed" : "unknown";
          job.error = requestError(error);
        }
        await this.save(job);
        return publicSnapshot(job);
      } finally { context.dispose(); }
    });
  }

  private async refresh(job: StoredJob, options: RequestOptions): Promise<StoredJob> {
    if (terminal(job.status) || !job.sessionId) return job;
    this.assertActiveBackend(job);
    if (job.version === 2) {
      const { snapshot, state } = await observeV2Session((backend(this.client) as V2Adapter).api, job.sessionId, job.messageId!, options, job.observation);
      // A persisted uncertain write stays unknown unless durable evidence has
      // established admission or execution. Never dispatch from observation.
      if (job.status === "unknown" && snapshot.status === "accepted" && !state.admitted) snapshot.status = "unknown";
      if (job.cancelRequested && !terminal(snapshot.status)) snapshot.status = "unknown";
      const updated: StoredV2Job = { ...job, ...snapshot, observation: state };
      if (snapshot.status !== "unknown" && !snapshot.error) delete updated.error;
      await this.save(updated); return updated;
    }
    const observed = await observeSession(this.client, job.sessionId, job.directory, job.messageId, options);
    // Absence of a turn cannot prove that an ambiguous submission failed.
    if (job.status === "unknown" && (observed.status === "accepted" || (job.cancelRequested && !terminal(observed.status)))) observed.status = "unknown";
    const updated = { ...job, ...observed };
    if (observed.status !== "unknown") delete updated.error;
    if (observed.error) updated.error = observed.error;
    await this.save(updated);
    return updated;
  }

  async get(jobId: string, options: RequestOptions = {}): Promise<JobSnapshot> {
    return this.locked(jobId, options, async () => publicSnapshot(await this.refresh(await this.read(jobId), options)));
  }

  async list(limit = 50): Promise<JobSnapshot[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit must be an integer between 1 and 1000");
    await this.prepare();
    const names = this.store ? [...await readdir(this.store), ...await readdir(join(this.store, "v2")).catch(error => {
      if (error.code === "ENOENT") return [] as string[]; throw error;
    })] : [];
    const ids = this.store ? [...new Set(names.filter((name) => /^job_[a-f0-9]{32}\.json$/.test(name)).map((name) => name.slice(0, -5)))] : [...this.memory.keys()];
    const values: JobSnapshot[] = [];
    for (const id of ids) {
      try { values.push(publicSnapshot(await this.read(id))); }
      catch (error) { if (!(error instanceof Error && /expired|not found/.test(error.message))) throw error; }
    }
    return values.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, limit);
  }

  async cancel(jobId: string, options: RequestOptions = {}): Promise<JobSnapshot> {
    return this.locked(jobId, options, async () => {
      let job = await this.read(jobId);
      if (terminal(job.status)) return publicSnapshot(job);
      if (!job.sessionId) throw new Error("Cannot abort a job whose session creation outcome is unknown");
      job = await this.refresh(job, options);
      if (terminal(job.status)) return publicSnapshot(job);
      if (!job.sessionId) throw new Error("No known session to cancel");
      if (job.version === 2) {
        const api = (backend(this.client) as V2Adapter).api;
        const state = job.observation;
        if (!state.synced || state.ownershipLost || (!state.queued && (!state.ownsExecution || !state.userProjectionValidated))) {
          throw new Error("V2 turn ownership is not established; refusing to cancel unrelated work");
        }
        if (job.cancelRequested) return publicSnapshot(job);
        const context = createRequestContext(options);
        const request = { signal: context.signal };
        try {
          // All ownership/refusal reads precede the persisted write intent.
          if (!state.queued) {
            const inbox = await withAbort(api.session.inbox.list({ sessionID: job.sessionId }, request), context.signal);
            if (inbox.some(item => item.id !== job.messageId)) throw new Error("Other queued work belongs to this session; refusing to interrupt it");
          }
          throwIfAborted(context.signal);
          job.cancelRequested = true;
          await this.save(job);
          try {
            if (state.queued) {
              await withAbort(api.session.inbox.cancel({ sessionID: job.sessionId, inboxID: job.messageId! }, request), context.signal);
            } else {
              const interrupted = await withAbort(api.session.interrupt({ sessionID: job.sessionId, resume: false }, request), context.signal);
              if (!interrupted.interrupted) {
                // A definite no-op is retryable after a fresh ownership check.
                job.cancelRequested = false;
                throw new Error("V2 did not confirm an interrupted execution");
              }
            }
            job.status = "cancelled"; job.observation.outcome = "cancelled";
            delete job.error;
          } catch (rawError) {
            const error = unwrapV2Error(rawError);
            job.status = "unknown"; job.error = requestError(error);
            if (error instanceof OpenCodeError || error instanceof BackendCapabilityError) job.cancelRequested = false;
          }
          await this.save(job); return publicSnapshot(job);
        } finally { context.dispose(); }
      }
      // OpenCode's abort endpoint is session-wide: refuse to abort a newer turn.
      const messages = await this.client.get<any[]>(`/session/${segment(job.sessionId)}/message`, { limit: "100" }, job.directory, options);
      const users = messages.filter((message) => message?.info?.role === "user");
      const newest = users.sort((a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0) || String(a.info.id).localeCompare(String(b.info.id))).at(-1);
      if (newest && newest.info.id !== job.messageId) throw new Error("A newer turn owns this session; refusing to abort unrelated work");
      if (job.cancelRequested) return publicSnapshot(job);
      job.cancelRequested = true;
      await this.save(job);
      try {
        await this.client.post(`/session/${segment(job.sessionId)}/abort`, {}, { ...options, directory: job.directory });
        job.status = "cancelled";
        delete job.error;
      } catch (error) {
        job.status = "unknown";
        job.error = requestError(error);
        if (error instanceof OpenCodeError) job.cancelRequested = false;
      }
      await this.save(job);
      return publicSnapshot(job);
    });
  }

  async update(jobId: string, responses: JobInputResponse[], options: RequestOptions = {}): Promise<JobSnapshot> {
    if (!Array.isArray(responses) || responses.length < 1 || responses.length > 100) throw new Error("Provide between 1 and 100 input responses");
    return this.locked(jobId, options, async () => {
      let job = await this.read(jobId);
      if (terminal(job.status)) return publicSnapshot(job);
      job = await this.refresh(job, options);
      for (const response of responses) {
        if (!response || typeof response.id !== "string" || !["question", "permission"].includes(response.kind)) throw new Error("Invalid input response");
        const key = `${response.kind}:${response.id}`;
        const digest = hash(JSON.stringify({ id: response.id, kind: response.kind, answers: response.answers, reply: response.reply, reject: response.reject, message: response.message,
          ...(job.version === 2 ? { values: response.values, scope: response.scope, sessionId: response.sessionId } : {}) }));
        const previous = job.responses[key];
        if (previous) {
          if (previous.digest !== digest) throw new Error("This input already has a different submitted response");
          if (previous.state !== "sent") throw new Error("Previous reply outcome is unknown; it cannot be safely resent");
          continue;
        }
        const pending = job.inputs?.find((input) => input.id === response.id && input.kind === response.kind);
        if (!pending) throw new Error("Input does not belong to this job's pending requests");
        if (response.sessionId && response.sessionId !== job.sessionId) throw new Error("Input response session does not match this job");
        if (response.kind === "permission" && (!["once", "always", "reject"].includes(response.reply ?? "") || response.answers !== undefined || response.values !== undefined || response.reject !== undefined)) throw new Error("Permission response requires once, always, or reject without question answers");
        if (response.kind === "question" && (response.reply !== undefined || (response.reject === true && (response.answers !== undefined || response.values !== undefined)))) throw new Error("Question response requires answers or reject=true, exclusively");
        if (job.version === 2) {
          if (response.kind === "permission" && response.reply === "always" && response.scope !== "project") throw new Error("V2 always approval requires explicit scope: project");
          if (response.kind === "permission" && response.reply === "reject" && response.scope !== "session") throw new Error("V2 reject requires explicit scope: session");
          if (response.kind === "question" && !response.reject) {
            if (response.answers !== undefined) throw new Error("V2 job forms require typed field-keyed values");
            validateFormValues(pending.fields as FormField[], response.values);
          }
        } else {
          if (response.values !== undefined || response.scope !== undefined) throw new Error("Typed form values and permission scope require a V2 backend");
          if (response.kind === "question" && !response.reject && (!Array.isArray(response.answers) || !response.answers.every((answers) => Array.isArray(answers) && answers.every((answer) => typeof answer === "string")))) throw new Error("Question response requires an array of answer arrays");
        }
        job.responses[key] = { digest, state: "sending" };
        await this.save(job);
        try {
          const path = `/${response.kind}/${segment(response.id)}/${response.kind === "question" && response.reject ? "reject" : "reply"}`;
          const body = response.kind === "permission" ? { reply: response.reply, ...(response.message ? { message: response.message } : {}) } : response.reject ? undefined : { answers: response.answers };
          if (job.version === 2) {
            await operate(this.client, response.kind === "permission" ? "permissions.reply" : response.reject ? "forms.reject" : "forms.reply", {
              ...options, directory: job.directory, sessionId: job.sessionId, requestId: response.id,
              body: response.kind === "permission" ? { reply: response.reply, scope: response.scope, message: response.message, sessionId: job.sessionId }
                : { values: response.values, sessionId: job.sessionId },
            });
          } else await this.client.post(path, body, { ...options, directory: job.directory });
          job.responses[key].state = "sent";
        } catch (error) {
          if (error instanceof OpenCodeError || error instanceof BackendCapabilityError) delete job.responses[key];
          else job.responses[key].state = "unknown";
          job.error = requestError(error);
          await this.save(job);
          throw error;
        }
        await this.save(job);
      }
      return publicSnapshot(await this.refresh(job, options));
    });
  }
}
