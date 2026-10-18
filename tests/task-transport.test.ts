import { describe, expect, it, vi } from "vitest";
import type { Transport } from "@modelcontextprotocol/server";
import { TaskTransport, taskFromJob, TASKS_EXTENSION } from "../src/task-transport.js";
import { JobService, type JobSnapshot } from "../src/jobs.js";

// Wire assertions follow immutable official ext-tasks/schema/2026-07-28/schema.ts.
const protocolKey = "io.modelcontextprotocol/protocolVersion";
const capabilitiesKey = "io.modelcontextprotocol/clientCapabilities";
const capable = { extensions: { [TASKS_EXTENSION]: {} }, elicitation: { form: {} } };
const meta = (capabilities: unknown = capable, version = "2026-07-28") => ({ [protocolKey]: version, [capabilitiesKey]: capabilities });
const snapshot = (status: JobSnapshot["status"]): JobSnapshot => ({
  jobId: "job_test", sessionId: "ses_test", messageId: "msg_test", status,
  createdAt: 1000, updatedAt: 2000, expiresAt: 61000,
});

async function setup() {
  const sent: any[] = [];
  const inner = { start: vi.fn(async () => {}), close: vi.fn(async () => {}), send: vi.fn(async (message: unknown) => { sent.push(message); }) } as unknown as Transport;
  const jobs = { selectModel: (providerID?:string,modelID?:string) => providerID && modelID ? {providerID,modelID} : undefined, start: vi.fn(async () => snapshot("accepted")), get: vi.fn(async () => snapshot("running")),
    update: vi.fn(async () => snapshot("running")), cancel: vi.fn(async () => snapshot("cancelled")) };
  const transport = new TaskTransport(inner, jobs as unknown as JobService);
  const forwarded = vi.fn();
  transport.onmessage = forwarded;
  transport.onerror = vi.fn();
  await transport.start();
  const deliver = (message: any) => inner.onmessage!(message);
  const request = async (id: number, method: string, params: Record<string, unknown>) => {
    deliver({ jsonrpc: "2.0", id, method, params });
    await vi.waitFor(() => expect(sent.some(message => message.id === id)).toBe(true));
    return sent.find(message => message.id === id);
  };
  return { inner, jobs, transport, forwarded, sent, deliver, request };
}

describe("modern Tasks wire results", () => {
  it("returns a flat task handle for capable run calls and routes no core traffic", async () => {
    const { request, jobs, forwarded } = await setup();
    const result = await request(1, "tools/call", { name: "opencode_run", arguments: { prompt: "Task", providerID: "test", modelID: "model" }, _meta: meta() });
    expect(result.result).toMatchObject({ resultType: "task", taskId: "job_test", status: "working", ttlMs: 60000 });
    expect(result.result).not.toHaveProperty("task");
    expect(jobs.start).toHaveBeenCalledWith(expect.objectContaining({ model: { providerID: "test", modelID: "model" } }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(forwarded).not.toHaveBeenCalled();
  });

  it("embeds the completed tool result including structured data", async () => {
    const { request, jobs } = await setup();
    jobs.get.mockResolvedValue({ ...snapshot("completed"), text: "Done", result: { answer: 42 } });
    const result = await request(1, "tasks/get", { taskId: "job_test", _meta: meta() });
    expect(result.result).toMatchObject({ resultType: "complete", taskId: "job_test", status: "completed", result: {
      resultType: "complete", content: [{ type: "text", text: "Done" }], structuredContent: { status: "completed", result: { answer: 42 } },
    } });
    expect(result.result).not.toHaveProperty("task");
  });

  it("distinguishes tool failure from a JSON-RPC failed task", () => {
    const result = taskFromJob({ ...snapshot("failed"), error: { name: "APIError" } }, true);
    expect(result.status).toBe("completed");
    expect((result.result as any).isError).toBe(true);
  });

  it("requires Tasks capabilities per request without inferring them from earlier calls", async () => {
    const { request } = await setup();
    await request(1, "tasks/get", { taskId: "job_test", _meta: meta() });
    const response = await request(2, "tasks/get", { taskId: "job_test", _meta: meta({}) });
    expect(response.error).toMatchObject({ code: -32021, data: { requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } } } });
  });

  it("does not emit form requests unless this request supports elicitation forms", async () => {
    const { request, jobs } = await setup();
    jobs.get.mockResolvedValue({ ...snapshot("input_required"), inputs: [{ id: "p1", sessionID: "ses_test", kind: "permission", permission: "bash" }] });
    const response = await request(1, "tasks/get", { taskId: "job_test", _meta: meta({ extensions: { [TASKS_EXTENSION]: {} } }) });
    expect(response.error).toMatchObject({ code: -32021, data: { requiredCapabilities: { elicitation: { form: {} } } } });
  });

  it("returns input requests and accepts a partial response with an empty acknowledgement", async () => {
    const { request, jobs } = await setup();
    jobs.get.mockResolvedValue({ ...snapshot("input_required"), inputs: [{ id: "p1", sessionID: "ses_test", kind: "permission", permission: "bash" }] });
    const current = await request(1, "tasks/get", { taskId: "job_test", _meta: meta() });
    expect(current.result.inputRequests["permission:p1"].method).toBe("elicitation/create");
    const updated = await request(2, "tasks/update", { taskId: "job_test", inputResponses: { "permission:p1": { action: "accept", content: { decision: "once" } } }, _meta: meta() });
    expect(updated.result).toEqual({ resultType: "complete" });
    expect(jobs.update).toHaveBeenCalledWith("job_test", [{ id: "p1", kind: "permission", reply: "once" }], expect.any(Object));
  });

  it("acknowledges unknown or already consumed input keys without resubmitting", async () => {
    const { request, jobs } = await setup();
    const result = await request(1, "tasks/update", { taskId: "job_test", inputResponses: { old: { action: "accept", content: {} } }, _meta: meta() });
    expect(result.result).toEqual({ resultType: "complete" });
    expect(jobs.update).not.toHaveBeenCalled();
  });

  it("cancels explicitly with an empty acknowledgement", async () => {
    const { request, jobs } = await setup();
    const result = await request(1, "tasks/cancel", { taskId: "job_test", _meta: meta() });
    expect(result.result).toEqual({ resultType: "complete" });
    expect(jobs.cancel).toHaveBeenCalledWith("job_test", expect.any(Object));
  });

  it("acknowledges accepted cancellation without requiring an immediate terminal state", async () => {
    const { request, jobs } = await setup();
    jobs.cancel.mockResolvedValue(snapshot("running"));
    const result = await request(1, "tasks/cancel", { taskId: "job_test", _meta: meta() });
    expect(result.result).toEqual({ resultType: "complete" });
  });
});

