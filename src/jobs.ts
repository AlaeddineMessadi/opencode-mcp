import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, rmdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { OpenCodeClient, OpenCodeError, OpenCodeSubmissionError } from "./client.js";
import { abortableSleep, createRequestContext, throwIfAborted, withRequestOptions, type RequestOptions } from "./async.js";
import { formatMessageResponse, normalizeDirectory } from "./helpers.js";

export type JobStatus = "accepted" | "running" | "input_required" | "completed" | "failed" | "cancelled" | "unknown";
export interface PendingInput {
  id: string;
  kind: "question" | "permission";
  sessionID: string;
  [key: string]: unknown;
}
export interface JobSnapshot {
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
}
export interface JobInputResponse {
  id: string;
  kind: "question" | "permission";
  answers?: string[][];
  reply?: "once" | "always" | "reject";
  reject?: boolean;
  message?: string;
}
export interface JobServiceOptions {
  /** null creates a process-local store for isolated tests or ephemeral clients. */
  storeRoot?: string | null;
  /** Opaque identity supplied by the caller, including auth identity if used. */
  scope?: string;
  directory?: string;
  ttlMs?: number;
}
interface StoredJob extends JobSnapshot {
  jobId: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  version: 1;
  /** Persisted before sending each reply: an uncertain reply is never replayed. */
  responses: Record<string, { digest: string; state: "sending" | "sent" | "unknown" }>;
  cancelRequested?: boolean;
}
const terminal = (status: JobStatus) => ["completed", "failed", "cancelled"].includes(status);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const segment = (value: string) => encodeURIComponent(value);

/**
 * Convert MCP elicitation answers (one array of selected labels per form
 * field, in field order) into the OpenCode 2.x Form.Reply answer map.
 * Option labels are resolved to option values when they differ.
 */
function formAnswer(form: PendingInput | undefined, answers: string[][] | undefined): Record<string, unknown> {
  const raw = (form as unknown as { fields?: unknown })?.fields;
  const fields: any[] = Array.isArray(raw) ? raw : [];
  const answer: Record<string, unknown> = {};
  fields.forEach((field: any, index: number) => {
    const selected = answers?.[index] ?? [];
    const optionValue = (label: string): string => {
      const options = Array.isArray(field?.options) ? field.options : [];
      const match = options.find((option: any) => option?.value === label || option?.label === label);
      return typeof match?.value === "string" ? match.value : label;
    };
    if (field?.type === "multiselect") answer[field.key] = selected.map(optionValue);
    else if (field?.type === "boolean") answer[field.key] = selected[0] === "true";
    else if (field?.type === "number" || field?.type === "integer") {
      const numeric = Number(selected[0]);
      answer[field.key] = Number.isFinite(numeric) ? numeric : 0;
    } else answer[field.key] = selected[0] === undefined ? "" : optionValue(selected[0]);
  });
  return answer;
}

function publicSnapshot(job: StoredJob): JobSnapshot {
  const { version: _version, responses: _responses, cancelRequested: _cancelRequested, ...snapshot } = job;
  return structuredClone(snapshot);
}
function requestError(error: unknown): { name: string; message: string; status?: number } {
  // Persist operational diagnostics, never the submitted prompt or request body.
  if (error instanceof OpenCodeSubmissionError) return { name: error.name, message: "Submission outcome unknown; check this job before retrying." };
  if (error instanceof OpenCodeError) return { name: error.name, message: "OpenCode rejected the request", status: error.status };
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
  // OpenCode 2.x: pending questions are forms (GET /api/form) and pending
  // permissions are requests (GET /api/permission/request); both are
  // location-scoped lists that must be filtered to this session.
  const [forms, permissions] = await Promise.all((["/api/form", "/api/permission/request"] as const).map(async (path) => {
    try {
      const response = await client.get<unknown>(path, undefined, directory, options);
      if (!Array.isArray(response)) throw new Error(`Invalid ${path} list response`);
      return response as Array<Record<string, unknown>>;
    } catch (error) {
      if (error instanceof OpenCodeError && error.status === 404) return [];
      throw error;
    }
  }));
  const inputs: PendingInput[] = [];
  for (const form of forms) {
    if (form?.sessionID === sessionId && typeof form.id === "string") inputs.push({ ...form, kind: "question" } as PendingInput);
  }
  for (const permission of permissions) {
    if (permission?.sessionID === sessionId && typeof permission.id === "string") inputs.push({ ...permission, kind: "permission" } as PendingInput);
  }
  return inputs;
}

/**
 * Read a session's messages in ascending creation order.
 * OpenCode 2.x returns newest-first; sorting normalizes either order.
 */
