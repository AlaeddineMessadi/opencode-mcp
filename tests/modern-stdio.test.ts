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
interface Session { id: string; messageID?: string; prompt?: string; state: "busy" | "idle"; complete?: boolean; }
let http: Server;
let root: string;
let env: Record<string, string>;
let sessions: Map<string, Session>;
let aborts: number;
let replies: number;
const children: ChildProcessWithoutNullStreams[] = [];
const clients: LegacyClient[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "opencode-modern-stdio-"));
  sessions = new Map(); aborts = 0; replies = 0;
  http = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    const path = new URL(req.url!, "http://fixture").pathname;
    const json = (value: unknown) => { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value)); };
    if (path === "/global/health") { json({ healthy: true, version: "fixture" }); return; }
    if (path === "/session" && req.method === "POST") {
      const session: Session = { id: `session_${sessions.size + 1}`, state: "idle" };
      sessions.set(session.id, session); json({ id: session.id }); return;
    }
    if (path === "/session/status") { json(Object.fromEntries([...sessions.values()].map((session) => [session.id, { type: session.state }]))); return; }
    if (path === "/question") { json([]); return; }
    if (path === "/permission") {
      json([...sessions.values()].filter((session) => session.prompt === "ask permission" && !session.complete).map((session) => ({
        id: `permission_${session.id}`, sessionID: session.id, permission: "edit", patterns: ["src/fixture.ts"], always: [], metadata: {},
      }))); return;
    }
    if (path.startsWith("/permission/") && path.endsWith("/reply")) {
      const session = sessions.get(path.split("/")[2].replace("permission_", ""))!;
      replies++; session.complete = true; session.state = "idle";
      json(true); return;
    }
    const session = sessions.get(path.split("/")[2]);
    if (!session) { res.writeHead(404, { "content-type": "application/json" }).end('{"error":"unknown fixture route"}'); return; }
    if (path.endsWith("/prompt_async")) {
      session.messageID = body.messageID; session.prompt = body.parts[0].text;
      session.complete = session.prompt !== "hold" && session.prompt !== "ask permission";
      session.state = session.complete ? "idle" : "busy";
      res.writeHead(204).end(); return;
    }
    if (path.endsWith("/abort")) { aborts++; session.state = "idle"; json(true); return; }
    if (path.endsWith("/message")) {
      const messages = session.messageID ? [{ info: { id: session.messageID, role: "user", time: { created: 1 } }, parts: [] }] : [];
      if (session.complete) messages.push({ info: {
        id: `assistant_${session.id}`, role: "assistant", parentID: session.messageID,
        time: { created: 2, completed: 3 }, finish: "stop", structured: { fixture: true },
      }, parts: [{ type: "text", text: "Fixture task completed." }] } as any);
      json(messages); return;
    }
    if (path.endsWith("/todo")) { json([]); return; }
    json({ id: session.id, title: "Fixture session", summary: { files: 0 } });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  Object.assign(env, { OPENCODE_BASE_URL: base, OPENCODE_AUTO_SERVE: "false", OPENCODE_TASK_STORE: root,
    OPENCODE_SERVER_USERNAME: "", OPENCODE_SERVER_PASSWORD: "", OPENCODE_TOOL_PROFILE: "full",
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
    expect(get.result).toMatchObject({ resultType: "complete", status: "completed", result: { resultType: "complete", structuredContent: { result: { fixture: true } } } });
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
    expect(key).toBe("permission:permission_session_1");
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
    expect(finished.structuredContent).toMatchObject({ status: "completed", result: { fixture: true } });
  });
});
