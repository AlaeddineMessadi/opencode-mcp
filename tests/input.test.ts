import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { decodeInputResponses, inputAnswerSchema, inputRequests, supportsForm } from "../src/task-input.js";
import { registerInputTools } from "../src/tools/input.js";
import { McpServer, withStructuredText } from "../src/mcp-server.js";
import { OpenCodeClient } from "../src/client.js";
import { JobService } from "../src/jobs.js";

// OpenCode 2.x shapes: Permission.Request and Form.Info (GET /api/permission/request, GET /api/form).
const pending = [
  { id: "per1", kind: "permission" as const, sessionID: "ses1", action: "bash", resources: ["npm test"], message: "Run the test suite" },
  { id: "frm1", kind: "question" as const, sessionID: "ses1", title: "Release", fields: [
    { key: "target", type: "string", title: "Target?", options: [{ value: "web", label: "web" }, { value: "mobile", label: "mobile" }] },
    { key: "checks", type: "multiselect", title: "Checks?", options: [{ value: "unit", label: "unit" }, { value: "integration", label: "integration" }] },
  ] },
];

function setup() {
  const entries = new Map<string, { shape: z.ZodRawShape; handler: Function }>();
  const server = { tool: (name: string, _description: string, shape: z.ZodRawShape, ...rest: unknown[]) => {
    entries.set(name, { shape, handler: rest.at(-1) as Function });
  } } as unknown as McpServer;
  const client = { get: vi.fn(async () => []), post: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) };
  const job = { jobId: "job_test", sessionId: "ses1", status: "input_required", inputs: pending };
  const jobs = { get: vi.fn(async () => job), update: vi.fn(async () => ({ ...job, status: "running", inputs: [] })),
    list: vi.fn(async () => [job]), cancel: vi.fn(async () => ({ ...job, status: "cancelled" })) };
  registerInputTools(server, client as unknown as OpenCodeClient, jobs as unknown as JobService);
  const call = (name: string, input: unknown, extra?: unknown) => {
    const entry = entries.get(name)!;
    return entry.handler(z.object(entry.shape).parse(input), extra);
  };
  return { call, client, jobs, job };
}

describe("input form translation", () => {
  it("requires explicit permission decisions and never preselects approval", () => {
    const requests = inputRequests(pending);
    const permission: any = requests["permission:per1"];
    expect(permission.method).toBe("elicitation/create");
    expect(permission.params.message).toContain("bash");
    expect(permission.params.message).toContain('["npm test"]');
    expect(permission.params.message).toContain("Run the test suite");
    expect(permission.params.requestedSchema.properties.decision.enum).toEqual(["once", "always", "reject"]);
    expect(permission.params.requestedSchema.properties.decision).not.toHaveProperty("default");
    expect(permission.params.requestedSchema.required).toEqual(["decision"]);
  });

  it("builds one string property per form field and flags multiselect fields", () => {
    const form: any = inputRequests(pending)["question:frm1"];
    expect(form.params.message).toBe("Target?\nChecks?");
    expect(Object.keys(form.params.requestedSchema.properties)).toEqual(["answer_0", "answer_1"]);
    expect(form.params.requestedSchema.properties.answer_0.description).toContain("Options: web, mobile.");
    expect(form.params.requestedSchema.properties.answer_0.description).not.toContain("JSON array");
    expect(form.params.requestedSchema.properties.answer_1.description).toContain("JSON array");
    expect(form.params.requestedSchema.required).toEqual(["answer_0", "answer_1"]);
  });

  it("decodes mixed form answers and maps explicit decline to rejection", () => {
    expect(decodeInputResponses(pending, {
      "permission:per1": { action: "decline" },
      "question:frm1": { action: "accept", content: { answer_0: "web", answer_1: '["unit","integration"]' } },
    })).toEqual([
      { id: "per1", kind: "permission", reply: "reject" },
      { id: "frm1", kind: "question", answers: [["web"], ["unit", "integration"]] },
    ]);
    expect(decodeInputResponses(pending, { "question:frm1": { action: "cancel" } })).toEqual([
      { id: "frm1", kind: "question", reject: true },
    ]);
  });

  it("validates missing decisions and mutually exclusive answer kinds", () => {
    expect(() => decodeInputResponses(pending, { "permission:per1": { action: "accept" } })).toThrow();
    for (const value of [
      { id: "x", kind: "permission" },
      { id: "x", kind: "permission", reply: "once", answers: [] },
      { id: "x", kind: "question", answers: [], reject: true },
      { id: "x", kind: "question" },
    ]) expect(inputAnswerSchema.safeParse(value).success).toBe(false);
  });

  it("ignores unknown response keys and checks form capability per request", () => {
    expect(decodeInputResponses(pending, { "question:old": { action: "accept" } })).toEqual([]);
    expect(supportsForm({ elicitation: { form: {} } })).toBe(true);
    for (const capabilities of [undefined, {}, { elicitation: {} }, { elicitation: { form: null } }]) expect(supportsForm(capabilities)).toBe(false);
  });
});

