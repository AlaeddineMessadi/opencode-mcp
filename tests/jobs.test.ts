import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { JobService, observeSession } from "../src/jobs.js";
import { OpenCodeClient, OpenCodeError, OpenCodeSubmissionError } from "../src/client.js";
import { withRequestOptions } from "../src/async.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "opencode-jobs-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

const SID = "ses_fixture";

/**
 * In-memory OpenCode 2.x backend. Shapes follow the 2.1.2 OpenAPI spec after
 * the client has unwrapped the `{ data }` envelope: flat messages tagged by
 * `type` (user / assistant / idle), GET /api/session/active keyed by session,
 * location-scoped GET /api/form and GET /api/permission/request lists.
 */
function backend() {
  let running = false;
  let messages: any[] = [];
  let forms: any[] = [];
  let permissions: any[] = [];
  let clock = 1000;
  let counter = 0;
  const tick = () => ++clock;
  const get = vi.fn(async (path: string, ..._args: any[]) => {
    if (path === "/api/session/active") return running ? { [SID]: { type: "running" } } : {};
    if (path === `/api/session/${SID}`) return { id: SID, title: "Fixture", time: { created: 1, updated: 2 }, location: { directory: "/remote/project" } };
    // The real API returns newest-first.
    if (path === `/api/session/${SID}/message`) return [...messages].reverse();
    if (path === "/api/form") return forms;
    if (path === "/api/permission/request") return permissions;
    throw new Error(`Unexpected GET ${path}`);
  });
  const post = vi.fn(async (path: string, body?: any, ..._args: any[]) => {
    if (path === "/api/session") return { id: SID, title: body?.title, time: { created: tick(), updated: clock } };
    if (path === `/api/session/${SID}/model`) return undefined;
    if (path === `/api/session/${SID}/prompt`) {
      const id = body.id ?? `msg_user${++counter}`;
      const created = tick();
      messages.push({ id, type: "user", text: body.text, time: { created } });
      return { id, sessionID: SID, type: "user", time: { created }, payload: { text: body.text }, delivery: "queue" };
    }
    if (path === `/api/session/${SID}/form/frm_1/reply`) { forms = []; return undefined; }
    if (path === `/api/session/${SID}/permission/per_1/reply`) { permissions = []; return undefined; }
    if (path === `/api/session/${SID}/interrupt?resume=false`) {
      messages.push({ id: `msg_idle${++counter}`, type: "idle", outcome: "interrupted", time: { created: tick() } });
      return { interrupted: true };
    }
    throw new Error(`Unexpected POST ${path}`);
  });
  const del = vi.fn(async (path: string, ..._args: any[]) => {
    if (path === `/api/session/${SID}/form/frm_1`) { forms = []; return undefined; }
    throw new Error(`Unexpected DELETE ${path}`);
  });
  const client = { getBaseUrl: () => "http://fixture:4096", get, post, delete: del } as unknown as OpenCodeClient;
  return {
    client, get, post, delete: del,
    setRunning: (next: boolean) => { running = next; },
    setMessages: (next: any[]) => { messages = next; },
    setForms: (next: any[]) => { forms = next; },
    setPermissions: (next: any[]) => { permissions = next; },
    addUser(id: string) { messages.push({ id, type: "user", text: "fixture", time: { created: tick() } }); },
    assistant(overrides: Record<string, any> = {}) {
      messages.push({
        id: `msg_assistant${++counter}`, type: "assistant", agent: "build", model: { id: "model", providerID: "provider" },
        time: { created: tick(), completed: tick() }, content: [{ type: "text", text: "Fixed the error successfully." }],
        finish: "stop", ...overrides,
      });
    },
    idle(outcome: "succeeded" | "failed" | "interrupted" = "succeeded", extra: Record<string, any> = {}) {
      messages.push({ id: `msg_idle${++counter}`, type: "idle", outcome, time: { created: tick() }, ...extra });
    },
    /** A finished turn: final assistant message followed by the idle marker. */
    complete(overrides: Record<string, any> = {}) {
      this.assistant(overrides);
      this.idle();
    },
  };
}
async function namespace() { return join(root, (await readdir(root))[0]); }
const user = (id: string, created: number) => ({ id, type: "user", text: "fixture", time: { created } });
const assistant = (id: string, created: number, text = "Done", extra: Record<string, any> = {}) => ({
  id, type: "assistant", agent: "build", model: { id: "model", providerID: "provider" },
  time: { created, completed: created }, content: [{ type: "text", text }], finish: "stop", ...extra,
});
const idle = (id: string, created: number, outcome = "succeeded", extra: Record<string, any> = {}) => ({ id, type: "idle", outcome, time: { created }, ...extra });

