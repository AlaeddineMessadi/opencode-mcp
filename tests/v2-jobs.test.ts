import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobService, observeSession } from "../src/jobs.js";
import { OpenCodeClient, OpenCodeError } from "../src/client.js";
import { backend } from "../src/backends/adapter.js";
import { BackendCapabilityError } from "../src/backends/contracts.js";
import { initialV2Observation, observeV2Session } from "../src/backends/v2-observation.js";
import { withRequestOptions } from "../src/async.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "opencode-v2-jobs-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const identity = { kind: "v2", version: "2.0.6", connectionSource: "explicit", processOwnership: "external", survivesDisconnect: true };
function fixture() {
  const events: any[] = [];
  const messages: Record<string, any> = {};
  let inbox: any[] = [], forms: any[] = [], permissions: any[] = [];
  let kind = "v2";
  const client = { getBaseUrl: () => "http://fixture:4096", getBackendIdentity: () => ({ ...identity, kind }), connectionHeaders: {} } as unknown as OpenCodeClient;
  const api: any = {
    session: {
      get: vi.fn(async () => ({ id: "session", title: "Fixture", location: { directory: "/remote/project" }, time: { created: 1, updated: 1 }, projectID: "project" })),
      log: vi.fn(({ after }: any) => (async function* () { for (const event of events) if (event.durable.seq > after) yield event; yield { type: "log.synced", aggregateID: "session", seq: events.at(-1)?.durable.seq ?? 0 }; })()),
      inbox: { list: vi.fn(async () => inbox), cancel: vi.fn(async () => ({})) },
      message: { get: vi.fn(async ({ messageID }: any) => { if (!messages[messageID]) throw new OpenCodeError("Not projected", 404, "GET", "/message", ""); return messages[messageID]; }) },
      form: { list: vi.fn(async () => forms) },
      interrupt: vi.fn(async () => ({ interrupted: true })),
    },
    permission: { list: vi.fn(async () => permissions) },
    message: { list: vi.fn(async () => ({ data: [], cursor: {} })) },
  };
  const adapter = backend(client);
  Object.defineProperty(adapter, "api", { value: api });
  const execute = vi.spyOn(adapter, "execute").mockImplementation(async (operation, args) => {
    const body = args.body as any;
    if (operation === "sessions.create") return { id: "session" };
    if (operation === "messages.enqueue") { inbox.push({ id: body.messageID }); return { id: body.messageID, sessionID: "session" }; }
    if (operation === "permissions.reply") { permissions = []; return {}; }
    if (operation === "forms.reply" || operation === "forms.reject") { forms = []; return {}; }
    throw new Error(`Unexpected ${operation}`);
  });
  const event = (type: string, data: any = {}) => { events.push({ type: `session.${type}`, durable: { aggregateID: "session", seq: events.length + 1, version: 1 }, data: { sessionID: "session", ...data } }); };
  const enqueue = (id: string, delivery = "queue", type = "user") => event("inbox.enqueued", { inboxID: id, item: { type, delivery } });
  const deliver = (id: string) => { event("inbox.delivered", { inboxID: id }); inbox = inbox.filter(item => item.id !== id); messages[id] = { id, type: "user", text: "Fixture prompt", time: { created: 1 } }; };
  const step = (id: string, finish = "stop") => {
    event("step.started", { assistantMessageID: id });
    messages[id] = { id, type: "assistant", time: { created: 2, completed: 3 }, content: [{ type: "text", text: `Result ${id}` }], finish };
    event("step.ended", { assistantMessageID: id, finish });
  };
  return { client, api, execute, events, event, enqueue, deliver, step, messages,
    kind: (value: string) => { kind = value; }, inbox: (value: any[]) => { inbox = value; },
    forms: (value: any[]) => { forms = value; }, permissions: (value: any[]) => { permissions = value; } };
}
async function records() { const namespace = join(root, (await readdir(root))[0]); const path = join(namespace, "v2"); return Promise.all((await readdir(path)).map(async name => JSON.parse(await readFile(join(path, name), "utf8")))); }
async function running(f: ReturnType<typeof fixture>, service: JobService) {
  const job = await service.start({ prompt: "private task", sessionId: "session" });
  f.enqueue(job.messageId!); f.event("execution.started"); f.deliver(job.messageId!);
  return job;
}

