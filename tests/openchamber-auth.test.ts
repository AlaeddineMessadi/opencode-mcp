import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { OpenCodeClient, OpenCodeError } from "../src/client.js";
import { ensureServer } from "../src/server-manager.js";
import { retryAfterMs } from "../src/auth.js";
import { registerEventTools } from "../src/tools/events.js";

const PASSWORD = "fixture-ui-password";

// Minimal OpenChamber 2.x stand-in: password login issues bearer client tokens,
// and OpenCode 2.x's /api/* routes pass through unchanged; anything else is rejected.
describe("OpenChamber authentication", () => {
  let server: Server;
  let origin: string;
  let logins: any[];
  let valid: Set<string>;
  // OpenChamber v2.4.0's actual remote-client store: minting a token for a
  // dedupeKey that already has one revokes the previous token outright
  // (see https://github.com/openchamber/openchamber/blob/v2.4.0/packages/web/
  // server/lib/client-auth/remote-clients.js#L188-L200). A fixture that only
  // adds tokens to a set (as this one used to) cannot catch a dedupeKey
  // collision between two independent clients.
  let tokenByDedupeKey: Map<string, string>;
  let issued: number;
  let loginStatus: number;
  let requests: Array<{ method: string; path: string; authorization?: string; body?: any }>;

  beforeEach(async () => {
    logins = [];
    valid = new Set();
    tokenByDedupeKey = new Map();
    issued = 0;
    loginStatus = 200;
    requests = [];
    server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const url = new URL(req.url!, "http://localhost");
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
      };
      if (url.pathname === "/auth/session" && req.method === "POST") {
        const body = JSON.parse(raw);
        logins.push(body);
        if (loginStatus === 429) return send(429, { error: "Too many login attempts" }, { "retry-after": "900" });
        if (loginStatus === 503) return send(503, { error: "Starting" });
        if (body.password !== PASSWORD) return send(401, { error: "Invalid credentials" });
        const previous = tokenByDedupeKey.get(body.dedupeKey);
        if (previous) valid.delete(previous);
        const clientToken = `oc_client_${++issued}`;
        tokenByDedupeKey.set(body.dedupeKey, clientToken);
        valid.add(clientToken);
        return send(200, { authenticated: true, clientToken, client: { id: String(issued) } });
      }
      const authorization = req.headers.authorization;
      requests.push({ method: req.method!, path: url.pathname, authorization, body: raw ? JSON.parse(raw) : undefined });
      const bearer = authorization?.match(/^Bearer (.+)$/)?.[1];
      if (!url.pathname.startsWith("/api/") || !bearer || !valid.has(bearer)) {
        return send(401, { error: "UI authentication required", locked: true });
      }
      if (url.pathname === "/api/info") return send(200, { version: "fixture", pid: 1, urls: [], paths: { tmp: "/tmp" } });
      if (url.pathname === "/api/event") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return res.end("event: ping\ndata: {}\n\n");
      }
      return send(200, { ok: true, path: url.pathname });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function openchamberClient(options: Partial<ConstructorParameters<typeof OpenCodeClient>[0]> = {}) {
    return new OpenCodeClient({ baseUrl: origin, openchamberPassword: PASSWORD, ...options });
  }

  it("signs in lazily and sends the client token as a bearer header", async () => {
    const client = openchamberClient({ username: "ignored", password: "ignored" });
    expect(logins).toHaveLength(0);
    await client.get("/api/session");
    await client.post("/api/session", { title: "x" });
    expect(logins).toHaveLength(1);
    expect(logins[0]).toMatchObject({ password: PASSWORD, issueClientToken: true, trustDevice: true, clientKind: "desktop" });
    expect(logins[0].clientLabel).toMatch(/^opencode-mcp/);
    expect(logins[0].dedupeKey).toMatch(/^opencode-mcp:/);
    expect(requests.map((r) => r.authorization)).toEqual(["Bearer oc_client_1", "Bearer oc_client_1"]);
  });

  it("signs in again once after a 401 and replays the request body", async () => {
    const client = openchamberClient();
    await client.get("/api/session");
    valid.clear(); // token expired or revoked
    const result = await client.post("/api/session", { title: "replayed" });
    expect(result).toMatchObject({ ok: true });
    expect(logins).toHaveLength(2);
    expect(requests.slice(1).map((r) => [r.authorization, r.body])).toEqual([
      ["Bearer oc_client_1", { title: "replayed" }],
      ["Bearer oc_client_2", { title: "replayed" }],
    ]);
  });

  it("shares one renewal between concurrent rejected requests", async () => {
    const client = openchamberClient();
    await client.get("/api/session");
    valid.clear();
    await Promise.all([client.get("/api/a"), client.get("/api/b"), client.get("/api/c")]);
    expect(logins).toHaveLength(2);
  });

  it("gives two independent clients distinct dedupeKeys so neither invalidates the other", async () => {
    const a = openchamberClient();
    const b = openchamberClient();
    await a.get("/api/session");
    await b.get("/api/session"); // against the real OpenChamber store, this used to revoke a's token
    expect(a).not.toBe(b);
    expect(logins).toHaveLength(2);
    expect(logins[0].dedupeKey).not.toBe(logins[1].dedupeKey);
    // a's token must still be valid: logging in as b did not evict it.
    await expect(a.get("/api/still-valid")).resolves.toMatchObject({ ok: true });
    expect(logins).toHaveLength(2);
  });

  it("renews both independent clients concurrently without a spurious 401", async () => {
    const a = openchamberClient();
    const b = openchamberClient();
    await a.get("/api/session");
    await b.get("/api/session");
    valid.clear(); // both tokens expired or were revoked out of band
    const results = await Promise.allSettled([a.get("/api/a"), b.get("/api/b")]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    // One renewal per client; neither client's renewal evicted the other's.
    expect(logins).toHaveLength(4);
  });

  it("surfaces a 401 when the renewed token is rejected too, without looping", async () => {
    const client = openchamberClient();
    await client.get("/api/session");
    valid.clear();
    const add = valid.add.bind(valid);
    valid.add = () => valid; // the server stops accepting new tokens
    await expect(client.get("/api/session")).rejects.toMatchObject({ status: 401 });
    valid.add = add;
    expect(logins).toHaveLength(2);
  });

  it("reports a rejected password without echoing it", async () => {
    const client = openchamberClient({ openchamberPassword: "wrong-secret" });
    const error = await client.get("/api/session").catch((e) => e);
    expect(String(error.message)).toContain("OPENCODE_OPENCHAMBER_PASSWORD");
    expect(String(error.message)).not.toContain("wrong-secret");
    expect(requests).toHaveLength(0);
  });

  it("reports rate limiting", async () => {
    loginStatus = 429;
    await expect(openchamberClient().get("/api/session")).rejects.toThrow(/rate limited; retry after 900s/);
  });

  describe("rejected sign-ins", () => {
    let now: number;
    beforeEach(() => {
      now = Math.floor(Date.now() / 1000) * 1000; // HTTP dates have whole seconds
      vi.spyOn(Date, "now").mockImplementation(() => now);
    });
    afterEach(() => { vi.restoreAllMocks(); });

    it("does not post a rejected password again before a restart", async () => {
      const client = openchamberClient({ openchamberPassword: "wrong-secret" });
      await expect(client.get("/api/session")).rejects.toThrow(/OPENCODE_OPENCHAMBER_PASSWORD and restart/);
      now += 24 * 60 * 60_000;
      await expect(client.get("/api/session")).rejects.toThrow(/OPENCODE_OPENCHAMBER_PASSWORD/);
      expect(logins).toHaveLength(1);
    });

    it("waits out Retry-After when rate limited, then signs in", async () => {
      loginStatus = 429;
      const client = openchamberClient();
      await expect(client.get("/api/session")).rejects.toThrow(/rate limited; retry after 900s/);
      loginStatus = 200;
      now += 899_000;
      await expect(client.get("/api/session")).rejects.toThrow(/rate limited/);
      expect(logins).toHaveLength(1);
      now += 1_001;
      await client.get("/api/session");
      expect(logins).toHaveLength(2);
    });

    it("retries straight away after a 5xx, which never reached OpenChamber's limiter", async () => {
      loginStatus = 503;
      const client = openchamberClient();
      await expect(client.get("/api/session")).rejects.toThrow(/failed \(503\)/);
      loginStatus = 200;
      await client.get("/api/session");
      expect(logins).toHaveLength(2);
    });

    it("retries straight away after a network error", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const signIns = () => fetchSpy.mock.calls.filter(([input]) => String(input).endsWith("/auth/session")).length;
      const client = openchamberClient({ openchamberUrl: "http://127.0.0.1:1" });
      await expect(client.get("/api/session")).rejects.toThrow(/OpenChamber login to .* failed/);
      const first = signIns();
      expect(first).toBeGreaterThan(0);
      await expect(client.get("/api/session")).rejects.toThrow(/OpenChamber login to .* failed/);
      expect(signIns()).toBeGreaterThan(first);
    });

    it("parses Retry-After seconds and dates, falling back to 60s", () => {
      expect(retryAfterMs("120")).toBe(120_000);
      expect(retryAfterMs(new Date(now + 300_000).toUTCString())).toBe(300_000);
      for (const value of [null, "", "0", "-5", "abc", new Date(now - 1_000).toUTCString()]) {
        expect(retryAfterMs(value)).toBe(60_000);
      }
    });
  });

  it("uses OPENCODE_OPENCHAMBER_URL for login when the API lives elsewhere", async () => {
    const client = new OpenCodeClient({ baseUrl: origin, openchamberPassword: PASSWORD, openchamberUrl: `${origin}/ignored/path` });
    await client.get("/api/session");
    expect(logins).toHaveLength(1);
  });

  it("authenticates event streams", async () => {
    const client = openchamberClient();
    // Exercise subscribeSSE the same way opencode_events_poll does.
    const events = [];
    for await (const event of client.subscribeSSE("/api/event")) events.push(event);
    expect(events).toEqual([{ event: "ping", data: "{}" }]);
    expect(requests.at(-1)?.authorization).toBe("Bearer oc_client_1");
  });

  it("authenticates the events-poll tool through OpenChamber", async () => {
    const client = openchamberClient();
    let handler: Function = () => {};
    registerEventTools({ tool: (...args: any[]) => { handler = args.at(-1); } } as any, client);
    const result = await handler({ durationMs: 200 });
    expect(result.isError).toBeFalsy();
    expect(requests.some((r) => r.path === "/api/event" && r.authorization === "Bearer oc_client_1")).toBe(true);
  });

  it("authenticates the global events-poll tool through OpenChamber", async () => {
    const client = openchamberClient();
    let handler: Function = () => {};
    registerEventTools({ tool: (...args: any[]) => { handler = args.at(-1); } } as any, client);
    const result = await handler({ durationMs: 200, scope: "global" });
    expect(result.isError).toBeFalsy();
    // OpenCode 2.x has one /api/event stream; global scope just omits the directory.
    expect(requests.some((r) => r.path === "/api/event" && r.authorization === "Bearer oc_client_1")).toBe(true);
  });

  it("authenticates the health probe", async () => {
    const client = openchamberClient();
    const status = await ensureServer({ baseUrl: origin, authorization: await client.getAuthorization() });
    expect(status).toMatchObject({ running: true, version: "fixture", managedByUs: false });
  });

  describe("static bearer token", () => {
    it("sends the token and never signs in", async () => {
      valid.add("oc_client_static");
      const client = new OpenCodeClient({ baseUrl: origin, token: "oc_client_static", password: "basic-ignored" });
      await client.get("/api/session");
      expect(requests[0].authorization).toBe("Bearer oc_client_static");
      expect(logins).toHaveLength(0);
    });

    it("does not retry a rejected static token", async () => {
      const client = new OpenCodeClient({ baseUrl: origin, token: "oc_client_revoked" });
      const error = await client.get("/api/session").catch((e) => e);
      expect(error).toBeInstanceOf(OpenCodeError);
      expect(error.status).toBe(401);
      expect(requests).toHaveLength(1);
    });
  });
});
