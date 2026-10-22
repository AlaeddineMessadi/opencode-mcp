import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { OpenCodeClient } from "../src/client.js";
import { registerWorkflowTools } from "../src/tools/workflow.js";
import { registerMessageTools } from "../src/tools/message.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Exercise the real v2 SDK transport against an HTTP fixture that speaks the
// OpenCode 2.x `/api/*` wire format (`{ data }` envelopes), without inference.
describe("SDK HTTP integration", () => {
  let server: Server;
  let client: OpenCodeClient;
  let requests: Array<{ method: string; url: URL; headers: Record<string, unknown>; body: any }>;

  const session = (id = "http-session") => ({
    id, projectID: "dc5d1411d7913906498c7d27548dba8263847dd9", cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1792670525577, updated: 1792670525577 }, title: "HTTP fixture",
    location: { directory: "/remote/project" },
  });

  beforeEach(async () => {
    requests = [];
    server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const url = new URL(req.url!, "http://localhost");
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method!, url, headers: req.headers, body });
      const send = (payload: unknown) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(payload));
      };
      const path = url.pathname;
      if (path.endsWith("/wait")) {
        // Deliberately never answer the blocking wait endpoint. A regression
        // that waits for inference during dispatch fails the test timeout.
      } else if (path.endsWith("/model") || path.endsWith("/command")) {
        res.writeHead(204).end();
      } else if (path.endsWith("/prompt")) {
        // v2 prompts return the queued user message immediately.
        send({ data: { id: body?.id ?? "msg_1", time: { created: Date.now() }, text: body?.text, type: "user" } });
      } else if (path === "/api/session" && req.method === "POST") {
        send({ data: session() });
      } else if (path === "/api/session/active") {
        send({ data: {} });
      } else if (path.endsWith("/message")) {
        send({ data: [], cursor: { previous: null, next: null } });
      } else if (path.startsWith("/api/session/")) {
        send({ data: session(decodeURIComponent(path.split("/")[3])) });
      } else {
        send({ data: { ok: true } });
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${address.port}`, username: "test", password: "fixture-password" });
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function handlers(register: typeof registerWorkflowTools) {
    const result = new Map<string, Function>();
    register({ tool: (...args: any[]) => result.set(args[0], args.at(-1)) } as unknown as McpServer, client);
    return result;
  }

  it("serializes JSON bodies, unwraps envelopes and preserves auth and remote directory scope", async () => {
    const directory = "/remote/only/project";
    const created = await client.post("/api/session", { title: "HTTP fixture" }, { directory });
    await client.patch("/api/session/http-session", { title: "Renamed" }, directory);
    await client.put("/api/session/http-session/environment", { variables: { FIXTURE: "1" } });
    await client.get("/api/session/active", { limit: "2" }, directory);
    await client.delete("/api/session/http-session", undefined, directory);
    expect(created).toEqual(session());
    expect(requests.map((r) => r.method)).toEqual(["POST", "PATCH", "PUT", "GET", "DELETE"]);
    expect(requests[0].body).toEqual({ title: "HTTP fixture" });
    expect(requests[1].body).toEqual({ title: "Renamed" });
    expect(requests[2].body).toEqual({ variables: { FIXTURE: "1" } });
    expect(requests.every((r) => r.headers.authorization === "Basic " + Buffer.from("test:fixture-password").toString("base64"))).toBe(true);
    for (const index of [0, 1, 3, 4]) {
      const request = requests[index];
      expect(request.url.searchParams.get("directory") ?? request.headers["x-opencode-directory"]).toBe(directory);
    }
    expect(requests[2].headers["x-opencode-directory"]).toBeUndefined();
    expect(requests[3].url.searchParams.get("limit")).toBe("2");
  });

  it.each(["opencode_fire", "opencode_run"])("%s returns without waiting for inference", async (name) => {
    const result = await handlers(registerWorkflowTools).get(name)!({
      prompt: "Background task", providerID: "fixture", modelID: "model", variant: "high",
      directory: "/remote/project", maxDurationSeconds: 0,
    });
    expect(result.content[0].text).toContain("http-session");
    expect(requests.some((r) => r.url.pathname.endsWith("/wait"))).toBe(false);
    // v2: the session is created with its model and location...
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url.pathname).toBe("/api/session");
    expect(requests[0].body).toMatchObject({
      model: { id: "model", providerID: "fixture", variant: "high" },
      location: { directory: "/remote/project" },
    });
    // ...and the prompt carries only the pre-assigned message ID and text.
    expect(requests[1].url.pathname).toBe("/api/session/http-session/prompt");
    expect(requests[1].body).toEqual({ id: expect.stringMatching(/^msg_/), text: "Background task" });
  }, 1500);

  it("switches the model on an existing session before prompting", async () => {
    await handlers(registerWorkflowTools).get("opencode_fire")!({
      prompt: "Follow up", sessionId: "ses_existing", providerID: "fixture", modelID: "model", variant: "high",
    });
    expect(requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "POST /api/session/ses_existing/model",
      "POST /api/session/ses_existing/prompt",
    ]);
    expect(requests[0].body).toEqual({ model: { id: "model", providerID: "fixture", variant: "high" } });
    expect(requests[1].body).not.toHaveProperty("model");
  });

  it("sends slash commands as {name, text} to the v2 command endpoint", async () => {
    await handlers(registerMessageTools).get("opencode_command_execute")!({
      sessionId: "http-session", command: "review", arguments: "src/client.ts",
    });
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url.pathname).toBe("/api/session/http-session/command");
    expect(requests[0].body).toEqual({ name: "review", text: "src/client.ts" });
  });

  it("sends an empty text for slash commands without arguments (text is required by the spec)", async () => {
    await handlers(registerMessageTools).get("opencode_command_execute")!({ sessionId: "http-session", command: "init" });
    expect(requests[0].body).toEqual({ name: "init", text: "" });
  });
});
