import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { JobService, observeSession } from "../src/jobs.js";
import { OpenCodeClient, OpenCodeError, OpenCodeSubmissionError } from "../src/client.js";
import { withRequestOptions } from "../src/async.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "opencode-jobs-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

function backend() {
  let status = "idle";
  let messages: any[] = [];
  let questions: any[] = [];
  let permissions: any[] = [];
  const get = vi.fn(async (path: string) => {
    if (path === "/session/status") return { session: { type: status } };
    if (path === "/session/session") return { id: "session", title: "Fixture", summary: { files: 2 } };
    if (path === "/session/session/message") return messages;
    if (path === "/question") return questions;
    if (path === "/permission") return permissions;
    throw new Error(`Unexpected GET ${path}`);
  });
  const post = vi.fn(async (path: string, body?: any) => {
    if (path === "/session") return { id: "session" };
    if (path.endsWith("/prompt_async")) {
      messages.push({ info: { id: body.messageID, role: "user", time: { created: Date.now() } }, parts: [] });
      return undefined;
    }
    if (path === "/question/question-1/reply" || path === "/question/question-1/reject") { questions = []; return true; }
    if (path === "/permission/permission-1/reply") { permissions = []; return true; }
    if (path.endsWith("/abort")) return true;
    throw new Error(`Unexpected POST ${path}`);
  });
  const client = { getBaseUrl: () => "http://fixture:4096", get, post } as unknown as OpenCodeClient;
  return {
    client, get, post,
    setStatus: (next: string) => { status = next; },
    setMessages: (next: any[]) => { messages = next; },
    setQuestions: (next: any[]) => { questions = next; },
    setPermissions: (next: any[]) => { permissions = next; },
    complete(parentID: string, overrides: Record<string, any> = {}) {
      messages.push({ info: { id: "msg_assistant", parentID, role: "assistant", time: { created: Date.now() + 1, completed: Date.now() + 2 }, ...overrides }, parts: [{ type: "text", text: "Fixed the error successfully." }] });
    },
  };
}
async function namespace() { return join(root, (await readdir(root))[0]); }