async function readTurnMessages(
  client: OpenCodeClient, sessionId: string, directory: string | undefined, request: { signal?: AbortSignal; deadline?: number }, limit = "100",
): Promise<any[]> {
  const response = await client.get<unknown>(`/api/session/${segment(sessionId)}/message`, { limit }, directory, request);
  if (!Array.isArray(response)) throw new Error("Invalid session message response");
  return [...response].sort((a: any, b: any) =>
    (a?.time?.created ?? 0) - (b?.time?.created ?? 0) || String(a?.id ?? "").localeCompare(String(b?.id ?? "")));
}

/** Observe a specific dispatched turn, or the latest user turn in a session. */
export async function observeSession(
  client: OpenCodeClient, sessionId: string, directory?: string, messageId?: string, options: RequestOptions = {},
): Promise<JobSnapshot> {
  if (!sessionId) throw new Error("sessionId is required");
  directory = normalizeDirectory(directory);
  const context = createRequestContext(options);
  const request = { signal: context.signal, deadline: context.deadline };
  try {
    const [active, session, messages] = await Promise.all([
      client.get<Record<string, any>>("/api/session/active", undefined, directory, request).catch(() => ({}) as Record<string, any>),
      client.get<any>(`/api/session/${segment(sessionId)}`, undefined, directory, request),
      readTurnMessages(client, sessionId, directory, request),
    ]);
    const latestUser = messages.filter((message: any) => message?.type === "user").at(-1);
    const target = messageId ?? latestUser?.id;
    const snapshot: JobSnapshot = { sessionId, directory, messageId: target, status: "accepted", session };
    const targetIndex = messages.findIndex((message: any) => message?.id === target);
    // The turn is everything after our user message, up to and including the
    // idle marker that closes it: user → assistant* → idle. A newer user
    // message ends the slice, so a finished older turn is still recognised.
    const rest = targetIndex >= 0 ? messages.slice(targetIndex + 1) : [];
    const nextUser = rest.findIndex((message: any) => message?.type === "user");
    const turn = nextUser >= 0 ? rest.slice(0, nextUser) : rest;
    const idleMarker = turn.find((message: any) => message?.type === "idle");
    // A session can contain another active turn. Never offer its forms or
    // permissions as inputs for an older job, even if its result is unavailable.
    if (!idleMarker && target && latestUser && latestUser.id !== target) {
      snapshot.status = "unknown";
      snapshot.inputs = [];
      return snapshot;
    }
    const assistants = turn.filter((message: any) => message?.type === "assistant");
    const assistant = assistants.at(-1);
    if (assistant) {
      snapshot.result = assistant;
      snapshot.text = formatMessageResponse(assistant);
    }
    if (idleMarker) {
      if (idleMarker.outcome === "interrupted") {
        snapshot.status = "cancelled";
        return snapshot;
      }
      if (idleMarker.outcome === "failed") {
        snapshot.status = "failed";
        snapshot.error = idleMarker.error ?? { name: "SessionError", message: "Session reported an error" };
        return snapshot;
      }
      snapshot.status = "completed";
      return snapshot;
    }
    // No idle marker yet: the run is queued, running, or its outcome unknown.
    const running = typeof active?.[sessionId]?.type === "string";
    if (running || assistants.length > 0) snapshot.status = "running";
    snapshot.inputs = await pendingInputs(client, sessionId, directory, request);
    if (snapshot.inputs.length) snapshot.status = "input_required";
    return snapshot;
  } finally {
    context.dispose();
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
      job = this.store ? JSON.parse(await readFile(join(this.store, `${jobId}.json`), "utf8")) : structuredClone(this.memory.get(jobId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Job not found in this server and credential scope");
      throw error;
    }
    if (!job || job.version !== 1 || job.jobId !== jobId) throw new Error("Job not found or invalid job record");
    if (job.expiresAt <= Date.now()) {
      if (this.store) await rm(join(this.store, `${jobId}.json`), { force: true });
      else this.memory.delete(jobId);
      throw new Error("Job expired; observe its OpenCode session directly if still available");
    }
    return job;
  }
  private async save(job: StoredJob): Promise<void> {
    job.updatedAt = Date.now();
    if (!this.store) { this.memory.set(job.jobId, structuredClone(job)); return; }
    await this.prepare();
    const path = join(this.store, `${job.jobId}.json`);
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
    const directory = normalizeDirectory(args.directory ?? this.directory);
    const now = Date.now();
    const job: StoredJob = {
      version: 1, jobId: `job_${randomUUID().replaceAll("-", "")}`, sessionId: args.sessionId, messageId: createMessageId(),
      directory, status: "unknown", createdAt: now, updatedAt: now, expiresAt: now + this.ttl, responses: {},
    };
    return this.locked(job.jobId, options, async () => {
      const context = createRequestContext(options);
      const request = { signal: context.signal, deadline: context.deadline, directory };
      try {
        throwIfAborted(context.signal);
        await this.save(job); // Record ownership before the first remote mutation.
        try {
          const model = args.model
            ? { id: args.model.modelID, providerID: args.model.providerID, ...(args.variant ? { variant: args.variant } : {}) }
            : undefined;
          if (!job.sessionId) {
            // OpenCode 2.x: session creation takes the model and location in the
            // body; the x-opencode-directory header does not scope POST /api/session.
            const session = await this.client.post<{ id: string }>("/api/session", {
              title: args.title ?? "MCP delegated task",
              ...(model ? { model } : {}),
              ...(directory ? { location: { directory } } : {}),
            }, request);
            if (typeof session?.id !== "string" || !session.id) throw new Error("OpenCode returned no session ID");
            job.sessionId = session.id;
            await this.save(job);
          } else if (model) {
            // v2 prompts no longer accept a model; switch the session instead.
            await this.client.post(`/api/session/${segment(job.sessionId)}/model`, { model }, request);
          }
          // v2 prompts return immediately with the queued user message; the
          // pre-assigned id lets observeSession attribute the turn later.
          await this.client.post(`/api/session/${segment(job.sessionId)}/prompt`, {
            id: job.messageId, text: args.prompt, ...(args.agent ? { agent: args.agent } : {}),
          }, request);
          job.status = "accepted";
        } catch (error) {
          job.status = error instanceof OpenCodeError ? "failed" : "unknown";
          job.error = requestError(error);
        }
        await this.save(job);
        return publicSnapshot(job);
      } finally { context.dispose(); }
    });
  }

  private async refresh(job: StoredJob, options: RequestOptions): Promise<StoredJob> {
    if (terminal(job.status) || !job.sessionId) return job;
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
    const ids = this.store ? (await readdir(this.store)).filter((name) => /^job_[a-f0-9]{32}\.json$/.test(name)).map((name) => name.slice(0, -5)) : [...this.memory.keys()];
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
      // OpenCode 2.x's interrupt is session-wide: refuse to abort a newer turn.
      const messages = await this.client.get<any[]>(`/api/session/${segment(job.sessionId)}/message`, { limit: "100" }, job.directory, options);
      const users = messages.filter((message) => message?.type === "user")
        .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0) || String(a.id).localeCompare(String(b.id)));
      const newest = users.at(-1);
      if (newest && newest.id !== job.messageId) throw new Error("A newer turn owns this session; refusing to abort unrelated work");
      if (job.cancelRequested) return publicSnapshot(job);
      job.cancelRequested = true;
      await this.save(job);
      try {
        // resume=false ends the turn; an idle marker with outcome "interrupted"
        // is appended so later observations stay consistent.
        await this.client.post(`/api/session/${segment(job.sessionId)}/interrupt?resume=false`, undefined, { ...options, directory: job.directory });
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
        const digest = hash(JSON.stringify({ id: response.id, kind: response.kind, answers: response.answers, reply: response.reply, reject: response.reject, message: response.message }));
        const previous = job.responses[key];
        if (previous) {
          if (previous.digest !== digest) throw new Error("This input already has a different submitted response");
          if (previous.state !== "sent") throw new Error("Previous reply outcome is unknown; it cannot be safely resent");
          continue;
        }
        if (!job.inputs?.some((input) => input.id === response.id && input.kind === response.kind)) throw new Error("Input does not belong to this job's pending requests");
        if (response.kind === "permission" && (!["once", "always", "reject"].includes(response.reply ?? "") || response.answers !== undefined || response.reject !== undefined)) throw new Error("Permission response requires once, always, or reject without question answers");
        if (response.kind === "question" && (response.reply !== undefined || (response.reject === true && response.answers !== undefined))) throw new Error("Question response requires answers or reject=true, exclusively");
        if (response.kind === "question" && !response.reject && (!Array.isArray(response.answers) || !response.answers.every((answers) => Array.isArray(answers) && answers.every((answer) => typeof answer === "string")))) throw new Error("Question response requires an array of answer arrays");
        job.responses[key] = { digest, state: "sending" };
        await this.save(job);
        try {
          const input = job.inputs?.find((pending) => pending.id === response.id && pending.kind === response.kind);
          const sessionId = (input as { sessionID?: string } | undefined)?.sessionID ?? job.sessionId;
          if (!sessionId) throw new Error("No session associated with this input");
          if (response.kind === "permission") {
            await this.client.post(
              `/api/session/${segment(sessionId)}/permission/${segment(response.id)}/reply`,
              { decision: response.reply, ...(response.message ? { message: response.message } : {}) },
              { ...options, directory: job.directory },
            );
          } else if (response.reject) {
            await this.client.delete(`/api/session/${segment(sessionId)}/form/${segment(response.id)}`, undefined, job.directory, options);
          } else {
            await this.client.post(
              `/api/session/${segment(sessionId)}/form/${segment(response.id)}/reply`,
              { answer: formAnswer(input, response.answers) },
              { ...options, directory: job.directory },
            );
          }
          job.responses[key].state = "sent";
        } catch (error) {
          if (error instanceof OpenCodeError) delete job.responses[key];
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