describe("V2 durable observation", () => {
  it("does not attribute a prior turn's inputs or completion to a queued job", async () => {
    const f = fixture(); f.enqueue("target"); f.event("execution.started"); f.deliver("earlier"); f.step("earlier-result"); f.event("execution.succeeded"); f.inbox([{ id: "target" }]);
    f.forms([{ id: "other", sessionID: "session" }]);
    const observed = await observeV2Session(f.api, "session", "target");
    expect(observed.snapshot).toMatchObject({ backend: "v2", status: "accepted", inputs: [] });
    expect(f.api.session.message.get).not.toHaveBeenCalled();
    expect(f.api.session.form.list).not.toHaveBeenCalled();
  });
  it("completes two queued turns drained within one execution independently", async () => {
    const f = fixture(); f.enqueue("first"); f.enqueue("second"); f.event("execution.started"); f.deliver("first"); f.step("answer1"); f.deliver("second"); f.step("answer2"); f.event("execution.succeeded");
    const first = await observeV2Session(f.api, "session", "first");
    const second = await observeV2Session(f.api, "session", "second");
    expect(first.snapshot).toMatchObject({ status: "completed", result: { info: { id: "answer1", parentID: "first" } } });
    expect(second.snapshot).toMatchObject({ status: "completed", result: { info: { id: "answer2", parentID: "second" } } });
  });
  it.each(["tool-calls", "unknown", "error"])("does not treat %s as a final queued turn boundary", async finish => {
    const f = fixture(); f.enqueue("target"); f.enqueue("next"); f.event("execution.started"); f.deliver("target"); f.step("partial", finish); f.deliver("next"); f.step("other"); f.event("execution.succeeded");
    expect((await observeV2Session(f.api, "session", "target")).snapshot.status).toBe("unknown");
  });
  it("does not attribute a steered turn even after a final step", async () => {
    const f = fixture(); f.enqueue("target"); f.enqueue("steer", "steer"); f.event("execution.started"); f.deliver("target"); f.step("first"); f.deliver("steer"); f.step("other"); f.event("execution.succeeded");
    const observed = await observeV2Session(f.api, "session", "target");
    expect(observed.snapshot.status).toBe("unknown"); expect(observed.state.ownershipLost).toBe(true);
    expect(observed.state.assistantIds).toEqual(["first"]);
  });
  it.each([{ id: "wrong", type: "user" }, { id: "target", type: "assistant" }])("refuses mismatched delivered user projection %j", async projection => {
    const f = fixture(); f.enqueue("target"); f.event("execution.started"); f.deliver("target"); f.step("answer"); f.event("execution.succeeded");
    f.messages.target = projection;
    const result = await observeV2Session(f.api, "session", "target");
    expect(result.snapshot.status).toBe("unknown"); expect(result.state.userProjectionValidated).not.toBe(true);
    expect(result.snapshot.result).toBeUndefined(); expect(result.snapshot.inputs).toEqual([]);
  });
  it("recovers a delayed user projection before claiming terminal output", async () => {
    const f = fixture(); f.enqueue("target"); f.event("execution.started"); f.deliver("target"); f.step("answer"); f.event("execution.succeeded");
    const projected = f.messages.target; delete f.messages.target;
    const before = await observeV2Session(f.api, "session", "target");
    expect(before.snapshot.status).toBe("unknown"); expect(before.state.userProjectionValidated).not.toBe(true);
    f.messages.target = projected;
    const after = await observeV2Session(f.api, "session", "target", {}, before.state);
    expect(after.snapshot.status).toBe("completed"); expect(after.state.userProjectionValidated).toBe(true);
  });
  it("withholds form controls until delivered user projection validates", async () => {
    const f = fixture(); f.enqueue("target"); f.event("execution.started"); f.deliver("target"); delete f.messages.target;
    f.forms([{ id: "form", sessionID: "session" }]);
    const before = await observeV2Session(f.api, "session", "target");
    expect(before.snapshot).toMatchObject({ status: "unknown", inputs: [] }); expect(f.api.session.form.list).not.toHaveBeenCalled();
    f.messages.target = { id: "target", type: "user", text: "Fixture prompt", time: { created: 1 } };
    expect((await observeV2Session(f.api, "session", "target", {}, before.state)).snapshot.status).toBe("input_required");
  });
  it("preserves delivery and assistant correlation across restart", async () => {
    const f = fixture(); f.enqueue("target"); f.event("execution.started"); f.deliver("target"); f.step("answer");
    const before = await observeV2Session(f.api, "session", "target");
    f.event("execution.succeeded");
    const after = await observeV2Session(f.api, "session", "target", {}, JSON.parse(JSON.stringify(before.state)));
    expect(after.snapshot.status).toBe("completed");
    expect(f.api.session.log.mock.calls.at(-1)[0].after).toBe(before.state.cursor);
  });
  it("recovers shutdown interruption without replaying admission", async () => {
    const f = fixture(); f.enqueue("target"); f.event("execution.started"); f.deliver("target"); f.event("execution.interrupted", { reason: "shutdown" });
    const before = await observeV2Session(f.api, "session", "target"); expect(before.snapshot.status).toBe("unknown");
    f.event("execution.started"); f.step("answer"); f.event("execution.succeeded");
    expect((await observeV2Session(f.api, "session", "target", {}, before.state)).snapshot.status).toBe("completed");
  });
  it("retains turn ownership across explicit compaction control delivery", async () => {
    const f = fixture(); f.enqueue("target"); f.event("execution.started"); f.deliver("target"); f.step("partial", "tool-calls"); f.enqueue("compact", "queue", "compaction"); f.deliver("compact"); f.step("final"); f.event("execution.succeeded");
    expect((await observeV2Session(f.api, "session", "target")).snapshot).toMatchObject({ status: "completed", result: { info: { id: "final" } } });
  });
  it.each([NaN, -1, 0.5])("rejects malformed sync sequence %s", async seq => {
    const f = fixture(); f.api.session.log.mockImplementation(() => (async function* () { yield { type: "log.synced", aggregateID: "session", seq }; })());
    const result = await observeV2Session(f.api, "session", "target"); expect(result.snapshot.status).toBe("unknown"); expect(result.state.cursor).toBe(0); expect(result.state.synced).toBe(false);
  });
  it("accepts native filtered sequence gaps and advances the validated sync cursor", async () => {
    const f = fixture(); f.enqueue("target"); f.event("execution.started"); f.events[1].durable.seq = 3;
    const observed = await observeV2Session(f.api, "session", "target"); expect(observed.state.cursor).toBe(3); expect(observed.state.synced).toBe(true);
  });
});

