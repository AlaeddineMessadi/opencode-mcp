import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeClient } from "../src/client.js";
import { JobService } from "../src/jobs.js";
import { operate } from "../src/backends/adapter.js";

// Protocol fixture, not a claim of live native inference. The real published
// SDK parses these HTTP envelopes and SSE frames; no SDK/adapter methods mock.
let root: string;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "opencode-v2-http-jobs-")); });
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const sessionID = "ses_http_fixture";
  const session = { id: sessionID, title: "HTTP fixture", projectID: "prj_fixture", location: { directory: "/remote/project" },
    model: { providerID: "fixture", id: "model" }, agent: "build", time: { created: 1, updated: 1 } };
  const calls: Array<{ method: string; path: string; query: URLSearchParams; body: any }> = [];
  const events: any[] = [];
  const inbox = new Map<string, any>();
  const messages = new Map<string, any>();
  let loseReceipt = false;
  const event = (type: string, data: any = {}) => events.push({ id: `evt_${events.length + 1}`, type: `session.${type}`, created: 1,
    durable: { aggregateID: sessionID, seq: events.length + 1, version: 1 }, data: { sessionID, ...data } });
  const json = (res: ServerResponse, data: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data })); };
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Basic ${Buffer.from("fixture:local-only").toString("base64")}`) { res.writeHead(401); res.end(); return; }
    const url = new URL(req.url!, "http://fixture"); const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString(); const body = text ? JSON.parse(text) : undefined;
    calls.push({ method: req.method!, path: url.pathname, query: url.searchParams, body });
    if (req.method === "POST" && url.pathname === "/api/session") return json(res, session);
    if (req.method === "GET" && url.pathname === `/api/session/${sessionID}`) return json(res, session);
    if (url.pathname === `/api/session/${sessionID}/prompt` && req.method === "POST") {
      const receipt = { id: body.id, sessionID, time: { created: 1 }, type: "user", delivery: body.delivery, payload: { text: body.text } };
      inbox.set(body.id, receipt); event("inbox.enqueued", { inboxID: body.id, item: { type: "user", delivery: body.delivery, payload: { text: body.text } } });
      if (loseReceipt) { res.destroy(); return; }
      return json(res, receipt);
    }
    if (url.pathname === `/api/experimental/session/${sessionID}/log`) {
      const after = Number(url.searchParams.get("after") ?? 0);
      res.setHeader("content-type", "text/event-stream");
      const replay = [...events.filter(value => value.durable.seq > after), { type: "log.synced", aggregateID: sessionID, seq: events.length }];
      // CRLF and split writes exercise the real SDK's framing, not a direct iterator.
      const frames = replay.map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join("");
      res.write(frames.slice(0, 37)); res.end(frames.slice(37)); return;
    }
    if (url.pathname === `/api/session/${sessionID}/inbox` && req.method === "GET") return json(res, [...inbox.values()]);
    if ([`/api/session/${sessionID}/form`, `/api/session/${sessionID}/permission`].includes(url.pathname)) return json(res, []);
    if (url.pathname.startsWith(`/api/session/${sessionID}/message/`)) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      if (!messages.has(id)) { res.statusCode = 404; return json(res, { message: "Projection absent" }); }
      return json(res, messages.get(id));
    }
    res.statusCode = 404; json(res, { message: "Unexpected fixture route" });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = () => new OpenCodeClient({ baseUrl, backend: "v2", username: "fixture", password: "local-only" });
  return { client, sessionID, calls, events, loseReceipt: () => { loseReceipt = true; },
    deliver(id: string) {
      const receipt = inbox.get(id); expect(receipt).toBeDefined(); inbox.delete(id);
      event("execution.started"); event("inbox.delivered", { inboxID: id });
      messages.set(id, { id, type: "user", text: receipt.payload.text, time: { created: 2 } });
      event("step.started", { assistantMessageID: "msg_assistant_http" });
      messages.set("msg_assistant_http", { id: "msg_assistant_http", type: "assistant", content: [{ type: "text", text: "Partial response" }], time: { created: 3 } });
    },
    finish() {
      messages.set("msg_assistant_http", { id: "msg_assistant_http", type: "assistant", content: [{ type: "text", text: "Completed response" }], time: { created: 3, completed: 4 }, finish: "stop" });
      event("step.ended", { assistantMessageID: "msg_assistant_http", finish: "stop", cost: 0, tokens: {} }); event("execution.succeeded");
    },
  };
}
async function record(jobId: string) {
  const namespace = join(root, (await readdir(root))[0]);
  return JSON.parse(await readFile(join(namespace, "v2", `${jobId}.json`), "utf8"));
}

describe("V2 jobs through the actual SDK HTTP transport", () => {
  it("persists the admission receipt and preserves assigned message identity through user projection and restart", async () => {
    const f = await fixture(); const firstClient = f.client(); const first = new JobService(firstClient, { storeRoot: root });
    const job = await first.start({ prompt: "A fixture task", title: "HTTP fixture" });
    expect(job.status).toBe("accepted");
    const prompt = f.calls.find(call => call.path.endsWith("/prompt"))!;
    expect(prompt.body).toEqual({ id: job.messageId, text: "A fixture task", delivery: "queue" });
    expect(await record(job.jobId!)).toMatchObject({ receipt: { id: job.messageId, sessionID: f.sessionID } });
    // The queued entry is not a projected user message yet. This is not job failure.
    await expect(operate(firstClient, "messages.get", { sessionId: f.sessionID, messageId: job.messageId })).rejects.toMatchObject({ status: 404 });
    expect((await first.get(job.jobId!)).status).toBe("accepted");
    f.deliver(job.messageId!);
    const user = await operate(firstClient, "messages.get", { sessionId: f.sessionID, messageId: job.messageId });
    expect(user.info).toMatchObject({ id: job.messageId, role: "user" });
    expect((await first.get(job.jobId!)).status).toBe("running");
    const checkpoint = await record(job.jobId!); expect(checkpoint.observation.delivered).toBe(true); expect(checkpoint.observation.userProjectionValidated).toBe(true);
    f.finish();
    const restarted = new JobService(f.client(), { storeRoot: root }); const result = await restarted.get(job.jobId!);
    expect(result).toMatchObject({ backend: "v2", status: "completed", result: { info: { id: "msg_assistant_http", parentID: job.messageId } } });
    expect(f.calls.filter(call => call.path.endsWith("/log")).at(-1)!.query.get("after")).toBe(String(checkpoint.observation.cursor));
    expect(f.calls.filter(call => call.method === "POST" && call.path.endsWith("/prompt"))).toHaveLength(1);
  });
  it("recovers a server-admitted prompt after socket loss without resending the mutation", async () => {
    const f = await fixture(); f.loseReceipt(); const first = new JobService(f.client(), { storeRoot: root });
    const job = await first.start({ prompt: "Lost receipt fixture", sessionId: f.sessionID });
    expect(job.status).toBe("unknown"); expect((await record(job.jobId!)).receipt).toBeUndefined();
    const restarted = new JobService(f.client(), { storeRoot: root }); expect((await restarted.get(job.jobId!)).status).toBe("accepted");
    f.deliver(job.messageId!); f.finish();
    const result = await new JobService(f.client(), { storeRoot: root }).get(job.jobId!);
    expect(result).toMatchObject({ status: "completed", messageId: job.messageId });
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
  });
});
