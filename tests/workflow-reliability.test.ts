import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { McpServer, type ToolContext } from "../src/mcp-server.js";
import { OpenCodeClient, OpenCodeError } from "../src/client.js";
import { registerWorkflowTools } from "../src/tools/workflow.js";

const user = (id: string, created = 1) => ({ info: { id, role: "user", time: { created } }, parts: [] });
const answer = (parentID: string, text: string, error?: unknown) => ({
  info: { id: `answer_${parentID}`, role: "assistant", parentID, time: { created: 2, completed: 3 }, ...(error ? { error } : {}) },
  parts: [{ type: "text", text }],
});

function setup() {
  const handlers = new Map<string, { schema: z.ZodRawShape; handler: Function }>();
  const server = { tool: (name: string, _description: string, schema: z.ZodRawShape, ...rest: unknown[]) => {
    handlers.set(name, { schema, handler: rest.at(-1) as Function });
  } } as unknown as McpServer;
  const state = {
    status: "idle", messages: [] as unknown[], questions: [] as unknown[], permissions: [] as unknown[],
    session: { id: "ses_test", title: "Test", summary: { files: 2 } }, submittedId: "",
  };
  const client = {
    getBaseUrl: () => "http://127.0.0.1:4096",
    get: vi.fn(async (path: string) => {
      if (path === "/session/status") return { ses_test: { type: state.status } };
      if (path.endsWith("/message")) return state.messages;
      if (path.endsWith("/todo")) return [{ status: "in_progress", content: "Implementing" }];
      if (path === "/question") return state.questions;
      if (path === "/permission") return state.permissions;
      if (path === "/provider") return { all: [{ id: "test", models: { first: {}, preferred: {} } }], default: { test: "preferred" } };
      return state.session;
    }),
    post: vi.fn(async (path: string, body?: any) => {
      if (path === "/session") return { id: "ses_test" };
      if (path.endsWith("/prompt_async")) { state.submittedId = body.messageID; return undefined; }
      return answer("sync", "Fixed the error in validation.");
    }),
    delete: vi.fn(async () => undefined),
  };
  registerWorkflowTools(server, client as unknown as OpenCodeClient);
  const call = (name: string, input: unknown, extra?: ToolContext) => {
    const entry = handlers.get(name)!;
    return entry.handler(z.object(entry.schema).parse(input), extra);
  };
  return { client, state, call };
}

