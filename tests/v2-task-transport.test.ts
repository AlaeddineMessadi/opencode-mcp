import { afterEach, describe, expect, it, vi } from "vitest";
import type { Transport } from "@modelcontextprotocol/server";
import { z } from "zod";
import { TaskTransport, TASKS_EXTENSION } from "../src/task-transport.js";
import { JobService } from "../src/jobs.js";
import { OpenCodeClient } from "../src/client.js";
import { backend } from "../src/backends/adapter.js";
import { V2Adapter } from "../src/backends/v2.js";
import { setModelDefaults } from "../src/helpers.js";
import { registerInputTools } from "../src/tools/input.js";
import { registerWorkflowTools } from "../src/tools/workflow.js";
import type { McpServer } from "../src/mcp-server.js";

// Protocol/adapter integration fixtures, not a live backend or GUI assertion.
const capable = { extensions: { [TASKS_EXTENSION]: {} }, elicitation: { form: {} } };
const metadata = (capabilities: unknown = capable) => ({
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": capabilities,
});
afterEach(() => { setModelDefaults(undefined, undefined); vi.restoreAllMocks(); });

async function setup() {
  const client = new OpenCodeClient({ baseUrl: "http://fixture.invalid", backend: "v2" });
  const events: any[] = [];
  const messages = new Map<string, any>();
  let forms: any[] = [], permissions: any[] = [];
  const session = { id: "session", title: "Fixture", projectID: "project", location: { directory: "/remote/project" },
    time: { created: 1, updated: 2 }, agent: "existing-agent", model: { providerID: "existing-provider", id: "existing-model", variant: "existing-variant" } };
  const event = (type: string, data: any = {}) => events.push({ type: `session.${type}`, durable: { aggregateID: session.id, seq: events.length + 1, version: 1 }, data: { sessionID: session.id, ...data } });
  const api: any = {
    location: { get: vi.fn(async () => ({ directory: "/remote/project", project: { id: "project", directory: "/remote/project" } })) },
    session: {
      get: vi.fn(async () => session), create: vi.fn(), switchModel: vi.fn(), switchAgent: vi.fn(),
      prompt: vi.fn(async ({ id }: any) => {
        messages.set(id, { id, type: "user", text: "Fixture task", time: { created: 1 } });
        event("inbox.enqueued", { inboxID: id, item: { type: "user", delivery: "queue" } });
        event("execution.started"); event("inbox.delivered", { inboxID: id });
        return { id, sessionID: session.id };
      }),
      log: vi.fn(({ after }: any) => (async function* () {
        for (const item of events) if (item.durable.seq > after) yield item;
        yield { type: "log.synced", aggregateID: session.id, seq: events.at(-1)?.durable.seq ?? 0 };
      })()),
      inbox: { list: vi.fn(async () => []), cancel: vi.fn() },
      interrupt: vi.fn(),
      message: { get: vi.fn(async ({ messageID }: any) => messages.get(messageID)) },
      form: {
        list: vi.fn(async () => forms),
        get: vi.fn(async ({ formID }: any) => forms.find(form => form.id === formID)),
        reply: vi.fn(async ({ formID }: any) => { forms = forms.filter(form => form.id !== formID); return {}; }),
        cancel: vi.fn(async () => { forms = []; return {}; }),
      },
    },
    permission: {
      list: vi.fn(async () => permissions),
      reply: vi.fn(async () => { permissions = []; return {}; }),
    },
  };
  Object.defineProperty(backend(client) as V2Adapter, "api", { value: api });
  const jobs = new JobService(client, { storeRoot: null });
  const sent: any[] = [];
  const inner = { start: vi.fn(async () => {}), close: vi.fn(async () => {}), send: vi.fn(async message => { sent.push(message); }) } as unknown as Transport;
  const transport = new TaskTransport(inner, jobs);
  const forwarded = vi.fn(); transport.onmessage = forwarded; transport.onerror = vi.fn(); await transport.start();
  let requestId = 0;
  const request = async (method: string, params: Record<string, unknown>, capabilities: unknown = capable) => {
    const id = ++requestId;
    inner.onmessage!({ jsonrpc: "2.0", id, method, params: { ...params, _meta: metadata(capabilities) } });
    await vi.waitFor(() => expect(sent.some(message => message.id === id)).toBe(true));
    return sent.find(message => message.id === id);
  };
  const entries = new Map<string, { shape: z.ZodRawShape; handler: Function }>();
  const registration = { tool: (name: string, _description: string, shape: z.ZodRawShape, ...rest: unknown[]) => entries.set(name, { shape, handler: rest.at(-1) as Function }) } as unknown as McpServer;
  registerInputTools(registration, client, jobs);
  registerWorkflowTools(registration, client, jobs);
  const tool = (name: string, input: unknown, extra?: unknown) => { const entry = entries.get(name)!; return entry.handler(z.object(entry.shape).parse(input), extra); };
  const run = async () => {
    const response = await request("tools/call", { name: "opencode_run", arguments: { prompt: "Fixture task", sessionId: "session", directory: "/remote/project" } });
    expect(response.error).toBeUndefined(); expect(response.result).toMatchObject({ resultType: "task", status: "working" });
    return response.result.taskId as string;
  };
  return { api, jobs, request, tool, run, forwarded,
    form(fields: any[]) { forms = [{ id: "form", sessionID: "session", title: "Choose values", fields, state: { status: "pending" } }]; },
    permission() { permissions = [{ id: "permission", sessionID: "session", action: "shell", resources: ["npm test"], save: ["npm *"] }]; },
    complete() {
      event("step.started", { assistantMessageID: "answer" });
      messages.set("answer", { id: "answer", type: "assistant", time: { created: 3, completed: 4 }, content: [{ type: "text", text: "Fixture completed" }], finish: "stop" });
      event("step.ended", { assistantMessageID: "answer", finish: "stop" }); event("execution.succeeded");
    },
  };
}
const fields = [
  { key: "count", type: "integer", required: true, minimum: 1, maximum: 5 },
  { key: "enabled", type: "boolean", required: true },
  { key: "target", type: "string", required: true, options: [{ label: "Web", value: "web" }, { label: "Mobile", value: "mobile" }] },
  { key: "checks", type: "multiselect", required: true, options: [{ label: "Unit", value: "unit" }, { label: "Integration", value: "integration" }], minItems: 1 },
];