describe("V2 durable job controls", () => {
  it("persists assigned message identity before dispatch, excludes prompt text, and rejects unsupported format before any writes", async () => {
    const f = fixture(); const service = new JobService(f.client, { storeRoot: root });
    const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (operation, args) => { if (operation === "messages.enqueue") { const [record] = await records(); expect(record).toMatchObject({ version: 2, messageId: (args.body as any).messageID, sessionId: "session" }); expect(JSON.stringify(record)).not.toContain("private task"); } return original(operation, args); });
    const job = await service.start({ prompt: "private task" }); expect(job.status).toBe("accepted");
    expect((await records())[0].receipt).toEqual({ id: job.messageId, sessionID: "session" });
    const calls = f.execute.mock.calls.length;
    await expect(service.start({ prompt: "x", format: { type: "json_schema", schema: {} } })).rejects.toThrow();
    expect(f.execute).toHaveBeenCalledTimes(calls); expect(await records()).toHaveLength(1);
  });
  it("recovers ambiguous admission from durable replay without resubmission", async () => {
    const f = fixture(); const service = new JobService(f.client, { storeRoot: root });
    f.execute.mockImplementation(async (operation, args) => { if (operation === "messages.enqueue") { f.enqueue((args.body as any).messageID); throw new Error("lost receipt"); } return { id: "session" }; });
    const job = await service.start({ prompt: "x", sessionId: "session" }); expect(job.status).toBe("unknown");
    f.event("execution.started"); f.deliver(job.messageId!); f.step("answer"); f.event("execution.succeeded");
    const restarted = new JobService(f.client, { storeRoot: root }); expect((await restarted.get(job.jobId!)).status).toBe("completed"); expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it("does not accept a mismatched admission receipt", async () => {
    const f = fixture(); f.execute.mockResolvedValue({ id: "wrong", sessionID: "session" });
    expect((await new JobService(f.client, { storeRoot: root }).start({ prompt: "x", sessionId: "session" })).status).toBe("unknown");
  });
  it("retains actionable capability errors", async () => {
    const f = fixture(); f.execute.mockRejectedValue(new BackendCapabilityError("model.selection", "Use session selection", "v2"));
    const job = await new JobService(f.client, { storeRoot: root }).start({ prompt: "x", sessionId: "session" });
    expect(job).toMatchObject({ status: "failed", error: { code: "UNSUPPORTED_CAPABILITY", backend: "v2" } });
  });
  it("cancels only its queued inbox entry while another turn is active", async () => {
    const f = fixture(); const service = new JobService(f.client, { storeRoot: root }); const job = await service.start({ prompt: "x", sessionId: "session" });
    f.enqueue(job.messageId!); f.event("execution.started"); f.deliver("unrelated");
    expect((await service.cancel(job.jobId!)).status).toBe("cancelled"); expect(f.api.session.interrupt).not.toHaveBeenCalled();
    expect(f.api.session.inbox.cancel).toHaveBeenCalledWith({ sessionID: "session", inboxID: job.messageId }, expect.anything());
  });
  it("refuses active cancellation until user projection ownership validates", async () => {
    const f = fixture(); const service = new JobService(f.client, { storeRoot: root }); const job = await running(f, service);
    delete f.messages[job.messageId!];
    await expect(service.cancel(job.jobId!)).rejects.toThrow("ownership is not established");
    expect(f.api.session.interrupt).not.toHaveBeenCalled(); expect((await records())[0].cancelRequested).toBeUndefined();
  });
  it("refuses other queued work before recording intent and permits later cancellation", async () => {
    const f = fixture(); const service = new JobService(f.client, { storeRoot: root }); const job = await running(f, service);
    f.inbox([{ id: "other" }]); await expect(service.cancel(job.jobId!)).rejects.toThrow("Other queued work");
    expect((await records())[0].cancelRequested).toBeUndefined(); expect(f.api.session.interrupt).not.toHaveBeenCalled();
    f.inbox([]); expect((await service.cancel(job.jobId!)).status).toBe("cancelled");
  });
  it("bounds a hung cancellation and never replays its ambiguous mutation", async () => {
    const f = fixture(); const service = new JobService(f.client, { storeRoot: root }); const job = await running(f, service);
    f.api.session.interrupt.mockImplementation(() => new Promise(() => {}));
    expect((await withRequestOptions({ timeout: 30 }, () => service.cancel(job.jobId!))).status).toBe("unknown");
    expect((await service.cancel(job.jobId!)).status).toBe("unknown"); expect(f.api.session.interrupt).toHaveBeenCalledTimes(1);
  });
  it("allows retry after a definite nested SDK cancellation rejection", async () => {
    const f = fixture(); const service = new JobService(f.client, { storeRoot: root }); const job = await running(f, service);
    f.api.session.interrupt.mockRejectedValueOnce({ cause: { cause: new OpenCodeError("Rejected", 409, "POST", "/interrupt", "") } });
    expect((await service.cancel(job.jobId!)).status).toBe("unknown"); expect((await records())[0].cancelRequested).toBe(false);
    expect((await service.cancel(job.jobId!)).status).toBe("cancelled");
  });
  it("allows corrected permission scope after a local rejection without poisoning receipts", async () => {
    const f = fixture(); const service = new JobService(f.client, { storeRoot: root }); const job = await running(f, service);
    f.permissions([{ id: "permission", sessionID: "session", action: "shell", resources: [], save: [] }]);
    await expect(service.update(job.jobId!, [{ id: "permission", kind: "permission", reply: "reject" }])).rejects.toThrow("scope: session");
    expect((await records())[0].responses).toEqual({});
    await service.update(job.jobId!, [{ id: "permission", kind: "permission", reply: "reject", scope: "session" }]);
    expect((await records())[0].responses["permission:permission"].state).toBe("sent");
  });
  it("validates typed forms before receipt persistence and deduplicates the same response across services", async () => {
    const f = fixture(); const service = new JobService(f.client, { storeRoot: root }); const job = await running(f, service);
    const form = { id: "form", sessionID: "session", fields: [{ key: "count", type: "integer", required: true, minimum: 1 }, { key: "approve", type: "boolean", required: true }] };
    f.forms([form]);
    await expect(service.update(job.jobId!, [{ id: "form", kind: "question", values: { count: "two", approve: true } }])).rejects.toThrow("Invalid value");
    expect((await records())[0].responses).toEqual({});
    const response = { id: "form", kind: "question" as const, values: { count: 2, approve: false } };
    const another = new JobService(f.client, { storeRoot: root });
    await Promise.all([service.update(job.jobId!, [response]), another.update(job.jobId!, [response])]);
    expect(f.execute.mock.calls.filter(([operation]) => operation === "forms.reply")).toHaveLength(1);
  });
  it("permits correction after a known adapter preflight error and blocks uncertain input replay", async () => {
    const f = fixture(); const service = new JobService(f.client, { storeRoot: root }); const job = await running(f, service);
    f.permissions([{ id: "permission", sessionID: "session", action: "shell", resources: [], save: [] }]);
    const original = f.execute.getMockImplementation()!;
    let failure: unknown = new BackendCapabilityError("permission.scope", "Explicit scope required");
    f.execute.mockImplementation(async (operation, args) => { if (operation === "permissions.reply") throw failure; return original(operation, args); });
    const response = { id: "permission", kind: "permission" as const, reply: "once" as const };
    await expect(service.update(job.jobId!, [response])).rejects.toThrow("Explicit scope");
    expect((await records())[0].responses).toEqual({});
    failure = new Error("Connection lost after write");
    await expect(service.update(job.jobId!, [response])).rejects.toThrow();
    expect((await records())[0].responses["permission:permission"].state).toBe("unknown");
    const calls = f.execute.mock.calls.length;
    await expect(service.update(job.jobId!, [response])).rejects.toThrow("cannot be safely resent"); expect(f.execute).toHaveBeenCalledTimes(calls);
  });
  it("combines backend records, rejects active backend mismatch, and reads cached terminal results", async () => {
    const f = fixture(); const service = new JobService(f.client, { storeRoot: root }); const active = await service.start({ prompt: "x", sessionId: "session" });
    const finished = await running(f, service); f.step("answer"); f.event("execution.succeeded"); await service.get(finished.jobId!);
    f.kind("v1"); const v1 = { getBaseUrl: f.client.getBaseUrl, post: vi.fn(async (path: string) => path === "/session" ? { id: "v1session" } : undefined) } as unknown as OpenCodeClient;
    const legacy = await new JobService(v1, { storeRoot: root }).start({ prompt: "legacy" });
    expect((await service.list()).map(job => job.backend).sort()).toEqual(["v1", "v2", "v2"]);
    await expect(service.get(active.jobId!)).rejects.toThrow("recorded backend"); expect((await service.get(finished.jobId!)).status).toBe("completed");
    const namespace = join(root, (await readdir(root))[0]); const record = JSON.parse(await readFile(join(namespace, `${legacy.jobId}.json`), "utf8"));
    expect(record.version).toBe(1); expect(record.backendIdentity).toBeUndefined(); expect(record.observation).toBeUndefined();
  });
  it("bounds inherited observation deadlines and rejects a different remote directory", async () => {
    const f = fixture(); f.api.message.list.mockImplementation(() => new Promise(() => {}));
    await expect(withRequestOptions({ timeout: 20 }, () => observeSession(f.client, "session"))).rejects.toThrow("deadline");
    await expect(observeSession(f.client, "session", "/wrong", "target")).rejects.toThrow("different server directory");
  });
});