describe("correlated asynchronous workflow results", () => {
  it("does not return an old completed response for a newly dispatched turn", async () => {
    vi.useFakeTimers();
    try {
      const { state, call } = setup();
      state.messages = [user("old"), answer("old", "Old result")];
      const waiting = call("opencode_run", { prompt: "New task", sessionId: "ses_test", maxDurationSeconds: 1 });
      await vi.advanceTimersByTimeAsync(1001);
      const result = await waiting;
      expect(result.structuredContent).toMatchObject({ sessionId: "ses_test", messageId: state.submittedId, timedOut: true });
      expect(result.structuredContent.status).not.toBe("completed");
      expect(result.content[0].text).not.toContain("Old result");
      expect(result.isError).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports typed assistant failures even when server status is idle", async () => {
    const { state, call } = setup();
    state.messages = [user("current"), answer("current", "", { name: "APIError", data: { message: "Provider unavailable" } })];
    const result = await call("opencode_wait", { sessionId: "ses_test", timeoutSeconds: 1 });
    expect(result.structuredContent.status).toBe("failed");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("Session completed");
  });

  it("ignores older failures once a newer user turn is pending", async () => {
    const { state, call } = setup();
    state.messages = [user("old"), answer("old", "", { name: "APIError" }), user("new", 4)];
    const result = await call("opencode_wait", { sessionId: "ses_test", timeoutSeconds: 0.03, pollIntervalMs: 10 });
    expect(result.structuredContent).toMatchObject({ messageId: "new", timedOut: true });
    expect(result.structuredContent.status).not.toBe("failed");
    expect(result.isError).toBeUndefined();
  });

  it("returns actionable input requests without waiting for timeout", async () => {
    const { state, call } = setup();
    state.status = "busy";
    state.questions = [{ id: "question_1", sessionID: "ses_test", questions: [{ question: "Choose a target" }] }];
    const result = await call("opencode_wait", { sessionId: "ses_test", timeoutSeconds: 1 });
    expect(result.structuredContent.status).toBe("input_required");
    expect(result.structuredContent.inputs[0]).toMatchObject({ id: "question_1", kind: "question" });
    expect(result.structuredContent.timedOut).toBeUndefined();
  });

  it("resumes exact job IDs returned by fire", async () => {
    const { state, call } = setup();
    const sent = await call("opencode_fire", { prompt: "Task", directory: "/remote/project" });
    expect(sent.structuredContent.status).toBe("accepted");
    state.messages = [user(state.submittedId), answer(state.submittedId, "Done")];
    const result = await call("opencode_wait", { jobId: sent.structuredContent.jobId, timeoutSeconds: 1 });
    expect(result.structuredContent).toMatchObject({ status: "completed", directory: "/remote/project", messageId: state.submittedId });
  });

  it("preserves correlation IDs when submission is rejected", async () => {
    const { client, call } = setup();
    client.post.mockImplementation(async path => {
      if (path === "/session") return { id: "ses_test" };
      throw new OpenCodeError("Rejected", 400, "POST", path, "invalid");
    });
    const result = await call("opencode_fire", { prompt: "Task" });
    expect(result.structuredContent).toMatchObject({ status: "failed", sessionId: "ses_test", jobId: expect.stringMatching(/^job_/), messageId: expect.stringMatching(/^msg_/) });
    expect(result.isError).toBe(true);
  });
});

describe("observation lifecycle and cost", () => {
  it("cancels sleeping observation promptly without aborting the remote job", async () => {
    const { state, client, call } = setup();
    state.status = "busy";
    const controller = new AbortController();
    const waiting = call("opencode_wait", { sessionId: "ses_test", timeoutSeconds: 5, pollIntervalMs: 5000 }, { signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort();
    const result = await waiting;
    expect(result.structuredContent).toMatchObject({ observationCancelled: true, status: "running" });
    expect(client.post).not.toHaveBeenCalled();
  });

  it("enforces the wait deadline even if an HTTP adapter never resolves", async () => {
    const { client, call } = setup();
    client.get.mockImplementation(() => new Promise(() => {}));
    const before = Date.now();
    const result = await call("opencode_wait", { sessionId: "ses_test", timeoutSeconds: 0.03 });
    expect(result.structuredContent).toMatchObject({ status: "unknown", timedOut: true });
    expect(result.isError).toBeUndefined();
    expect(Date.now() - before).toBeLessThan(1000);
    expect(client.get.mock.calls[0][3].signal.aborted).toBe(true);
  });

  it("uses summary file counts and excludes full diff bodies from checks", async () => {
    const { state, client, call } = setup();
    state.status = "busy";
    const result = await call("opencode_check", { sessionId: "ses_test" });
    expect(result.content[0].text).toContain("Files changed: 2");
    expect(result.content[0].text).toContain("Implementing");
    expect(client.get.mock.calls.some(([path]) => path.endsWith("/diff"))).toBe(false);
  });
});

describe("synchronous workflow contracts", () => {
  it("preserves session identifiers and format for successful debugging answers", async () => {
    const { client, call } = setup();
    const format = { type: "json_schema", schema: { type: "object" } };
    const result = await call("opencode_ask", { prompt: "Fix validation", format });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.sessionId).toBe("ses_test");
    expect(client.post.mock.lastCall?.[1]).toMatchObject({ format });
  });

  it("preserves the created session if a synchronous prompt fails", async () => {
    const { client, call } = setup();
    client.post.mockImplementation(async path => {
      if (path === "/session") return { id: "ses_test" };
      throw new Error("Request failed");
    });
    const result = await call("opencode_ask", { prompt: "Task" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.sessionId).toBe("ses_test");
    expect(result.content[0].text).toContain("ses_test");
  });

  it("selects an actual provider model for provider testing", async () => {
    const { client, call } = setup();
    const result = await call("opencode_provider_test", { providerId: "test" });
    expect(result.isError).toBeUndefined();
    expect(client.post.mock.lastCall?.[1]).toMatchObject({ model: { providerID: "test", modelID: "preferred" } });
    expect(client.post.mock.lastCall?.[1]).not.toHaveProperty("providerID");
    expect(client.delete).toHaveBeenCalledWith("/session/ses_test", undefined, undefined);
  });
});