describe("V2 native Tasks use the durable JobService", () => {
  it("returns a structured unsupported-capability error for native JSON-schema output without writing", async () => {
    const f = await setup();
    const response = await f.request("tools/call", { name: "opencode_run", arguments: { prompt: "Fixture task", sessionId: "session", format: { type: "json_schema", schema: { type: "object" } } } });
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({ resultType: "complete", isError: true, structuredContent: { error: { code: "UNSUPPORTED_CAPABILITY" } } });
    expect(f.api.session.prompt).not.toHaveBeenCalled(); expect(f.api.session.create).not.toHaveBeenCalled();
    expect(f.api.session.switchModel).not.toHaveBeenCalled(); expect(f.api.session.switchAgent).not.toHaveBeenCalled();
  });
  it.each(["opencode_fire", "opencode_run"])("preserves the structured capability error through ordinary %s", async name => {
    const f = await setup();
    const result = await f.tool(name, { prompt: "Fixture task", sessionId: "session", format: { type: "json_schema", schema: { type: "object" } } });
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "UNSUPPORTED_CAPABILITY" } } });
    expect(f.api.session.prompt).not.toHaveBeenCalled(); expect(f.api.session.create).not.toHaveBeenCalled();
    expect(f.api.session.switchModel).not.toHaveBeenCalled(); expect(f.api.session.switchAgent).not.toHaveBeenCalled();
  });
  it("preserves existing session selections despite configured default model values", async () => {
    setModelDefaults("configured-provider", "different-default-model");
    const f = await setup(); const taskId = await f.run();
    expect((await f.jobs.get(taskId)).status).toBe("running");
    expect(f.api.session.prompt).toHaveBeenCalledOnce();
    expect(f.api.session.prompt.mock.calls[0][0]).toMatchObject({ sessionID: "session", text: "Fixture task", delivery: "queue" });
    expect(f.api.session.create).not.toHaveBeenCalled(); expect(f.api.session.switchModel).not.toHaveBeenCalled(); expect(f.api.session.switchAgent).not.toHaveBeenCalled();
    expect(f.forwarded).not.toHaveBeenCalled();
  });
  it("round-trips typed native form values and exposes the same job through ordinary tools and Tasks", async () => {
    const f = await setup(); const taskId = await f.run(); f.form(fields);
    const pending = await f.request("tasks/get", { taskId });
    expect(pending.result).toMatchObject({ resultType: "complete", status: "input_required", taskId });
    const schema = pending.result.inputRequests["question:form"].params.requestedSchema;
    expect(schema.properties).toMatchObject({ count: { type: "integer", minimum: 1 }, enabled: { type: "boolean" }, target: { enum: ["web", "mobile"] }, checks: { type: "array" } });
    expect(schema.properties.enabled).not.toHaveProperty("default");
    const values = { count: 2, enabled: false, target: "web", checks: ["unit", "integration"] };
    const accepted = await f.request("tasks/update", { taskId, inputResponses: { "question:form": { action: "accept", content: values } } });
    expect(accepted.result).toEqual({ resultType: "complete" });
    expect(f.api.session.form.reply).toHaveBeenCalledWith({ sessionID: "session", formID: "form", answer: values }, expect.anything());
    expect((await f.tool("opencode_job_get", { jobId: taskId })).structuredContent).toMatchObject({ jobId: taskId, status: "running", backend: "v2" });
    // A consumed input key is acknowledged without replaying the backend write.
    await f.request("tasks/update", { taskId, inputResponses: { "question:form": { action: "accept", content: values } } });
    expect(f.api.session.form.reply).toHaveBeenCalledOnce();
    f.complete();
    const done = await f.request("tasks/get", { taskId });
    expect(done.result).toMatchObject({ status: "completed", result: { structuredContent: { jobId: taskId, status: "completed", backend: "v2" } } });
    expect(JSON.stringify(done.result.result)).toContain("Fixture completed");
    expect(f.api.session.prompt).toHaveBeenCalledOnce();
  });
  it("rejects invalid typed native values before mutation and allows a corrected response", async () => {
    const f = await setup(); const taskId = await f.run(); f.form([{ key: "count", type: "integer", required: true, minimum: 1 }]);
    const invalid = await f.request("tasks/update", { taskId, inputResponses: { "question:form": { action: "accept", content: { count: "two" } } } });
    expect(invalid.error).toBeDefined(); expect(f.api.session.form.reply).not.toHaveBeenCalled();
    expect((await f.request("tasks/get", { taskId })).result.status).toBe("input_required");
    expect((await f.request("tasks/update", { taskId, inputResponses: { "question:form": { action: "accept", content: { count: 2 } } } })).result).toEqual({ resultType: "complete" });
    expect(f.api.session.form.reply).toHaveBeenCalledOnce();
  });
  it.each([
    { label: "conditional", fields: [{ key: "include", type: "boolean", required: true }, { key: "name", type: "string", required: true, when: [{ key: "include", op: "eq", value: true }] }], values: { include: true, name: "fixture" } },
    { label: "pattern", fields: [{ key: "code", type: "string", required: true, pattern: "^[A-Z]+$" }], values: { code: "FIXTURE" } },
  ])("provides manual fallback for $label forms and accepts typed input through the same job", async item => {
    const f = await setup(); const taskId = await f.run(); f.form(item.fields);
    const pending = await f.request("tasks/get", { taskId }, { extensions: { [TASKS_EXTENSION]: {} } });
    expect(pending.error).toBeUndefined(); expect(pending.result).toMatchObject({ status: "working", taskId, pendingInputs: [{ id: "form", fields: item.fields, backend: "v2" }] });
    expect(pending.result).not.toHaveProperty("inputRequests"); expect(pending.result.statusMessage).toContain("Manual input required");
    const manual = await f.tool("opencode_job_input", { jobId: taskId }, { mcpReq: { envelope: metadata() } });
    expect(manual.resultType).not.toBe("input_required"); expect(manual.structuredContent).toMatchObject({ jobId: taskId, status: "input_required", inputs: [{ fields: item.fields }] });
    const applied = await f.tool("opencode_job_input", { jobId: taskId, responses: [{ id: "form", kind: "question", values: item.values }] });
    expect(applied.isError).not.toBe(true); expect(f.api.session.form.reply).toHaveBeenCalledWith({ sessionID: "session", formID: "form", answer: item.values }, expect.anything());
    expect((await f.request("tasks/get", { taskId })).result.status).toBe("working");
  });
  it("requires native form capability per request for representable V2 input", async () => {
    const f = await setup(); const taskId = await f.run(); f.form(fields);
    const response = await f.request("tasks/get", { taskId }, { extensions: { [TASKS_EXTENSION]: {} } });
    expect(response.error).toMatchObject({ code: -32021, data: { requiredCapabilities: { elicitation: { form: {} } } } });
    expect(f.api.session.form.reply).not.toHaveBeenCalled();
  });
});