describe("transport routing and cancellation", () => {
  it("forwards legacy initialization and rejects a modern era switch", async () => {
    const { deliver, forwarded, request } = await setup();
    deliver({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } });
    await vi.waitFor(() => expect(forwarded).toHaveBeenCalledTimes(1));
    const response = await request(1, "tasks/get", { taskId: "job_test", _meta: meta() });
    expect(response.error.code).toBe(-32022);
  });

  it("includes required supported/requested versions in unsupported-version errors", async () => {
    const { request } = await setup();
    const response = await request(1, "tasks/get", { taskId: "job_test", _meta: meta(capable, "2099-01-01") });
    expect(response.error).toMatchObject({ code: -32022, data: { supported: expect.any(Array), requested: "2099-01-01" } });
  });

  it("forwards modern core tools when no Tasks capability is advertised", async () => {
    const { deliver, forwarded, jobs } = await setup();
    deliver({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "opencode_run", arguments: { prompt: "Task" }, _meta: meta({}) } });
    await vi.waitFor(() => expect(forwarded).toHaveBeenCalledTimes(1));
    expect(jobs.start).not.toHaveBeenCalled();
  });

  it("allows a discovery probe followed by legacy initialization", async () => {
    const { deliver, forwarded } = await setup();
    deliver({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta() } });
    deliver({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } });
    await vi.waitFor(() => expect(forwarded).toHaveBeenCalledTimes(2));
  });

  it("does not pin the era for a malformed opener", async () => {
    const { request, deliver, forwarded } = await setup();
    const invalid = await request(1, "tasks/get", { taskId: "job_test", _meta: { [protocolKey]: "2026-07-28", [capabilitiesKey]: "invalid" } });
    expect(invalid.error.code).toBe(-32602);
    deliver({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } });
    await vi.waitFor(() => expect(forwarded).toHaveBeenCalledTimes(1));
  });

  it("does not forward legacy core traffic after a native task opener", async () => {
    const { request, forwarded } = await setup();
    await request(1, "tasks/get", { taskId: "job_test", _meta: meta() });
    const result = await request(2, "tools/list", {});
    expect(result.error.code).toBe(-32022);
    expect(forwarded).not.toHaveBeenCalled();
  });

  it("rejects removed legacy task operations", async () => {
    const { request } = await setup();
    for (const [index, method] of ["tasks/result", "tasks/list"].entries()) {
      const response = await request(index + 1, method, { taskId: "job_test", _meta: meta() });
      expect(response.error.code).toBe(-32601);
    }
  });

  it("routes notifications/cancelled to active observation only", async () => {
    const { deliver, jobs, forwarded } = await setup();
    let signal: AbortSignal | undefined;
    jobs.get.mockImplementation((_id: unknown, options: any) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }));
    });
    deliver({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { taskId: "job_test", _meta: meta() } });
    await vi.waitFor(() => expect(signal).toBeDefined());
    deliver({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
    expect(signal!.aborted).toBe(true);
    expect(jobs.cancel).not.toHaveBeenCalled();
    expect(forwarded).toHaveBeenCalled();
  });
});
