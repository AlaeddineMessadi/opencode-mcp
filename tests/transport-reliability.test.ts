import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { OpenCodeClient, OpenCodeError, OpenCodeSubmissionError } from "../src/client.js";
import { abortableSleep, createRequestContext } from "../src/async.js";
import { registerEventTools } from "../src/tools/events.js";

const servers: Server[] = [];
async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return new OpenCodeClient({ baseUrl: `http://127.0.0.1:${port}` });
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("bounded HTTP requests and safe retries", () => {
  it.each(["post", "patch", "put", "delete"] as const)("does not replay %s after accepted request loses response", async (method) => {
    let accepted = 0;
    const client = await fixture((request) => {
      request.resume();
      request.on("end", () => { accepted++; request.socket.destroy(); });
    });
    await expect(client[method]("/session/fixture")).rejects.toMatchObject({
      name: "OpenCodeSubmissionError", submissionOutcome: "unknown", method: method.toUpperCase(), path: "/session/fixture",
    });
    expect(accepted).toBe(1);
  });

  it("does not retry a mutation receiving a transient rejection", async () => {
    let attempts = 0;
    const client = await fixture((_req, res) => {
      attempts++;
      res.writeHead(503, { "content-type": "application/json" }).end('{"error":"temporarily unavailable"}');
    });
    await expect(client.post("/session")).rejects.toBeInstanceOf(OpenCodeError);
    expect(attempts).toBe(1);
  });

  it("retries a safe read after response loss", async () => {
    let attempts = 0;
    const client = await fixture((req, res) => {
      if (++attempts === 1) { req.socket.destroy(); return; }
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    });
    await expect(client.get("/session/status")).resolves.toEqual({ ok: true });
    expect(attempts).toBe(2);
  });

  it("retries transient read HTTP statuses", async () => {
    let attempts = 0;
    const client = await fixture((_req, res) => {
      const status = ++attempts === 1 ? 503 : 200;
      res.writeHead(status, { "content-type": "application/json" }).end('{"ok":true}');
    });
    await expect(client.get("/session/status")).resolves.toEqual({ ok: true });
    expect(attempts).toBe(2);
  });

  it("cancels retry backoff without submitting another request", async () => {
    let attempts = 0;
    const controller = new AbortController();
    const client = await fixture((_req, res) => {
      attempts++;
      res.writeHead(503, { "content-type": "application/json" }).end('{}');
      setTimeout(() => controller.abort(), 40);
    });
    await expect(client.get("/session/status", undefined, undefined, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(attempts).toBe(1);
  });

  it.each(["get", "post", "patch", "put", "delete"] as const)("bounds stalled %s requests by the shared deadline", async (method) => {
    let attempts = 0;
    const client = await fixture((req) => { attempts++; req.resume(); });
    const options = { deadline: Date.now() + 100 };
    const started = Date.now();
    const request = method === "post" ? client.post("/session", {}, options)
      : client[method]("/session", undefined, undefined, options);
    await expect(request).rejects.toSatisfy((error: Error) =>
      method === "get" ? error.name === "TimeoutError" : error instanceof OpenCodeSubmissionError && (error.cause as Error).name === "TimeoutError");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(attempts).toBe(1);
  });

  it("does not send an already-cancelled mutation", async () => {
    let attempts = 0;
    const client = await fixture((_req, res) => { attempts++; res.end(); });
    const controller = new AbortController();
    controller.abort();
    await expect(client.post("/session", {}, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(attempts).toBe(0);
  });

  it("shares one deadline across retries rather than refreshing the timeout", async () => {
    let attempts = 0;
    const client = await fixture((_req, res) => {
      attempts++;
      res.writeHead(503, { "content-type": "application/json" }).end('{}');
    });
    const started = Date.now();
    await expect(client.get("/session/status", undefined, undefined, { timeout: 200 })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(attempts).toBe(1);
  });

  it("cancels operation sleeps", async () => {
    const context = createRequestContext({ timeout: 20 });
    try { await expect(abortableSleep(10_000, context.signal)).rejects.toMatchObject({ name: "TimeoutError" }); }
    finally { context.dispose(); }
  });
});

describe("SSE lifetime and framing", () => {
  it("cancels the HTTP stream when the consumer stops after one event", async () => {
    let closed!: () => void;
    const didClose = new Promise<void>((resolve) => { closed = resolve; });
    let directory: string | undefined;
    const client = await fixture((req, res) => {
      directory = req.headers["x-opencode-directory"] as string;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: first\n\n');
      res.on("close", closed);
    });
    for await (const event of client.subscribeSSE("/event", { directory: "/remote/project" })) {
      expect(event.data).toBe("first");
      break;
    }
    await didClose;
    expect(directory).toBe("/remote/project");
  });

  it("preserves multiline/empty data, leading whitespace and split CRLF framing", async () => {
    const chunks = ["event: ready\r", "\ndata:  first  \r\ndata: second\r\n\r", "\ndata:\r\r", "data: unfinished"];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({
      start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); },
    })));
    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    const events = [];
    for await (const event of client.subscribeSSE("/event")) events.push(event);
    expect(events).toEqual([{ event: "ready", data: " first  \nsecond" }, { event: "message", data: "" }]);
  });

  it("bounds a stream that never sends data", async () => {
    const client = await fixture((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
    });
    await expect((async () => {
      for await (const _ of client.subscribeSSE("/event", { timeout: 30 })) { /* no data */ }
    })()).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

function eventHandler(client: OpenCodeClient) {
  let handler: Function = () => {};
  registerEventTools({ tool: (...args: any[]) => { handler = args.at(-1); } } as any, client);
  return handler;
}

describe("event polling results", () => {
  it("reports authentication errors instead of an empty success", async () => {
    const client = await fixture((_req, res) => res.writeHead(401).end("fixture unauthorized"));
    const result = await eventHandler(client)({ durationMs: 200 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("401");
  });

  it("returns partial events alongside connection errors", async () => {
    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    vi.spyOn(client, "subscribeSSE").mockImplementation(async function* () {
      yield { event: "message", data: '{"type":"session.busy"}' };
      throw new Error("connection lost");
    });
    const result = await eventHandler(client)({ durationMs: 200 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.partial).toBe(true);
    expect(result.structuredContent.events).toHaveLength(1);
    expect(result.content.map((item: any) => item.text).join(" ")).toContain("connection lost");
  });

  it("treats only the local polling deadline as an empty observation", async () => {
    const client = await fixture((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); });
    const result = await eventHandler(client)({ durationMs: 30 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.events).toEqual([]);
    expect(result.structuredContent.partial).toBe(false);
  });

  it("recognizes an inner timeout at the shared deadline before the outer timer fires", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    vi.spyOn(client, "subscribeSSE").mockImplementation(async function* (_path, options) {
      now.mockReturnValue(options!.deadline!);
      throw new DOMException("Inner deadline expired", "TimeoutError");
    });
    const result = await eventHandler(client)({ durationMs: 200 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.partial).toBe(false);
  });

  it("does not swallow an early upstream TimeoutError", async () => {
    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    vi.spyOn(client, "subscribeSSE").mockImplementation(async function* () {
      throw new DOMException("Upstream operation timed out", "TimeoutError");
    });
    expect((await eventHandler(client)({ durationMs: 2000 })).isError).toBe(true);
  });

  it("keeps caller cancellation visible", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    const result = await eventHandler(client)({ durationMs: 200 }, { signal: controller.signal });
    expect(result.isError).toBe(true);
  });

  it("supports explicit global scope and rejects a misleading project directory", async () => {
    let path = "";
    const client = await fixture((req, res) => { path = req.url!; res.writeHead(200, { "content-type": "text/event-stream" }).end('data: {}\n\n'); });
    const handler = eventHandler(client);
    expect((await handler({ scope: "global" })).isError).not.toBe(true);
    expect(path).toBe("/global/event");
    expect((await handler({ scope: "global", directory: "/project" })).isError).toBe(true);
  });
});
