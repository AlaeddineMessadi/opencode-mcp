import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { McpServer, type ToolContext } from "../src/mcp-server.js";
import { OpenCodeClient, OpenCodeError } from "../src/client.js";
import { registerWorkflowTools } from "../src/tools/workflow.js";

// OpenCode 2.x flat messages (after envelope unwrapping), tagged by `type`.
const user = (id: string, created = 1) => ({ id, type: "user", text: "Task", time: { created } });
const answer = (id: string, text: string, created = 2, extra: Record<string, unknown> = {}) => ({
  id, type: "assistant", agent: "build", model: { id: "preferred", providerID: "test" },
  time: { created, completed: created }, content: [{ type: "text", text }], finish: "stop", ...extra,
});
const idle = (id: string, created = 3, outcome = "succeeded", extra: Record<string, unknown> = {}) => ({ id, type: "idle", outcome, time: { created }, ...extra });

function setup() {
  const handlers = new Map<string, { schema: z.ZodRawShape; handler: Function }>();
  const server = { tool: (name: string, _description: string, schema: z.ZodRawShape, ...rest: unknown[]) => {
    handlers.set(name, { schema, handler: rest.at(-1) as Function });
  } } as unknown as McpServer;
  const state = {
    running: false, messages: [] as any[], forms: [] as unknown[], permissions: [] as unknown[],
    session: { id: "ses_test", title: "Test", time: { created: 1, updated: 1 } }, submittedId: "",
    /** Reply appended when a synchronous prompt's run finishes (via /wait). */
    reply: "Fixed the error in validation.", outcome: "succeeded" as string, clock: 10,
  };
  const client = {
    getBaseUrl: () => "http://127.0.0.1:4096",
    get: vi.fn(async (path: string, ..._args: any[]): Promise<any> => {
      if (path === "/api/session/active") return state.running ? { ses_test: { type: "running" } } : {};
      // The real API lists messages newest-first.
      if (path.endsWith("/message")) return [...state.messages].reverse();
      if (path === "/api/form") return state.forms;
      if (path === "/api/permission/request") return state.permissions;
      if (path === "/api/model") return [
        { id: "first", modelID: "first", providerID: "test", enabled: true },
        { id: "preferred", modelID: "preferred", providerID: "test", enabled: true },
        { id: "foreign", modelID: "foreign", providerID: "other", enabled: true },
      ];
      if (path === "/api/model/default") return { id: "preferred", modelID: "preferred", providerID: "test" };
      return state.session;
    }),
    post: vi.fn(async (path: string, body?: any, ..._args: any[]): Promise<any> => {
      if (path === "/api/session") return { ...state.session };
      if (path.endsWith("/prompt")) {
        const id = body.id ?? "msg_sync_user";
        state.submittedId = id;
        const created = ++state.clock;
        state.messages.push({ id, type: "user", text: body.text, time: { created } });
        return { id, sessionID: "ses_test", type: "user", time: { created }, payload: { text: body.text }, delivery: "queue" };
      }
      if (path.endsWith("/wait")) {
        state.messages.push(answer("msg_sync_answer", state.reply, ++state.clock));
        state.messages.push(idle("msg_sync_idle", ++state.clock, state.outcome, state.outcome === "failed" ? { error: { type: "ProviderError", message: "Provider unavailable" } } : {}));
        return undefined;
      }
      throw new Error(`Unexpected POST ${path}`);
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
      state.messages = [user("msg_old"), answer("msg_old_answer", "Old result"), idle("msg_old_idle")];
      const waiting = call("opencode_run", { prompt: "New task", sessionId: "ses_test", maxDurationSeconds: 1 });
      await vi.advanceTimersByTimeAsync(1001);
      const result = await waiting;
      expect(result.structuredContent).toMatchObject({ sessionId: "ses_test", messageId: state.submittedId, timedOut: true });
      expect(state.submittedId).toMatch(/^msg_/);
      expect(result.structuredContent.status).not.toBe("completed");
      expect(result.content[0].text).not.toContain("Old result");
      expect(result.isError).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports failed runs from the idle marker even when the session is no longer active", async () => {
    const { state, call } = setup();
    state.messages = [user("msg_current"), answer("msg_current_answer", "", 2, { content: [], finish: "error" }),
      idle("msg_current_idle", 3, "failed", { error: { type: "APIError", message: "Provider unavailable" } })];
    const result = await call("opencode_wait", { sessionId: "ses_test", timeoutSeconds: 1 });
    expect(result.structuredContent.status).toBe("failed");
    expect(result.structuredContent.error).toMatchObject({ type: "APIError" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("Session completed");
  });

  it("reports interrupted runs as cancelled, not completed", async () => {
    const { state, call } = setup();
    state.messages = [user("msg_current"), idle("msg_current_idle", 3, "interrupted")];
    const result = await call("opencode_wait", { sessionId: "ses_test", timeoutSeconds: 1 });
    expect(result.structuredContent.status).toBe("cancelled");
    expect(result.content[0].text).not.toContain("Session completed");
  });

  it("ignores older failures once a newer user turn is pending", async () => {
    const { state, call } = setup();
    state.messages = [user("msg_old"), answer("msg_old_answer", ""), idle("msg_old_idle", 3, "failed", { error: { type: "APIError", message: "old" } }), user("msg_new", 4)];
    const result = await call("opencode_wait", { sessionId: "ses_test", timeoutSeconds: 0.03, pollIntervalMs: 10 });
    expect(result.structuredContent).toMatchObject({ messageId: "msg_new", timedOut: true });
    expect(result.structuredContent.status).not.toBe("failed");
    expect(result.isError).toBeUndefined();
  });

  it("returns actionable input requests without waiting for timeout", async () => {
    const { state, call } = setup();
    state.running = true;
    state.messages = [user("msg_current")];
    state.forms = [{ id: "frm_1", sessionID: "ses_test", title: "Target", fields: [{ key: "target", type: "string", title: "Choose a target" }] }];
    const result = await call("opencode_wait", { sessionId: "ses_test", timeoutSeconds: 1 });
    expect(result.structuredContent.status).toBe("input_required");
    expect(result.structuredContent.inputs[0]).toMatchObject({ id: "frm_1", kind: "question" });
    expect(result.structuredContent.timedOut).toBeUndefined();
  });

  it("resumes exact job IDs returned by fire", async () => {
    const { state, client, call } = setup();
    const sent = await call("opencode_fire", { prompt: "Task", directory: "/remote/project" });
    expect(sent.structuredContent.status).toBe("accepted");
    expect(client.post.mock.calls[0][1]).toMatchObject({ location: { directory: "/remote/project" } });
    state.messages.push(answer("msg_done", "Done", 20), idle("msg_done_idle", 21));
    const result = await call("opencode_wait", { jobId: sent.structuredContent.jobId, timeoutSeconds: 1 });
    expect(result.structuredContent).toMatchObject({ status: "completed", directory: "/remote/project", messageId: state.submittedId });
    expect(result.content[0].text).toContain("Done");
  });

  it("preserves correlation IDs when submission is rejected", async () => {
    const { client, call } = setup();
    client.post.mockImplementation(async (path: string) => {
      if (path === "/api/session") return { id: "ses_test" };
      throw new OpenCodeError("Rejected", 400, "POST", path, "invalid");
    });
    const result = await call("opencode_fire", { prompt: "Task" });
    expect(result.structuredContent).toMatchObject({ status: "failed", sessionId: "ses_test", jobId: expect.stringMatching(/^job_/), messageId: expect.stringMatching(/^msg_/) });
    expect(result.isError).toBe(true);
  });
});

describe("observation lifecycle and cost", () => {
  it("cancels sleeping observation promptly without interrupting the remote job", async () => {
    const { state, client, call } = setup();
    state.running = true;
    state.messages = [user("msg_current")];
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

  it("uses the turn's snapshot file list and excludes full diff bodies from checks", async () => {
    const { state, client, call } = setup();
    state.running = true;
    state.messages = [user("msg_current"), answer("msg_step", "Implementing", 2, { finish: "tool-calls", snapshot: { files: ["src/a.ts", "src/b.ts"] } })];
    const result = await call("opencode_check", { sessionId: "ses_test" });
    expect(result.structuredContent.status).toBe("running");
    expect(result.content[0].text).toContain("Title: Test");
    expect(result.content[0].text).toContain("Files changed: 2");
    // Compact monitoring omits the response body unless detailed is requested.
    expect(result.content[0].text).not.toContain("Implementing");
    expect(client.get.mock.calls.some(([path]) => path.endsWith("/diff"))).toBe(false);
    const detailed = await call("opencode_check", { sessionId: "ses_test", detailed: true });
    expect(detailed.content[0].text).toContain("Implementing");
  });
});

describe("synchronous workflow contracts", () => {
  it("returns the answer of the submitted turn and preserves session identifiers", async () => {
    const { client, call } = setup();
    const result = await call("opencode_ask", { prompt: "Fix validation", directory: "/remote/project" });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ sessionId: "ses_test", directory: "/remote/project", data: { id: "msg_sync_answer" } });
    expect(result.content[0].text).toContain("Fixed the error in validation.");
    const paths = client.post.mock.calls.map(([path]) => path);
    expect(paths).toEqual(["/api/session", "/api/session/ses_test/prompt", "/api/experimental/session/ses_test/wait"]);
    expect(client.post.mock.calls[0][1]).toMatchObject({ location: { directory: "/remote/project" } });
    // v2 prompts are plain text: no prompt-level output format or model.
    expect(client.post.mock.calls[1][1]).toEqual({ text: "Fix validation" });
  });

  it("marks a synchronous answer failed when its run's idle marker failed", async () => {
    const { state, call } = setup();
    state.reply = "";
    state.outcome = "failed";
    const result = await call("opencode_ask", { prompt: "Task" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.sessionId).toBe("ses_test");
  });

  it("does not report an earlier turn's answer as the reply to a new prompt", async () => {
    const { state, client, call } = setup();
    state.messages = [user("msg_old"), answer("msg_old_answer", "Old result"), idle("msg_old_idle")];
    // The run has not produced an answer for the new prompt by the time /wait returns.
    client.post.mockImplementation(async (path: string, body?: any) => {
      if (path.endsWith("/prompt")) {
        state.messages.push({ id: "msg_new", type: "user", text: body.text, time: { created: 50 } });
        return { id: "msg_new", sessionID: "ses_test", type: "user", time: { created: 50 }, payload: { text: body.text }, delivery: "queue" };
      }
      return undefined;
    });
    const result = await call("opencode_reply", { sessionId: "ses_test", prompt: "New task" });
    expect(result.content[0].text).not.toContain("Old result");
  });

  it("preserves the created session if a synchronous prompt fails", async () => {
    const { client, call } = setup();
    client.post.mockImplementation(async (path: string) => {
      if (path === "/api/session") return { id: "ses_test" };
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
    expect(result.structuredContent).toMatchObject({ providerId: "test", modelID: "preferred" });
    const create = client.post.mock.calls.find(([path]) => path === "/api/session")!;
    expect(create[1]).toMatchObject({ model: { id: "preferred", providerID: "test" } });
    expect(create[1]).not.toHaveProperty("providerID");
    expect(client.post.mock.calls.find(([path]) => path.endsWith("/prompt"))![1]).not.toHaveProperty("model");
    expect(client.delete).toHaveBeenCalledWith("/api/session/ses_test", undefined, undefined);
  });

  it("falls back to the provider's first enabled model when the default belongs elsewhere", async () => {
    const { client, call } = setup();
    const original = client.get.getMockImplementation()!;
    client.get.mockImplementation(async (path: string, ...args: any[]) =>
      path === "/api/model/default" ? { id: "foreign", modelID: "foreign", providerID: "other" } : original(path, ...args));
    const result = await call("opencode_provider_test", { providerId: "test" });
    expect(result.structuredContent).toMatchObject({ modelID: "first" });
  });
});