describe("question and job input tools", () => {
  it("keeps envelope text and error flags authoritative when job data contains undefined text", () => {
    const result = withStructuredText({ content: [{ type: "text", text: "Job is running" }],
      structuredContent: { text: undefined, isError: undefined, status: "running" } });
    expect(result.structuredContent).toMatchObject({ text: "Job is running", isError: false, status: "running" });
  });

  it("lists pending forms from /api/form filtered by session", async () => {
    const { call, client } = setup();
    client.get.mockResolvedValue([{ id: "frm1", sessionID: "ses1" }, { id: "frm2", sessionID: "other" }] as never);
    const list = await call("opencode_question_list", { sessionId: "ses1", directory: "/remote/project" });
    expect(client.get).toHaveBeenLastCalledWith("/api/form", undefined, "/remote/project");
    expect(list.structuredContent.data).toEqual([{ id: "frm1", sessionID: "ses1" }]);
  });

  it("replies to a form at its session-scoped route with an encoded ID and keyed answer map", async () => {
    const { call, client } = setup();
    await call("opencode_question_reply", { requestId: "frm/1", sessionId: "ses1", answer: { target: "web", checks: ["unit"] }, directory: "/remote/project" });
    expect(client.get).not.toHaveBeenCalled();
    expect(client.post).toHaveBeenLastCalledWith("/api/session/ses1/form/frm%2F1/reply",
      { answer: { target: "web", checks: ["unit"] } }, { directory: "/remote/project" });
  });

  it("auto-detects the owning session from the pending form list", async () => {
    const { call, client } = setup();
    client.get.mockResolvedValue([{ id: "frm1", sessionID: "ses/9" }] as never);
    await call("opencode_question_reply", { requestId: "frm1", answer: { target: "web" } });
    expect(client.get).toHaveBeenCalledWith("/api/form", undefined, undefined);
    expect(client.post).toHaveBeenLastCalledWith("/api/session/ses%2F9/form/frm1/reply", { answer: { target: "web" } }, { directory: undefined });
    const missing = await call("opencode_question_reply", { requestId: "frm_unknown", answer: {} });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("Form not found");
  });

  it("dismisses a form with DELETE on its session-scoped route", async () => {
    const { call, client } = setup();
    client.get.mockResolvedValue([{ id: "frm1", sessionID: "ses1" }] as never);
    await call("opencode_question_reject", { requestId: "frm1", directory: "/remote/project" });
    expect(client.delete).toHaveBeenLastCalledWith("/api/session/ses1/form/frm1", undefined, "/remote/project");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("returns manual input data when the client cannot display forms", async () => {
    const { call, jobs } = setup();
    const result = await call("opencode_job_input", { jobId: "job_test" });
    expect(result.structuredContent).toMatchObject({ status: "input_required", inputs: pending });
    expect(jobs.update).not.toHaveBeenCalled();
  });

  it("returns an MCP input_required result only for form-capable clients", async () => {
    const { call, jobs } = setup();
    const result = await call("opencode_job_input", { jobId: "job_test" }, { mcpReq: { envelope: { "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } } } } });
    expect(result.resultType).toBe("input_required");
    expect(result.inputRequests).toHaveProperty("permission:per1");
    expect(result.inputRequests).toHaveProperty("question:frm1");
    expect(jobs.update).not.toHaveBeenCalled();
  });

  it("forwards explicit decisions and validates MRTR responses", async () => {
    const { call, jobs } = setup();
    const responses = [{ id: "per1", kind: "permission", reply: "once" }];
    await call("opencode_job_input", { jobId: "job_test", responses });
    expect(jobs.update).toHaveBeenLastCalledWith("job_test", responses, expect.any(Object));
    await call("opencode_job_input", { jobId: "job_test" }, { mcpReq: { inputResponses: { "permission:per1": { action: "accept", content: { decision: "reject" } } } } });
    expect(jobs.update).toHaveBeenLastCalledWith("job_test", [{ id: "per1", kind: "permission", reply: "reject" }], expect.any(Object));
  });

  it("does not submit an empty update for stale MRTR response keys", async () => {
    const { call, jobs } = setup();
    const result = await call("opencode_job_input", { jobId: "job_test" }, { mcpReq: { inputResponses: { "question:old": { action: "accept", content: {} } } } });
    expect(jobs.update).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
  });
});
