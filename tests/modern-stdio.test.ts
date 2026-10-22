import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const executable = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const metadata = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {
    extensions: { "io.modelcontextprotocol/tasks": {} }, elicitation: { form: {} },
  },
};
interface Session { id: string; messageID?: string; prompt?: string; state: "busy" | "idle"; complete?: boolean; interrupted?: boolean; }
const password = "fixture-password";
const authorization = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
let http: Server;
let root: string;
let env: Record<string, string>;
let sessions: Map<string, Session>;
let aborts: number;
let replies: number;
const children: ChildProcessWithoutNullStreams[] = [];
const clients: LegacyClient[] = [];

/** OpenCode 2.x Session.Message.Info list for a session, newest-first like the real server. */
function messagesFor(session: Session) {
  const messages: Record<string, unknown>[] = [];
  if (session.messageID) messages.push({ id: session.messageID, type: "user", text: session.prompt, time: { created: 1 } });
  if (session.complete) {
    messages.push({ id: `msg_assistant_${session.id}`, type: "assistant", agent: "build", model: { id: "fixture", providerID: "fixture" },
      time: { created: 2, completed: 3 }, finish: "stop", content: [{ type: "text", text: "Fixture task completed." }] });
    messages.push({ id: `msg_idle_${session.id}`, type: "idle", outcome: "succeeded", time: { created: 4 } });
  } else if (session.interrupted) {
    messages.push({ id: `msg_idle_${session.id}`, type: "idle", outcome: "interrupted", time: { created: 4 } });
  }
  return messages.reverse();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "opencode-modern-stdio-"));
  sessions = new Map(); aborts = 0; replies = 0;
  http = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    const path = new URL(req.url!, "http://fixture").pathname;
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value)); };
    const location = { directory: root };
    // OpenCode 2.x enforces HTTP Basic auth on every route.
    if (req.headers.authorization !== authorization) { json({ _tag: "UnauthorizedError", message: "Unauthorized" }, 401); return; }
    if (path === "/api/info") { json({ version: "2.1.2", pid: process.pid, urls: ["http://fixture"], paths: { tmp: tmpdir() } }); return; }
    if (path === "/api/session" && req.method === "POST") {
      const session: Session = { id: `ses_fixture${sessions.size + 1}`, state: "idle" };
      sessions.set(session.id, session);
      json({ data: { id: session.id, projectID: "fixture", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 }, title: body.title, model: body.model, location: body.location ?? location } });
      return;
    }
    if (path === "/api/session/active") {
      json({ data: Object.fromEntries([...sessions.values()].filter((s) => s.state === "busy").map((s) => [s.id, { type: "running" }])) });
      return;
    }
    if (path === "/api/form") { json({ location, data: [] }); return; }
    if (path === "/api/permission/request") {
      json({ location, data: [...sessions.values()].filter((s) => s.prompt === "ask permission" && !s.complete).map((s) => ({
        id: `per_${s.id}`, sessionID: s.id, action: "edit", resources: ["src/fixture.ts"], save: [], metadata: {},
      })) });
      return;
    }
    const parts = path.split("/");
    const session = parts[1] === "api" && parts[2] === "session" ? sessions.get(parts[3]) : undefined;
    if (!session) { json({ _tag: "SessionNotFoundError", message: "unknown fixture route" }, 404); return; }
    if (parts[4] === "permission" && parts[6] === "reply" && req.method === "POST") {
      if (body.decision !== "once") { json({ _tag: "InvalidRequestError", message: "unexpected decision" }, 400); return; }
      replies++; session.complete = true; session.state = "idle";
      res.writeHead(204).end(); return;
    }
    if (parts[4] === "prompt" && req.method === "POST") {
      session.messageID = body.id; session.prompt = body.text;
      session.complete = session.prompt !== "hold" && session.prompt !== "ask permission";
      session.state = session.complete ? "idle" : "busy";
      json({ data: { id: body.id, sessionID: session.id, type: "user", time: { created: 1 }, payload: { text: body.text }, delivery: "queued" } });
      return;
    }
    if (parts[4] === "interrupt") { aborts++; session.state = "idle"; session.interrupted = true; json({ interrupted: true }); return; }
    if (parts[4] === "message") { json({ data: messagesFor(session), cursor: { previous: null, next: null } }); return; }
    if (parts.length === 4) {
      json({ data: { id: session.id, projectID: "fixture", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 }, title: "Fixture session", location } });
      return;
    }
    json({ _tag: "NotFound", message: "unknown fixture route" }, 404);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.OPENCODE_SERVER_USERNAME;
  Object.assign(env, { OPENCODE_BASE_URL: base, OPENCODE_AUTO_SERVE: "false", OPENCODE_TASK_STORE: root,
    OPENCODE_SERVER_PASSWORD: password, OPENCODE_TOOL_PROFILE: "full",
    OPENCODE_DEFAULT_PROVIDER: "fixture", OPENCODE_DEFAULT_MODEL: "fixture" });
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.stdin.end(); await exited;
    }
  }
  http.closeAllConnections();
  await new Promise<void>((resolve) => http.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

function rawConnection() {
  const child = spawn(process.execPath, [executable], { env, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  let buffer = ""; let nextId = 0; let stderr = "";
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const handler = pending.get(message.id);
      if (handler) { clearTimeout(handler.timer); pending.delete(message.id); handler.resolve(message); }
    }
  });
  child.on("exit", () => {
    for (const handler of pending.values()) { clearTimeout(handler.timer); handler.reject(new Error(`Child exited: ${stderr.slice(-2000)}`)); }
    pending.clear();
  });
  return {
    async request(method: string, params: Record<string, unknown> = {}, meta: Record<string, unknown> = metadata) {
      const id = ++nextId;
      const response = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out waiting for ${method}: ${stderr.slice(-2000)}`)); }, 5000);
        pending.set(id, { resolve, reject, timer });
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } }) + "\n");
      return response;
    },
    async close() { if (child.exitCode === null) { const exited = once(child, "exit"); child.stdin.end(); await exited; } },
  };
}

describe("July 2026 stdio interoperability", () => {
  it("serves stateless discovery and a durable task result with a reconnect", async () => {
    const first = rawConnection();
    const list = await first.request("tools/list");
    expect(list.error).toBeUndefined();
    const run = list.result.tools.find((tool: any) => tool.name === "opencode_run");
    expect(run).toBeDefined();
    expect(run.outputSchema).toBeDefined();
    expect(list.result.tools.every((tool: any) => tool.annotations)).toBe(true);
    const started = await first.request("tools/call", { name: "opencode_run", arguments: { prompt: "complete fixture" } });
    expect(started.error).toBeUndefined();
    expect(started.result).toMatchObject({ resultType: "task", status: "working", taskId: expect.any(String) });
    await first.close();
    const second = rawConnection();
    const get = await second.request("tasks/get", { taskId: started.result.taskId });
    expect(get.error).toBeUndefined();
    expect(get.result).toMatchObject({ resultType: "complete", status: "completed", result: { resultType: "complete",
      structuredContent: { status: "completed", result: { type: "assistant", id: expect.stringMatching(/^msg_assistant_/) } } } });
    expect(get.result.result.content[0].text).toContain("Fixture task completed.");
    expect(sessions.size).toBe(1);
  });

  it("reports input_required, accepts explicit permission input, and completes", async () => {
    const connection = rawConnection();
    const started = await connection.request("tools/call", { name: "opencode_run", arguments: { prompt: "ask permission" } });
    expect(started.error).toBeUndefined();
    const taskId = started.result.taskId;
    const get = await connection.request("tasks/get", { taskId });
    expect(get.result.status).toBe("input_required");
    const key = Object.keys(get.result.inputRequests)[0];
    expect(key).toBe("permission:per_ses_fixture1");
    expect(get.result.inputRequests[key].params.message).toContain("edit");
    expect(replies).toBe(0);
    const updated = await connection.request("tasks/update", { taskId, inputResponses: {
      [key]: { action: "accept", content: { decision: "once" } },
    } });
    expect(updated.error).toBeUndefined();
    expect(updated.result.resultType).toBe("complete");
    expect(replies).toBe(1);
    expect((await connection.request("tasks/get", { taskId })).result.status).toBe("completed");
  });

  it("round-trips explicit input forms through the SDK core tool handler", async () => {
    const connection = rawConnection();
    const started = await connection.request("tools/call", { name: "opencode_fire", arguments: { prompt: "ask permission" } });
    expect(started.error).toBeUndefined();
    const jobId = started.result.structuredContent.jobId;
    const form = await connection.request("tools/call", { name: "opencode_job_input", arguments: { jobId } });
    expect(form.error).toBeUndefined();
    expect(form.result.resultType).toBe("input_required");
    const key = Object.keys(form.result.inputRequests)[0];
    expect(replies).toBe(0);
    const finished = await connection.request("tools/call", { name: "opencode_job_input", arguments: { jobId },
      inputResponses: { [key]: { action: "accept", content: { decision: "once" } } } });
    expect(finished.error).toBeUndefined();
    expect(finished.result.structuredContent).toMatchObject({ status: "completed", isError: false });
    expect(replies).toBe(1);
  });

  it("deduplicates the same permission response across two bridge processes", async () => {
    const first = rawConnection();
    const second = rawConnection();
    const started = await first.request("tools/call", { name: "opencode_run", arguments: { prompt: "ask permission" } });
    const taskId = started.result.taskId;
    const get = await first.request("tasks/get", { taskId });
    const key = Object.keys(get.result.inputRequests)[0];
    const params = { taskId, inputResponses: { [key]: { action: "accept", content: { decision: "once" } } } };
    const results = await Promise.all([first.request("tasks/update", params), second.request("tasks/update", params)]);
    for (const result of results) expect(result.error).toBeUndefined();
    expect(replies).toBe(1);
  });

  it("cancels remote work only through an explicit Tasks cancel", async () => {
    const connection = rawConnection();
    const started = await connection.request("tools/call", { name: "opencode_run", arguments: { prompt: "hold" } });
    expect(started.error).toBeUndefined();
    const taskId = started.result.taskId;
    expect((await connection.request("tasks/get", { taskId })).result.status).toBe("working");
    expect(aborts).toBe(0);
    expect((await connection.request("tasks/cancel", { taskId })).error).toBeUndefined();
    expect((await connection.request("tasks/get", { taskId })).result.status).toBe("cancelled");
    expect(aborts).toBe(1);
  });

  it("requires explicit Tasks capability and rejects invalid task arguments", async () => {
    const connection = rawConnection();
    const noTasks = { ...metadata, "io.modelcontextprotocol/clientCapabilities": {} };
    const unsupported = await connection.request("tasks/get", { taskId: "fixture" }, noTasks);
    expect(unsupported.error?.code).toBe(-32021);
    const invalid = await connection.request("tools/call", { name: "opencode_run", arguments: { prompt: "" } });
    expect(invalid.error?.code).toBe(-32602);
    expect(sessions.size).toBe(0);
  });

  it("retains legacy SDK v1 handshake, discovery, fire and structured get", async () => {
    const legacy = new LegacyClient({ name: "fixture-v1", version: "1.0.0" });
    clients.push(legacy);
    await legacy.connect(new LegacyTransport({ command: process.execPath, args: [executable], env, stderr: "pipe" }));
    const catalog = await legacy.listTools();
    expect(catalog.tools.some((tool) => tool.name === "opencode_fire")).toBe(true);
    const started = await legacy.callTool({ name: "opencode_fire", arguments: { prompt: "complete fixture" } });
    expect(started.isError).not.toBe(true);
    const jobId = (started.structuredContent as any).jobId;
    expect(jobId).toMatch(/^job_/);
    const finished = await legacy.callTool({ name: "opencode_job_get", arguments: { jobId } });
    expect(finished.isError).not.toBe(true);
    expect(finished.structuredContent).toMatchObject({ status: "completed", result: { type: "assistant", finish: "stop" } });
  });
});
