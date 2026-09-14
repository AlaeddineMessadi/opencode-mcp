import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { OpenCodeClient } from "../src/client.js";
import { registerWorkflowTools } from "../src/tools/workflow.js";
import { registerMessageTools } from "../src/tools/message.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Exercise the real SDK transport against HTTP, without credentials or inference.
describe("SDK HTTP integration", () => {
  let server: Server;
  let client: OpenCodeClient;
  let requests: Array<{ method: string; url: URL; headers: Record<string, unknown>; body: any }>;

  beforeEach(async () => {
    requests = [];
    server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const url = new URL(req.url!, "http://localhost");
      requests.push({ method: req.method!, url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
      if (url.pathname.endsWith("/prompt_async")) {
        res.writeHead(204).end();
      } else if (url.pathname.endsWith("/message") && req.method === "POST") {
        // Deliberately never answer the synchronous inference endpoint.
        // A regression to /message will fail the workflow test's timeout.
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(url.pathname === "/session" ? { id: "http-session" } : { ok: true }));
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

  it("serializes JSON bodies and preserves auth and remote directory scope", async () => {
    const directory = "/remote/only/project";
    await client.post("/session", { title: "HTTP fixture" }, { directory });
    await client.patch("/session/http-session", { title: "Renamed" }, directory);
    await client.put("/auth/fixture", { type: "api", key: "fixture" });
    await client.get("/session", { limit: "2" }, directory);
    await client.delete("/session/http-session", undefined, directory);
    expect(requests.map((r) => r.method)).toEqual(["POST", "PATCH", "PUT", "GET", "DELETE"]);
    expect(requests[0].body).toEqual({ title: "HTTP fixture" });
    expect(requests[1].body).toEqual({ title: "Renamed" });
    expect(requests[2].body).toEqual({ type: "api", key: "fixture" });
    expect(requests.every((r) => r.headers.authorization === "Basic " + Buffer.from("test:fixture-password").toString("base64"))).toBe(true);
    for (const index of [0, 1, 3, 4]) {
      const request = requests[index];
      expect(request.url.searchParams.get("directory") ?? request.headers["x-opencode-directory"]).toBe(directory);
    }
    expect(requests[3].url.searchParams.get("limit")).toBe("2");
  });

  it.each(["opencode_fire", "opencode_run"])("%s returns while synchronous inference is blocked", async (name) => {
    const result = await handlers(registerWorkflowTools).get(name)!({
      prompt: "Background task", providerID: "fixture", modelID: "model", variant: "high",
      directory: "/remote/project", maxDurationSeconds: 0,
    });
    expect(result.content[0].text).toContain("http-session");
    expect(requests[1].url.pathname).toBe("/session/http-session/prompt_async");
    expect(requests[1].body.variant).toBe("high");
    expect(requests[1].body.model).toEqual({ providerID: "fixture", modelID: "model" });
  }, 1500);

  it("sends slash-command model as provider/model, with a separate variant", async () => {
    await handlers(registerMessageTools).get("opencode_command_execute")!({
      sessionId: "http-session", command: "test", providerID: "fixture", modelID: "model", variant: "high",
    });
    expect(requests[0].body.model).toBe("fixture/model");
    expect(requests[0].body.variant).toBe("high");
  });
});