it("persists ownership before dispatch, with safe file modes and no prompt", async () => {
  const fixture = backend();
  const original = fixture.post.getMockImplementation()!;
  fixture.post.mockImplementation(async (path, body) => {
    if (path === "/session") {
      const files = await readdir(await namespace());
      expect(files.some((name) => name.endsWith(".json"))).toBe(true);
    }
    if (path.endsWith("/prompt_async")) {
      const files = await readdir(await namespace());
      const saved = JSON.parse(await readFile(join(await namespace(), files.find((name) => name.endsWith(".json"))!), "utf8"));
      expect(saved.sessionId).toBe("session");
      expect(saved.messageId).toBe(body.messageID);
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

it("reconnects a new service instance to a persisted job and retains terminal output", async () => {
  const fixture = backend();
  const first = new JobService(fixture.client, { storeRoot: root, scope: "user-one" });
  const created = await first.start({ prompt: "fixture", format: { type: "json_schema", schema: { type: "object" } } });
  fixture.complete(created.messageId!, { structured: { files: 2 } });
  const second = new JobService(fixture.client, { storeRoot: root, scope: "user-one" });
  const complete = await second.get(created.jobId!);
  expect(complete.status).toBe("completed");
  expect(complete.result).toEqual({ files: 2 });
  fixture.get.mockRejectedValue(new Error("server offline"));
  expect((await first.get(created.jobId!)).status).toBe("completed");
  expect(await second.list()).toHaveLength(1);
  await expect(new JobService(fixture.client, { storeRoot: root, scope: "user-two" }).get(created.jobId!)).rejects.toThrow("scope");
});

it("retains all known IDs when accepted submission loses its response", async () => {
  const fixture = backend();
  fixture.post.mockImplementation(async (path) => {
    if (path === "/session") return { id: "session" };
    throw new OpenCodeSubmissionError("POST", path, new Error("socket hang up"));
  });
  const service = new JobService(fixture.client, { storeRoot: root });
  const job = await service.start({ prompt: "fixture" });
  expect(job).toMatchObject({ status: "unknown", sessionId: "session", jobId: expect.any(String), messageId: expect.any(String) });
  expect(fixture.post.mock.calls.filter(([path]) => path.endsWith("/prompt_async"))).toHaveLength(1);
  expect((await service.get(job.jobId!)).status).toBe("unknown");
  fixture.complete(job.messageId!);
  expect((await service.get(job.jobId!)).status).toBe("completed");
});

it("retains a job handle even if session creation outcome is unknown", async () => {
  const fixture = backend();
  fixture.post.mockRejectedValue(new OpenCodeSubmissionError("POST", "/session", new Error("socket hang up")));
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
  fixture.post.mockRejectedValue(new OpenCodeError("forbidden", 403, "POST", "/session", "fixture"));
  const job = await new JobService(fixture.client, { storeRoot: null }).start({ prompt: "fixture", sessionId: "session" });
  expect(job.status).toBe("failed");
  expect(job.error).toMatchObject({ status: 403 });
  expect(fixture.post).toHaveBeenCalledTimes(1);
});

describe("turn-specific observations", () => {
  it("does not mistake idle/no assistant, latest user, or old assistant for completion", async () => {
    const fixture = backend();
    fixture.complete("old-parent");
    fixture.setMessages([
      { info: { id: "old-assistant", role: "assistant", parentID: "old-parent", time: { created: 1, completed: 2 } }, parts: [] },
      { info: { id: "target-user", role: "user", time: { created: 3 } }, parts: [] },
    ]);
    expect((await observeSession(fixture.client, "session", undefined, "target-user")).status).toBe("accepted");
    expect((await observeSession(fixture.client, "session")).status).toBe("accepted");
    fixture.setMessages([]);
    expect((await observeSession(fixture.client, "session")).status).toBe("accepted");
  });

  it.each(["ProviderAuthError", "StructuredOutputError", "MessageAbortedError"])("classifies structured %s while idle", async (name) => {
    const fixture = backend();
    fixture.complete("user", { error: { name, data: { message: "fixture typed failure" } } });
    const result = await observeSession(fixture.client, "session", "/remote/project", "user");
    expect(result.status).toBe(name === "MessageAbortedError" ? "cancelled" : "failed");
    expect(result.error).toMatchObject({ name });
  });

  it("requires completion metadata and ignores successful prose containing error", async () => {
    const fixture = backend();
    fixture.complete("user", { time: { created: 1 } });
    expect((await observeSession(fixture.client, "session", undefined, "user")).status).toBe("accepted");
    fixture.setMessages([]);
    fixture.complete("user");
    const result = await observeSession(fixture.client, "session", undefined, "user");
    expect(result.status).toBe("completed");
    expect(result.text).toContain("Fixed the error");
    expect(fixture.get.mock.calls.some(([path]) => path.includes("/diff"))).toBe(false);
  });

  it("does not finish a tool-call intermediate step", async () => {
    const fixture = backend();
    fixture.complete("user", { finish: "tool-calls" });
    expect((await observeSession(fixture.client, "session", undefined, "user")).status).toBe("accepted");
  });

  it("exposes pending input only for the requested session", async () => {
    const fixture = backend();
    fixture.setStatus("busy");
    fixture.setQuestions([{ id: "question-1", sessionID: "session", questions: [{ question: "Select a color", options: [] }] }, { id: "other", sessionID: "another", questions: [] }]);
    fixture.setPermissions([{ id: "permission-1", sessionID: "session", permission: "edit", patterns: ["src/**"] }]);
    const result = await observeSession(fixture.client, "session");
    expect(result.status).toBe("input_required");
    expect(result.inputs?.map((input) => [input.kind, input.id])).toEqual([["question", "question-1"], ["permission", "permission-1"]]);
  });

  it("accepts unsupported pending endpoints only for HTTP 404", async () => {
    const fixture = backend();
    const original = fixture.get.getMockImplementation()!;
    fixture.get.mockImplementation(async (path) => {
      if (path === "/question" || path === "/permission") throw new OpenCodeError("unsupported", 404, "GET", path, "");
      return original(path);
    });
    expect((await observeSession(fixture.client, "session")).status).toBe("accepted");
    fixture.get.mockImplementation(async (path) => {
      if (path === "/question") throw new OpenCodeError("unauthorized", 401, "GET", path, "");
      return original(path);
    });
    await expect(observeSession(fixture.client, "session")).rejects.toMatchObject({ status: 401 });
  });
});

it("deduplicates permission replies across two service instances", async () => {
  const fixture = backend();
  const first = new JobService(fixture.client, { storeRoot: root });
  const second = new JobService(fixture.client, { storeRoot: root });
  const job = await first.start({ prompt: "fixture" });
  fixture.setPermissions([{ id: "permission-1", sessionID: "session", permission: "edit", patterns: ["src/**"] }]);
  const responses = [{ id: "permission-1", kind: "permission" as const, reply: "once" as const }];
  await Promise.all([first.update(job.jobId!, responses), second.update(job.jobId!, responses)]);
  expect(fixture.post.mock.calls.filter(([path]) => path === "/permission/permission-1/reply")).toHaveLength(1);
  await expect(first.update(job.jobId!, [{ ...responses[0], reply: "always" }])).rejects.toThrow("different submitted response");
});

it("does not replay an ambiguous question reply after reconnection", async () => {
  const fixture = backend();
  const first = new JobService(fixture.client, { storeRoot: root });
  const job = await first.start({ prompt: "fixture" });
  fixture.setQuestions([{ id: "question-1", sessionID: "session", questions: [] }]);
  fixture.post.mockRejectedValue(new OpenCodeSubmissionError("POST", "/question/question-1/reply", new Error("socket hang up")));
  const responses = [{ id: "question-1", kind: "question" as const, answers: [["Blue"]] }];
  await expect(first.update(job.jobId!, responses)).rejects.toBeInstanceOf(OpenCodeSubmissionError);
  const second = new JobService(fixture.client, { storeRoot: root });
  await expect(second.update(job.jobId!, responses)).rejects.toThrow("cannot be safely resent");
  expect(fixture.post.mock.calls.filter(([path]) => path === "/question/question-1/reply")).toHaveLength(1);
});

it("does not reply to another session's pending question or auto-approve invalid input", async () => {
  const fixture = backend();
  const service = new JobService(fixture.client, { storeRoot: null });
  const job = await service.start({ prompt: "fixture" });
  fixture.setQuestions([{ id: "question-1", sessionID: "another-session", questions: [] }]);
  await expect(service.update(job.jobId!, [{ id: "question-1", kind: "question", answers: [["Yes"]] }])).rejects.toThrow("does not belong");
  expect(fixture.post).toHaveBeenCalledTimes(2);
});

it("explicitly aborts owned work once and never aborts on observer cancellation", async () => {
  const fixture = backend();
  const service = new JobService(fixture.client, { storeRoot: root });
  const job = await service.start({ prompt: "fixture" });
  const controller = new AbortController();
  controller.abort();
  await expect(service.get(job.jobId!, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(fixture.post.mock.calls.filter(([path]) => path.endsWith("/abort"))).toHaveLength(0);
  expect((await service.cancel(job.jobId!)).status).toBe("cancelled");
  expect((await service.cancel(job.jobId!)).status).toBe("cancelled");
  expect(fixture.post.mock.calls.filter(([path]) => path.endsWith("/abort"))).toHaveLength(1);
});

it("refuses session-wide cancellation when a newer turn is active", async () => {
  const fixture = backend();
  const service = new JobService(fixture.client, { storeRoot: null });
  const job = await service.start({ prompt: "fixture" });
  fixture.setMessages([{ info: { id: "newer-user", role: "user", time: { created: Date.now() + 10 } }, parts: [] }]);
  await expect(service.cancel(job.jobId!)).rejects.toThrow("newer turn");
  expect(fixture.post.mock.calls.filter(([path]) => path.endsWith("/abort"))).toHaveLength(0);
});

it("expires scoped handles without discarding remote sessions", async () => {
  const fixture = backend();
  const service = new JobService(fixture.client, { storeRoot: root, ttlMs: 30 });
  const job = await service.start({ prompt: "fixture" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  await expect(service.get(job.jobId!)).rejects.toThrow("expired");
  expect(await service.list()).toEqual([]);
  expect(fixture.post.mock.calls.some(([path]) => path.endsWith("/abort"))).toBe(false);
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
  await expect(withRequestOptions({ signal: controller.signal }, () => client.get("/session"))).rejects.toMatchObject({ name: "AbortError" });
});

it("does not surface a newer turn's approval as input for an older job", async () => {
  const fixture = backend();
  fixture.setStatus("busy");
  fixture.setMessages([{ info: { id: "new-user", role: "user", time: { created: 10 } }, parts: [] }]);
  fixture.setPermissions([{ id: "permission-1", sessionID: "session", permission: "edit", patterns: ["*"] }]);
  const result = await observeSession(fixture.client, "session", undefined, "old-user");
  expect(result.status).toBe("unknown");
  expect(result.inputs).toEqual([]);
});

it("recognizes completed older turns even while a newer turn is busy", async () => {
  const fixture = backend();
  fixture.setStatus("busy");
  fixture.setMessages([
    { info: { id: "old-user", role: "user", time: { created: 1 } }, parts: [] },
    { info: { id: "old-answer", role: "assistant", parentID: "old-user", time: { created: 2, completed: 3 } }, parts: [{ type: "text", text: "Done" }] },
    { info: { id: "new-user", role: "user", time: { created: 4 } }, parts: [] },
  ]);
  expect((await observeSession(fixture.client, "session", undefined, "old-user")).status).toBe("completed");
});

it("keeps an ambiguous cancellation unknown without sending abort twice", async () => {
  const fixture = backend();
  const service = new JobService(fixture.client, { storeRoot: root });
  const job = await service.start({ prompt: "fixture" });
  fixture.setStatus("busy");
  fixture.post.mockRejectedValue(new OpenCodeSubmissionError("POST", "/session/session/abort", new Error("socket hang up")));
  expect((await service.cancel(job.jobId!)).status).toBe("unknown");
  expect((await service.get(job.jobId!)).status).toBe("unknown");
  expect((await service.cancel(job.jobId!)).status).toBe("unknown");
  expect(fixture.post.mock.calls.filter(([path]) => path.endsWith("/abort"))).toHaveLength(1);
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