describe("OpenCode 2.x history observation", () => {
  it("normalizes newest-first history and returns the final assistant of the turn", async () => {
    const fixture = backend();
    fixture.setMessages([
      user("msg_target", 1),
      assistant("msg_step", 2, "", { finish: "tool-calls", content: [{ type: "tool", id: "call_1", name: "shell", state: { status: "completed", input: {}, content: [{ type: "text", text: "ok" }] } }] }),
      assistant("msg_final", 3, "Final answer", { snapshot: { files: ["src/a.ts"] } }),
      idle("msg_idle", 4),
    ]);
    const observed = await observeSession(fixture.client, SID, "/remote/project", "msg_target");
    expect(observed).toMatchObject({ status: "completed", messageId: "msg_target", result: { id: "msg_final" } });
    expect(observed.text).toBe("Final answer");
    expect(fixture.get).toHaveBeenCalledWith(`/api/session/${SID}/message`, { limit: "100" }, "/remote/project", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(fixture.post).not.toHaveBeenCalled();
  });

  it("does not treat an unrelated older idle marker as the requested turn's completion", async () => {
    const fixture = backend();
    fixture.setMessages([user("msg_old", 1), assistant("msg_old_answer", 2), idle("msg_old_idle", 3), user("msg_target", 4)]);
    const observed = await observeSession(fixture.client, SID, undefined, "msg_target");
    expect(observed.status).toBe("accepted");
    expect(observed.result).toBeUndefined();
    expect(observed.text).toBeUndefined();
  });

  it("preserves unrelated errors from the history read", async () => {
    const denied = new OpenCodeError("Forbidden", 403, "GET", `/api/session/${SID}/message`, "{}");
    const fixture = backend();
    const original = fixture.get.getMockImplementation()!;
    fixture.get.mockImplementation(async (path: string, ...args: any[]) => {
      if (path.endsWith("/message")) throw denied;
      return original(path, ...args);
    });
    await expect(observeSession(fixture.client, SID, undefined, "msg_target")).rejects.toBe(denied);
    fixture.get.mockRejectedValue(denied);
    await expect(observeSession(fixture.client, SID, undefined, "msg_target")).rejects.toBe(denied);
  });

  it("rejects a non-list history instead of guessing a turn outcome", async () => {
    const fixture = backend();
    const original = fixture.get.getMockImplementation()!;
    fixture.get.mockImplementation(async (path: string, ...args: any[]) => path.endsWith("/message") ? { unexpected: true } : original(path, ...args));
    await expect(observeSession(fixture.client, SID, undefined, "msg_target")).rejects.toThrow("Invalid session message response");
  });

  // Paginated v2 list endpoints answer `{ data: [...], cursor: {...} }`
  // (verified against a live 2.1.2 server); the real client must unwrap it.
  it("observes a completed turn through the real client and paginated envelope", async () => {
    const server = createServer((request, response) => {
      const url = new URL(request.url!, "http://127.0.0.1");
      const body = url.pathname === "/api/session/active" ? { data: {} }
        : url.pathname === `/api/session/${SID}` ? { data: { id: SID, title: "Fixture", time: { created: 1, updated: 2 } } }
          : url.pathname === `/api/session/${SID}/message`
            ? { data: [idle("msg_idle", 3), assistant("msg_answer", 2, "Done"), user("msg_target", 1)], cursor: { previous: "opaque" } }
            : { data: [], location: { directory: "/remote/project" } };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${port}` });
      expect(await observeSession(client, SID, undefined, "msg_target")).toMatchObject({ status: "completed", text: "Done" });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

it("persists ownership before dispatch, with safe file modes and no prompt", async () => {
  const fixture = backend();
  const original = fixture.post.getMockImplementation()!;
  fixture.post.mockImplementation(async (path, body) => {
    if (path === "/api/session") {
      const files = await readdir(await namespace());
      expect(files.some((name) => name.endsWith(".json"))).toBe(true);
    }
    if (path.endsWith("/prompt")) {
      const files = await readdir(await namespace());
      const saved = JSON.parse(await readFile(join(await namespace(), files.find((name) => name.endsWith(".json"))!), "utf8"));
      expect(saved.sessionId).toBe(SID);
      expect(saved.messageId).toBe(body.id);
      expect(saved.status).toBe("unknown");
      expect(JSON.stringify(saved)).not.toContain("private submitted prompt");
    }
    return original(path, body);
  });
  const service = new JobService(fixture.client, { storeRoot: root, scope: "fixture-identity" });
  const result = await service.start({ prompt: "private submitted prompt", directory: "/remote/project" });
  expect(result.status).toBe("accepted");
  expect(result.messageId).toMatch(/^msg_[a-f0-9]{26}$/);
  expect(result.jobId).toMatch(/^job_[a-f0-9]{32}$/);
  const path = join(await namespace(), `${result.jobId}.json`);
  expect(await readFile(path, "utf8")).not.toContain("private submitted prompt");
  if (process.platform !== "win32") {
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(await namespace())).mode & 0o777).toBe(0o700);
  }
});

describe("v2 dispatch requests", () => {
  it("creates the session with model and location in the body, then submits a plain-text prompt with the pre-assigned ID", async () => {
    const fixture = backend();
    const job = await new JobService(fixture.client, { storeRoot: null }).start({
      prompt: "Task", title: "Fixture task", directory: "/remote/project", agent: "build",
      model: { providerID: "provider", modelID: "model" }, variant: "fast",
    });
    expect(fixture.post.mock.calls[0]).toEqual(["/api/session", {
      title: "Fixture task", model: { id: "model", providerID: "provider", variant: "fast" }, location: { directory: "/remote/project" },
    }, expect.objectContaining({ directory: "/remote/project" })]);
    expect(fixture.post.mock.calls[1][0]).toBe(`/api/session/${SID}/prompt`);
    expect(fixture.post.mock.calls[1][1]).toEqual({ id: job.messageId, text: "Task", agent: "build" });
    expect(fixture.post).toHaveBeenCalledTimes(2);
  });

  it("switches an existing session's model instead of sending a model with the prompt", async () => {
    const fixture = backend();
    await new JobService(fixture.client, { storeRoot: null }).start({ prompt: "Task", sessionId: SID, model: { providerID: "provider", modelID: "model" } });
    expect(fixture.post.mock.calls.map(([path]) => path)).toEqual([`/api/session/${SID}/model`, `/api/session/${SID}/prompt`]);
    expect(fixture.post.mock.calls[0][1]).toEqual({ model: { id: "model", providerID: "provider" } });
    expect(fixture.post.mock.calls[1][1]).not.toHaveProperty("model");
  });
});

it("reconnects a new service instance to a persisted job and retains terminal output", async () => {
  const fixture = backend();
  const first = new JobService(fixture.client, { storeRoot: root, scope: "user-one" });
  const created = await first.start({ prompt: "fixture" });
  fixture.complete({ snapshot: { files: ["a.ts", "b.ts"] } });
  const second = new JobService(fixture.client, { storeRoot: root, scope: "user-one" });
  const complete = await second.get(created.jobId!);
  expect(complete.status).toBe("completed");
  expect(complete.result).toMatchObject({ type: "assistant", snapshot: { files: ["a.ts", "b.ts"] } });
  expect(complete.text).toContain("Fixed the error");
  fixture.get.mockRejectedValue(new Error("server offline"));
  expect((await first.get(created.jobId!)).status).toBe("completed");
  expect(await second.list()).toHaveLength(1);
  await expect(new JobService(fixture.client, { storeRoot: root, scope: "user-two" }).get(created.jobId!)).rejects.toThrow("scope");
});

it("retains all known IDs when accepted submission loses its response", async () => {
  const fixture = backend();
  fixture.post.mockImplementation(async (path) => {
    if (path === "/api/session") return { id: SID };
    throw new OpenCodeSubmissionError("POST", path, new Error("socket hang up"));
  });
  const service = new JobService(fixture.client, { storeRoot: root });
  const job = await service.start({ prompt: "fixture" });
  expect(job).toMatchObject({ status: "unknown", sessionId: SID, jobId: expect.any(String), messageId: expect.any(String) });
  expect(fixture.post.mock.calls.filter(([path]) => path.endsWith("/prompt"))).toHaveLength(1);
  expect((await service.get(job.jobId!)).status).toBe("unknown");
  // The lost prompt was in fact accepted: OpenCode recorded it under our ID.
  fixture.addUser(job.messageId!);
  fixture.complete();
  expect((await service.get(job.jobId!)).status).toBe("completed");
  expect(fixture.post.mock.calls.filter(([path]) => path.endsWith("/prompt"))).toHaveLength(1);
});

it("retains a job handle even if session creation outcome is unknown", async () => {
  const fixture = backend();
  fixture.post.mockRejectedValue(new OpenCodeSubmissionError("POST", "/api/session", new Error("socket hang up")));
  const service = new JobService(fixture.client, { storeRoot: null });
  const job = await service.start({ prompt: "fixture" });
  expect(job.status).toBe("unknown");
  expect(job.sessionId).toBeUndefined();
  expect((await service.get(job.jobId!)).jobId).toBe(job.jobId);
  await expect(service.cancel(job.jobId!)).rejects.toThrow("session creation outcome");
  expect(fixture.post).toHaveBeenCalledTimes(1);
});

it("marks explicit submission rejection failed without resubmitting", async () => {
  const fixture = backend();
  fixture.post.mockRejectedValue(new OpenCodeError("forbidden", 403, "POST", `/api/session/${SID}/prompt`, "fixture"));
  const job = await new JobService(fixture.client, { storeRoot: null }).start({ prompt: "fixture", sessionId: SID });
  expect(job.status).toBe("failed");
  expect(job.error).toMatchObject({ status: 403 });
  expect(fixture.post).toHaveBeenCalledTimes(1);
});

describe("turn-specific observations", () => {
  it("does not mistake idle/no assistant, latest user, or an old turn for completion", async () => {
    const fixture = backend();
    fixture.setMessages([assistant("msg_old_assistant", 1), idle("msg_old_idle", 2), user("msg_target", 3)]);
    expect((await observeSession(fixture.client, SID, undefined, "msg_target")).status).toBe("accepted");
    expect((await observeSession(fixture.client, SID)).status).toBe("accepted");
    fixture.setMessages([]);
    expect((await observeSession(fixture.client, SID)).status).toBe("accepted");
  });

  it.each([
    ["failed", "failed", { error: { type: "ProviderAuthError", message: "fixture typed failure" } }],
    ["interrupted", "cancelled", {}],
  ] as const)("classifies an idle marker with outcome %s as %s", async (outcome, status, extra) => {
    const fixture = backend();
    fixture.addUser("msg_target");
    fixture.assistant({ content: [], finish: "error" });
    fixture.idle(outcome, extra);
    const result = await observeSession(fixture.client, SID, "/remote/project", "msg_target");
    expect(result.status).toBe(status);
    if (status === "failed") expect(result.error).toMatchObject({ type: "ProviderAuthError" });
  });

  it("supplies a generic error for a failed turn without structured details", async () => {
    const fixture = backend();
    fixture.addUser("msg_target");
    fixture.idle("failed");
    expect(await observeSession(fixture.client, SID, undefined, "msg_target")).toMatchObject({ status: "failed", error: { name: "SessionError" } });
  });

  it("requires the idle marker and ignores successful prose containing error", async () => {
    const fixture = backend();
    fixture.addUser("msg_target");
    fixture.assistant();
    // A completed assistant message alone does not end the turn.
    expect((await observeSession(fixture.client, SID, undefined, "msg_target")).status).toBe("running");
    fixture.idle();
    const result = await observeSession(fixture.client, SID, undefined, "msg_target");
    expect(result.status).toBe("completed");
    expect(result.error).toBeUndefined();
    expect(result.text).toContain("Fixed the error");
    expect(fixture.get.mock.calls.some(([path]) => path.includes("/diff"))).toBe(false);
  });

  it("does not finish a tool-call intermediate step", async () => {
    const fixture = backend();
    fixture.setRunning(true);
    fixture.addUser("msg_target");
    fixture.assistant({ finish: "tool-calls", content: [{ type: "tool", id: "call_1", name: "shell", state: { status: "running", input: {}, metadata: {} } }] });
    expect((await observeSession(fixture.client, SID, undefined, "msg_target")).status).toBe("running");
  });

  it("reports running while the session is active, before any assistant output", async () => {
    const fixture = backend();
    fixture.setRunning(true);
    fixture.addUser("msg_target");
    expect((await observeSession(fixture.client, SID, undefined, "msg_target")).status).toBe("running");
  });

  it("exposes pending input only for the requested session", async () => {
    const fixture = backend();
    fixture.setRunning(true);
    fixture.addUser("msg_target");
    fixture.setForms([
      { id: "frm_1", sessionID: SID, title: "Color", fields: [{ key: "color", type: "string", title: "Select a color", options: [] }] },
      { id: "frm_other", sessionID: "ses_another", fields: [] },
    ]);
    fixture.setPermissions([
      { id: "per_1", sessionID: SID, action: "edit", resources: ["src/**"] },
      { id: "per_other", sessionID: "ses_another", action: "edit", resources: ["*"] },
    ]);
    const result = await observeSession(fixture.client, SID, "/remote/project");
    expect(result.status).toBe("input_required");
    expect(result.inputs?.map((input) => [input.kind, input.id])).toEqual([["question", "frm_1"], ["permission", "per_1"]]);
    expect(result.inputs?.[0]).toMatchObject({ fields: [{ key: "color" }] });
    // Pending lists are location-scoped.
    expect(fixture.get).toHaveBeenCalledWith("/api/form", undefined, "/remote/project", expect.anything());
    expect(fixture.get).toHaveBeenCalledWith("/api/permission/request", undefined, "/remote/project", expect.anything());
  });

  it("accepts unsupported pending endpoints only for HTTP 404", async () => {
    const fixture = backend();
    const original = fixture.get.getMockImplementation()!;
    fixture.get.mockImplementation(async (path, ...args) => {
      if (path === "/api/form" || path === "/api/permission/request") throw new OpenCodeError("unsupported", 404, "GET", path, "");
      return original(path, ...args);
    });
    expect((await observeSession(fixture.client, SID)).status).toBe("accepted");
    fixture.get.mockImplementation(async (path, ...args) => {
      if (path === "/api/form") throw new OpenCodeError("unauthorized", 401, "GET", path, "");
      return original(path, ...args);
    });
    await expect(observeSession(fixture.client, SID)).rejects.toMatchObject({ status: 401 });
  });
});

it("deduplicates permission replies across two service instances", async () => {
  const fixture = backend();
  const first = new JobService(fixture.client, { storeRoot: root });
  const second = new JobService(fixture.client, { storeRoot: root });
  const job = await first.start({ prompt: "fixture" });
  fixture.setPermissions([{ id: "per_1", sessionID: SID, action: "edit", resources: ["src/**"] }]);
  const responses = [{ id: "per_1", kind: "permission" as const, reply: "once" as const }];
  await Promise.all([first.update(job.jobId!, responses), second.update(job.jobId!, responses)]);
  const replies = fixture.post.mock.calls.filter(([path]) => path === `/api/session/${SID}/permission/per_1/reply`);
  expect(replies).toHaveLength(1);
  expect(replies[0][1]).toEqual({ decision: "once" });
  await expect(first.update(job.jobId!, [{ ...responses[0], reply: "always" }])).rejects.toThrow("different submitted response");
});

it("does not replay an ambiguous form reply after reconnection", async () => {
  const fixture = backend();
  const first = new JobService(fixture.client, { storeRoot: root });
  const job = await first.start({ prompt: "fixture" });
  fixture.setForms([{ id: "frm_1", sessionID: SID, fields: [{ key: "color", type: "string" }] }]);
  fixture.post.mockRejectedValue(new OpenCodeSubmissionError("POST", `/api/session/${SID}/form/frm_1/reply`, new Error("socket hang up")));
  const responses = [{ id: "frm_1", kind: "question" as const, answers: [["Blue"]] }];
  await expect(first.update(job.jobId!, responses)).rejects.toBeInstanceOf(OpenCodeSubmissionError);
  const second = new JobService(fixture.client, { storeRoot: root });
  await expect(second.update(job.jobId!, responses)).rejects.toThrow("cannot be safely resent");
  expect(fixture.post.mock.calls.filter(([path]) => path === `/api/session/${SID}/form/frm_1/reply`)).toHaveLength(1);
});

it("maps answer labels onto the form's typed answer map", async () => {
  const fixture = backend();
  const service = new JobService(fixture.client, { storeRoot: null });
  const job = await service.start({ prompt: "fixture" });
  fixture.setForms([{ id: "frm_1", sessionID: SID, fields: [
    { key: "note", type: "string" },
    { key: "tags", type: "multiselect", options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }] },
    { key: "confirm", type: "boolean" },
    { key: "count", type: "integer" },
  ] }]);
  const result = await service.update(job.jobId!, [{ id: "frm_1", kind: "question", answers: [["free text"], ["Alpha", "b"], ["true"], ["3"]] }]);
  const reply = fixture.post.mock.calls.find(([path]) => path === `/api/session/${SID}/form/frm_1/reply`)!;
  expect(reply[1]).toEqual({ answer: { note: "free text", tags: ["a", "b"], confirm: true, count: 3 } });
  expect(result.inputs).toEqual([]);
});

it("resolves option labels to values for single-choice string fields", async () => {
  const fixture = backend();
  const service = new JobService(fixture.client, { storeRoot: null });
  const job = await service.start({ prompt: "fixture" });
  fixture.setForms([{ id: "frm_1", sessionID: SID, fields: [{ key: "color", type: "string", options: [{ value: "blue", label: "Blue" }] }] }]);
  await service.update(job.jobId!, [{ id: "frm_1", kind: "question", answers: [["Blue"]] }]);
  const reply = fixture.post.mock.calls.find(([path]) => path === `/api/session/${SID}/form/frm_1/reply`)!;
  expect(reply[1]).toEqual({ answer: { color: "blue" } });
});

it("rejects a form by deleting it, exactly once", async () => {
  const fixture = backend();
  const service = new JobService(fixture.client, { storeRoot: null });
  const job = await service.start({ prompt: "fixture" });
  fixture.setForms([{ id: "frm_1", sessionID: SID, fields: [] }]);
  const responses = [{ id: "frm_1", kind: "question" as const, reject: true }];
  await service.update(job.jobId!, responses);
  await service.update(job.jobId!, responses);
  expect(fixture.delete).toHaveBeenCalledTimes(1);
  expect(fixture.delete).toHaveBeenCalledWith(`/api/session/${SID}/form/frm_1`, undefined, undefined, expect.anything());
  expect(fixture.post.mock.calls.some(([path]) => path.includes("/form/"))).toBe(false);
});

it("does not reply to another session's pending form or auto-approve invalid input", async () => {
  const fixture = backend();
  const service = new JobService(fixture.client, { storeRoot: null });
  const job = await service.start({ prompt: "fixture" });
  fixture.setForms([{ id: "frm_1", sessionID: "ses_another", fields: [] }]);
  await expect(service.update(job.jobId!, [{ id: "frm_1", kind: "question", answers: [["Yes"]] }])).rejects.toThrow("does not belong");
  fixture.setPermissions([{ id: "per_1", sessionID: SID, action: "edit", resources: ["*"] }]);
  await expect(service.update(job.jobId!, [{ id: "per_1", kind: "permission" } as any])).rejects.toThrow("once, always, or reject");
  expect(fixture.post).toHaveBeenCalledTimes(2);
});

it("explicitly interrupts owned work once and never interrupts on observer cancellation", async () => {
  const fixture = backend();
  const service = new JobService(fixture.client, { storeRoot: root });
  const job = await service.start({ prompt: "fixture" });
  const controller = new AbortController();
  controller.abort();
  await expect(service.get(job.jobId!, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(fixture.post.mock.calls.filter(([path]) => path.includes("/interrupt"))).toHaveLength(0);
  expect((await service.cancel(job.jobId!)).status).toBe("cancelled");
  expect((await service.cancel(job.jobId!)).status).toBe("cancelled");
  // resume=false ends the turn instead of continuing with queued inbox work.
  expect(fixture.post.mock.calls.filter(([path]) => path.includes("/interrupt")).map(([path]) => path)).toEqual([`/api/session/${SID}/interrupt?resume=false`]);
  expect((await service.get(job.jobId!)).status).toBe("cancelled");
});

it("refuses session-wide interruption when a newer turn is active", async () => {
  const fixture = backend();
  const service = new JobService(fixture.client, { storeRoot: null });
  const job = await service.start({ prompt: "fixture" });
  fixture.setRunning(true);
  fixture.addUser("msg_newer");
  await expect(service.cancel(job.jobId!)).rejects.toThrow("newer turn");
  expect(fixture.post.mock.calls.filter(([path]) => path.includes("/interrupt"))).toHaveLength(0);
});

it("expires scoped handles without discarding remote sessions", async () => {
  const fixture = backend();
  const service = new JobService(fixture.client, { storeRoot: root, ttlMs: 30 });
  const job = await service.start({ prompt: "fixture" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  await expect(service.get(job.jobId!)).rejects.toThrow("expired");
  expect(await service.list()).toEqual([]);
  expect(fixture.post.mock.calls.some(([path]) => path.includes("/interrupt"))).toBe(false);
  expect(fixture.delete).not.toHaveBeenCalled();
});

it("recovers a cross-process lock only after confirming its owner exited", async () => {
  const fixture = backend();
  const service = new JobService(fixture.client, { storeRoot: root });
  const job = await service.start({ prompt: "fixture" });
  const exited = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  expect(exited.status).toBe(0);
  const lock = join(await namespace(), `${job.jobId}.lock`);
  await mkdir(lock);
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: exited.pid, host: hostname() }));
  expect((await service.get(job.jobId!)).jobId).toBe(job.jobId);
  await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
});

it("fails closed for a live owner's lock and respects cancellation while waiting", async () => {
  const fixture = backend();
  const service = new JobService(fixture.client, { storeRoot: root });
  const job = await service.start({ prompt: "fixture" });
  const lock = join(await namespace(), `${job.jobId}.lock`);
  await mkdir(lock);
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname() }));
  await expect(service.get(job.jobId!, { timeout: 30 })).rejects.toMatchObject({ name: "TimeoutError" });
  expect((await stat(lock)).isDirectory()).toBe(true);
});

it("inherits cancellation through AsyncLocalStorage for existing tool handlers", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:1" });
  await expect(withRequestOptions({ signal: controller.signal }, () => client.get("/api/session"))).rejects.toMatchObject({ name: "AbortError" });
});

it("does not surface a newer turn's approval as input for an older job", async () => {
  const fixture = backend();
  fixture.setRunning(true);
  fixture.setMessages([user("msg_old", 1), user("msg_new", 10)]);
  fixture.setPermissions([{ id: "per_1", sessionID: SID, action: "edit", resources: ["*"] }]);
  const result = await observeSession(fixture.client, SID, undefined, "msg_old");
  expect(result.status).toBe("unknown");
  expect(result.inputs).toEqual([]);
  expect(fixture.get).not.toHaveBeenCalledWith("/api/permission/request", expect.anything(), expect.anything(), expect.anything());
});

it("does not attribute a newer turn's completion to an older, unfinished job", async () => {
  const fixture = backend();
  // The old turn never reached its own idle marker before the newer turn began.
  fixture.setMessages([user("msg_old", 1), user("msg_new", 2), assistant("msg_new_answer", 3, "New result"), idle("msg_new_idle", 4)]);
  const result = await observeSession(fixture.client, SID, undefined, "msg_old");
  expect(result.status).not.toBe("completed");
  expect(result.text ?? "").not.toContain("New result");
});

it("recognizes completed older turns even while a newer turn is running", async () => {
  const fixture = backend();
  fixture.setRunning(true);
  fixture.setMessages([user("msg_old", 1), assistant("msg_old_answer", 2, "Done"), idle("msg_old_idle", 3), user("msg_new", 4)]);
  expect(await observeSession(fixture.client, SID, undefined, "msg_old")).toMatchObject({ status: "completed", text: "Done" });
});

it("keeps an ambiguous interruption unknown without sending it twice", async () => {
  const fixture = backend();
  const service = new JobService(fixture.client, { storeRoot: root });
  const job = await service.start({ prompt: "fixture" });
  fixture.setRunning(true);
  fixture.post.mockRejectedValue(new OpenCodeSubmissionError("POST", `/api/session/${SID}/interrupt?resume=false`, new Error("socket hang up")));
  expect((await service.cancel(job.jobId!)).status).toBe("unknown");
  expect((await service.get(job.jobId!)).status).toBe("unknown");
  expect((await service.cancel(job.jobId!)).status).toBe("unknown");
  expect(fixture.post.mock.calls.filter(([path]) => path.includes("/interrupt"))).toHaveLength(1);
});

it("fails closed for interrupted lock initialization or recovery", async () => {
  const fixture = backend();
  const service = new JobService(fixture.client, { storeRoot: root });
  const job = await service.start({ prompt: "fixture" });
  const lock = join(await namespace(), `${job.jobId}.lock`);
  await mkdir(lock);
  await expect(service.get(job.jobId!, { timeout: 30 })).rejects.toMatchObject({ name: "TimeoutError" });
  expect((await stat(lock)).isDirectory()).toBe(true);
  const exited = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: exited.pid, host: hostname() }));
  await writeFile(join(lock, "recovery"), "");
  await expect(service.get(job.jobId!, { timeout: 30 })).rejects.toMatchObject({ name: "TimeoutError" });
  expect((await stat(lock)).isDirectory()).toBe(true);
});