describe("V2 Tasks preserve explicit permission scope", () => {
  it.each([{ decision: "always", scope: "project" }, { decision: "reject", scope: "session" }, { decision: "once", scope: "request" }])("requires matching $scope acknowledgement for $decision", async choice => {
    const f = await setup(); const taskId = await f.run(); f.permission();
    const pending = await f.request("tasks/get", { taskId });
    const form = pending.result.inputRequests["permission:permission"].params;
    expect(form.message).toContain("project-wide"); expect(form.message).toContain("ALL pending requests");
    expect(form.requestedSchema.required).toEqual(["decision", "scope"]);
    expect(form.requestedSchema.properties.decision).not.toHaveProperty("default");
    for (const content of [{ decision: choice.decision }, { decision: choice.decision, scope: "wrong" }]) {
      expect((await f.request("tasks/update", { taskId, inputResponses: { "permission:permission": { action: "accept", content } } })).error).toBeDefined();
      expect(f.api.permission.reply).not.toHaveBeenCalled();
    }
    const accepted = await f.request("tasks/update", { taskId, inputResponses: { "permission:permission": { action: "accept", content: choice } } });
    expect(accepted.result).toEqual({ resultType: "complete" });
    expect(f.api.permission.reply).toHaveBeenCalledWith(expect.objectContaining({ sessionID: "session", requestID: "permission", decision: choice.decision }), expect.anything());
    expect(f.api.permission.reply).toHaveBeenCalledOnce();
  });
  it.each(["decline", "cancel"])("does not infer session-wide rejection from native %s", async action => {
    const f = await setup(); const taskId = await f.run(); f.permission();
    const result = await f.request("tasks/update", { taskId, inputResponses: { "permission:permission": { action } } });
    expect(result.result).toEqual({ resultType: "complete" });
    expect(f.api.permission.reply).not.toHaveBeenCalled(); expect(f.api.session.interrupt).not.toHaveBeenCalled();
    expect((await f.request("tasks/get", { taskId })).result).toMatchObject({ status: "input_required", inputRequests: { "permission:permission": expect.anything() } });
  });
});
