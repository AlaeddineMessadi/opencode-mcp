import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { decodeInputResponses, inputAnswerSchema, inputRequests, supportsForm } from "../src/task-input.js";
import { registerInputTools } from "../src/tools/input.js";
import { McpServer, withStructuredText } from "../src/mcp-server.js";
import { OpenCodeClient } from "../src/client.js";
import { JobService } from "../src/jobs.js";

const pending = [
  { id: "perm1", kind: "permission" as const, sessionID: "ses1", permission: "bash", patterns: ["npm test"] },
  { id: "q1", kind: "question" as const, sessionID: "ses1", questions: [
    { question: "Target?", options: [{ label: "web" }, { label: "mobile" }] },
    { question: "Checks?", multiple: true, options: [{ label: "unit" }, { label: "integration" }] },
  ] },
];

function setup() {
  const entries = new Map<string, { shape: z.ZodRawShape; handler: Function }>();
  const server = { tool: (name: string, _description: string, shape: z.ZodRawShape, ...rest: unknown[]) => {
    entries.set(name, { shape, handler: rest.at(-1) as Function });
  } } as unknown as McpServer;
  const client = { get: vi.fn(async () => []), post: vi.fn(async () => true) };
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
    const permission: any = requests["permission:perm1"];
    expect(permission.method).toBe("elicitation/create");
    expect(permission.params.requestedSchema.properties.decision.enum).toEqual(["once", "always", "reject"]);
    expect(permission.params.requestedSchema.properties.decision).not.toHaveProperty("default");
    expect(permission.params.requestedSchema.required).toEqual(["decision"]);
  });

  it("decodes mixed form answers and maps explicit decline to rejection", () => {
    expect(decodeInputResponses(pending, {
      "permission:perm1": { action: "decline" },
      "question:q1": { action: "accept", content: { answer_0: "web", answer_1: '["unit","integration"]' } },
    })).toEqual([
      { id: "perm1", kind: "permission", reply: "reject" },
      { id: "q1", kind: "question", answers: [["web"], ["unit", "integration"]] },
    ]);
  });

  it("validates missing decisions and mutually exclusive answer kinds", () => {
    expect(() => decodeInputResponses(pending, { "permission:perm1": { action: "accept" } })).toThrow();
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

  it("filters questions by session and encodes reply request IDs", async () => {
    const { call, client } = setup();
    client.get.mockResolvedValue([{ id: "q1", sessionID: "ses1" }, { id: "q2", sessionID: "other" }] as never);
    const list = await call("opencode_question_list", { sessionId: "ses1", directory: "/remote/project" });
    expect(list.structuredContent.data).toEqual([{ id: "q1", sessionID: "ses1" }]);
    await call("opencode_question_reply", { requestId: "q/1", answers: [["web"]], directory: "/remote/project" });
    expect(client.post).toHaveBeenLastCalledWith("/question/q%2F1/reply", { answers: [["web"]] }, { directory: "/remote/project" });
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
    expect(result.inputRequests).toHaveProperty("permission:perm1");
    expect(jobs.update).not.toHaveBeenCalled();
  });

  it("forwards explicit decisions and validates MRTR responses", async () => {
    const { call, jobs } = setup();
    const responses = [{ id: "perm1", kind: "permission", reply: "once" }];
    await call("opencode_job_input", { jobId: "job_test", responses });
    expect(jobs.update).toHaveBeenLastCalledWith("job_test", responses, expect.any(Object));
    await call("opencode_job_input", { jobId: "job_test" }, { mcpReq: { inputResponses: { "permission:perm1": { action: "accept", content: { decision: "reject" } } } } });
    expect(jobs.update).toHaveBeenLastCalledWith("job_test", [{ id: "perm1", kind: "permission", reply: "reject" }], expect.any(Object));
  });

  it("does not submit an empty update for stale MRTR response keys", async () => {
    const { call, jobs } = setup();
    const result = await call("opencode_job_input", { jobId: "job_test" }, { mcpReq: { inputResponses: { "question:old": { action: "accept", content: {} } } } });
    expect(jobs.update).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
  });
});
