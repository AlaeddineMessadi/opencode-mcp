import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Mock the server-manager module so reconnect-path tests don't try to boot
 * a real OpenCode server. The `vi.hoisted` block keeps the mock references
 * accessible from both the (hoisted) `vi.mock` factory and the test body.
 */
const { isServerRunningMock, ensureServerMock } = vi.hoisted(() => ({
  isServerRunningMock: vi.fn(),
  ensureServerMock: vi.fn(),
}));
vi.mock("../src/server-manager.js", () => ({
  isServerRunning: isServerRunningMock,
  ensureServer: ensureServerMock,
}));

/**
 * Mock `@opencode-ai/sdk/v2/client` so every call to `createOpencodeClient`
 * (both the one in the `OpenCodeClient` constructor and the one issued by
 * `buildSdkClient` during reconnect) returns the next queued factory output.
 * Every call is recorded with its options, so tests can observe the URL and
 * Authorization header each rebuilt SDK client targets.
 */
const sdkClientFactory = vi.hoisted(() => {
  type Opts = { baseUrl: string; headers?: Record<string, string> };
  const factories: Array<(opts: Opts) => unknown> = [];
  const created: Opts[] = [];
  return {
    factories,
    created,
    create: (opts: Opts) => {
      created.push(opts);
      const factory = factories.shift() ?? (() => ({ client: {} }));
      return factory(opts);
    },
  };
});
vi.mock("@opencode-ai/sdk/v2/client", () => ({
  createOpencodeClient: sdkClientFactory.create,
  OpencodeClient: vi.fn(),
}));

import { OpenCodeClient, OpenCodeError, OpenCodeSubmissionError } from "../src/client.js";
import { normalizeDirectory } from "../src/helpers.js";

/**
 * Client tests.
 *
 * `OpenCodeClient.request()` dispatches through `(this.api as any).client`
 * (the v2 SDK's internal HTTP client). Tests stub that object to observe
 * request shapes without a server; end-to-end HTTP behaviour lives in
 * tests/transport-reliability.test.ts and tests/http-integration.test.ts.
 */

// ─── OpenCodeError ───────────────────────────────────────────────────────

describe("OpenCodeError", () => {
  it("creates error with all fields", () => {
    const err = new OpenCodeError("fail", 500, "GET", "/test", "body");
    expect(err.message).toBe("fail");
    expect(err.status).toBe(500);
    expect(err.method).toBe("GET");
    expect(err.path).toBe("/test");
    expect(err.body).toBe("body");
    expect(err.name).toBe("OpenCodeError");
  });

  describe("isTransient", () => {
    it.each([429, 502, 503, 504])("returns true for status %i", (status) => {
      const err = new OpenCodeError("", status, "", "", "");
      expect(err.isTransient).toBe(true);
    });

    it.each([400, 401, 403, 404, 500])("returns false for status %i", (status) => {
      const err = new OpenCodeError("", status, "", "", "");
      expect(err.isTransient).toBe(false);
    });
  });

  describe("isNotFound", () => {
    it("returns true for 404", () => {
      const err = new OpenCodeError("", 404, "", "", "");
      expect(err.isNotFound).toBe(true);
    });

    it("returns false for other statuses", () => {
      const err = new OpenCodeError("", 500, "", "", "");
      expect(err.isNotFound).toBe(false);
    });
  });

  describe("isAuth", () => {
    it.each([401, 403])("returns true for status %i", (status) => {
      const err = new OpenCodeError("", status, "", "", "");
      expect(err.isAuth).toBe(true);
    });

    it("returns false for other statuses", () => {
      const err = new OpenCodeError("", 500, "", "", "");
      expect(err.isAuth).toBe(false);
    });
  });
});

// ─── OpenCodeClient construction ─────────────────────────────────────────

describe("OpenCodeClient", () => {
  describe("constructor", () => {
    it("preserves trailing slash from baseUrl", () => {
      const client = new OpenCodeClient({ baseUrl: "http://localhost:4096/" });
      expect(client.getBaseUrl()).toBe("http://localhost:4096");
    });

    it("preserves baseUrl without trailing slash", () => {
      const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
      expect(client.getBaseUrl()).toBe("http://localhost:4096");
    });

    it("exposes the underlying SDK client via `api`", () => {
      const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
      expect(client.api).toBeDefined();
    });
  });

  describe("autoServe option", () => {
    it("defaults autoServe to false", () => {
      const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
      expect(client.getBaseUrl()).toBe("http://localhost:4096");
    });

    it("accepts autoServe option in constructor", () => {
      const client = new OpenCodeClient({
        baseUrl: "http://localhost:4096",
        autoServe: true,
      });
      expect(client.getBaseUrl()).toBe("http://localhost:4096");
    });
  });

  describe("auth credentials", () => {
    it("constructs without auth when neither username nor password is provided", () => {
      expect(
        () => new OpenCodeClient({ baseUrl: "http://localhost:4096" }),
      ).not.toThrow();
    });

    it("constructs with password-only auth (default username 'opencode')", () => {
      expect(
        () =>
          new OpenCodeClient({
            baseUrl: "http://localhost:4096",
            password: "secret",
          }),
      ).not.toThrow();
    });

    it("constructs with username+password auth", () => {
      expect(
        () =>
          new OpenCodeClient({
            baseUrl: "http://localhost:4096",
            username: "admin",
            password: "secret",
          }),
      ).not.toThrow();
    });
  });
});

// ─── normalizeDirectory (used by every dispatch path) ────────────────────

describe("normalizeDirectory", () => {
  it("returns undefined when input is undefined", () => {
    expect(normalizeDirectory(undefined)).toBeUndefined();
  });

  it("returns absolute path unchanged when it exists", () => {
    expect(normalizeDirectory("/tmp")).toBe("/tmp");
  });

  it("preserves trailing slash", () => {
    expect(normalizeDirectory("/tmp/")).toBe("/tmp/");
  });

  it("preserves '..' segments", () => {
    expect(normalizeDirectory("/tmp/foo/..")).toBe("/tmp/foo/..");
  });

  it("accepts a remote directory without checking the local disk", () => {
    expect(normalizeDirectory("/this/absolutely/does/not/exist/xyz123"))
      .toBe("/this/absolutely/does/not/exist/xyz123");
  });
});

// ─── x-opencode-directory header (regression: must NOT be URI-encoded) ───

describe("x-opencode-directory header", () => {
  /**
   * Regression test for the bug where directory paths like `/tmp/proj` were
   * URI-encoded to `%2Ftmp%2Fproj` before being placed in the header. The
   * OpenCode server treats the header value as a literal absolute filesystem
   * path, so encoding broke project scoping for every tool that accepts a
   * `directory` argument.
   */
  it("sends the raw normalized path (no URI encoding)", async () => {
    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];

    // Stub the SDK's internal HTTP client. The production code reaches into
    // `(this.api as any).client` — we replace it so we can inspect what
    // headers actually get sent without standing up a real server.
    (client.api as unknown as { client: unknown }).client = {
      get: async (opts: { url: string; headers: Record<string, string> }) => {
        calls.push({ url: opts.url, headers: opts.headers });
        return { data: {}, error: undefined, response: { status: 200 } };
      },
    };

    await client.get("/api/location", undefined, "/tmp");

    expect(calls).toHaveLength(1);
    expect(calls[0].headers["x-opencode-directory"]).toBe("/tmp");
    // Explicit guard against the regressed behaviour:
    expect(calls[0].headers["x-opencode-directory"]).not.toContain("%2F");
  });

  it("omits the header when no directory is provided", async () => {
    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];

    (client.api as unknown as { client: unknown }).client = {
      get: async (opts: { url: string; headers: Record<string, string> }) => {
        calls.push({ url: opts.url, headers: opts.headers });
        return { data: {}, error: undefined, response: { status: 200 } };
      },
    };

    await client.get("/api/location");

    expect(calls[0].headers["x-opencode-directory"]).toBeUndefined();
  });
});

// ─── Response handling: v2 envelopes and error mapping ───────────────────

describe("v2 response handling", () => {
  /** Stub the SDK transport to answer every verb with a canned result. */
  function clientReturning(result: { data?: unknown; error?: unknown; response?: { ok: boolean; status: number } }) {
    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    const respond = async () => ({ request: {}, ...result });
    (client.api as unknown as { client: unknown }).client = { get: respond, post: respond, patch: respond, put: respond, delete: respond };
    return client;
  }
  const ok = { ok: true, status: 200 };
  const session = { id: "ses_e9c829796ffe2F5R738qhSlPwh", title: "Ping", location: { directory: "/repo" } };

  it("unwraps a {data} envelope on /api/* paths", async () => {
    const client = clientReturning({ data: { data: session }, response: ok });
    await expect(client.get("/api/session/ses_e9c829796ffe2F5R738qhSlPwh")).resolves.toEqual(session);
  });

  it("unwraps a location-scoped {data, location} envelope", async () => {
    const client = clientReturning({ data: { data: [{ name: "build" }], location: { directory: "/repo" } }, response: ok });
    await expect(client.get("/api/agent")).resolves.toEqual([{ name: "build" }]);
  });

  it("unwraps envelopes on writes too", async () => {
    const client = clientReturning({ data: { data: session }, response: ok });
    await expect(client.post("/api/session", { title: "Ping" })).resolves.toEqual(session);
  });

  it("passes through un-enveloped 2.x bodies such as /api/info", async () => {
    const info = { version: "2.1.2", pid: 1, urls: ["http://127.0.0.1:4096"], paths: { tmp: "/tmp" } };
    const client = clientReturning({ data: info, response: ok });
    await expect(client.get("/api/info")).resolves.toEqual(info);
  });

  it("does not unwrap objects that merely contain a data key among others", async () => {
    const body = { data: "x", other: 1 };
    const client = clientReturning({ data: body, response: ok });
    await expect(client.get("/api/fixture")).resolves.toEqual(body);
  });

  it("does not unwrap raw file reads that happen to look like an envelope", async () => {
    const file = { data: { nested: true } };
    const client = clientReturning({ data: file, response: ok });
    await expect(client.get("/api/fs/read/config.json")).resolves.toEqual(file);
  });

  it("does not unwrap non-/api paths", async () => {
    const client = clientReturning({ data: { data: 1 }, response: ok });
    await expect(client.get("/doc")).resolves.toEqual({ data: 1 });
  });

  it("passes through arrays, empty bodies and 204 responses", async () => {
    await expect(clientReturning({ data: [1, 2], response: ok }).get("/api/fixture")).resolves.toEqual([1, 2]);
    await expect(clientReturning({ data: {}, response: { ok: true, status: 204 } }).post("/api/session/x/model", {})).resolves.toEqual({});
  });

  it("unwraps paginated {data, cursor} list envelopes to the item array", async () => {
    // GET /api/session and GET /api/session/{id}/message (OpenAPI 2.1.2, live server).
    const cursor = { previous: "eyJhbmNob3IiOnt9fQ", next: null };
    const client = clientReturning({ data: { data: [session], cursor }, response: ok });
    await expect(client.get("/api/session", { limit: "1" })).resolves.toEqual([session]);
  });

  it("maps a v2 error response to OpenCodeError with the encoded error body", async () => {
    const error = { _tag: "SessionNotFoundError", sessionID: "ses_missing", message: "Session not found" };
    const client = clientReturning({ error, response: { ok: false, status: 404 } });
    const failure = await client.get("/api/session/ses_missing").catch((e) => e);
    expect(failure).toBeInstanceOf(OpenCodeError);
    expect(failure).toMatchObject({ status: 404, method: "GET", path: "/api/session/ses_missing", isNotFound: true });
    expect(JSON.parse(failure.body)).toEqual(error);
  });

  it("flags 401 UnauthorizedError as an auth error", async () => {
    const client = clientReturning({ error: { _tag: "UnauthorizedError", message: "Authentication required" }, response: { ok: false, status: 401 } });
    await expect(client.get("/api/session")).rejects.toMatchObject({ name: "OpenCodeError", status: 401, isAuth: true });
  });

  it("treats an SDK error without a response as a lost submission for writes", async () => {
    const client = clientReturning({ error: new TypeError("fetch failed") });
    await expect(client.post("/api/session/x/prompt", { text: "hi" })).rejects.toBeInstanceOf(OpenCodeSubmissionError);
  });
});

// ─── Reconnect path: URL rebinding + reconnectAttempts reset ─────────────

describe("reconnect path", () => {
  beforeEach(() => {
    isServerRunningMock.mockReset();
    ensureServerMock.mockReset();
    sdkClientFactory.factories.length = 0;
    sdkClientFactory.created.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Queue SDK-client factories such that every produced `client` shares
   * the same call-counter closure. The retry loop in `client.ts` runs
   * `MAX_RETRIES + 1` = 3 attempts before falling through to the reconnect
   * branch; tests exercising reconnect need at least 3 failures + 1 success.
   *
   * Each call records the `baseUrl` the factory was called with, so tests
   * can assert that the retry issued after `ensureServer()` targets the
   * rebound URL.
   */
  const MAX_RETRIES_PLUS_ONE = 3;
  type Verb = "get" | "post" | "patch" | "put" | "delete";
  function queueFlakySdkClients(
    factoryCount: number,
  ): Array<{ baseUrl: string; method: Verb }> {
    const calls: Array<{ baseUrl: string; method: Verb }> = [];
    let count = 0;
    for (let i = 0; i < factoryCount; i++) {
      sdkClientFactory.factories.push((opts: { baseUrl: string }) => {
        const verb = (method: Verb) => async () => {
          count++;
          calls.push({ baseUrl: opts.baseUrl, method });
          if (count <= MAX_RETRIES_PLUS_ONE) {
            // The v2 SDK returns transport failures as `{ error }` with no response.
            return { error: new TypeError("fetch failed"), request: {}, response: undefined };
          }
          return {
            data: { data: { ok: true } },
            error: undefined,
            response: { ok: true, status: 200 },
          };
        };
        return { client: { get: verb("get"), post: verb("post"), patch: verb("patch"), put: verb("put"), delete: verb("delete") } };
      });
    }
    return calls;
  }

  it("rebuilds the SDK client when ensureServer returns a different url", async () => {
    // Two factories: one for the constructor, one for the post-reconnect
    // rebuild. Both share the same call-counter closure, so the 4th call
    // (the retry triggered after reconnect) succeeds.
    const calls = queueFlakySdkClients(2);

    const client = new OpenCodeClient({
      baseUrl: "http://localhost:4096",
      autoServe: true,
    });
    const originalApi = client.api;

    isServerRunningMock.mockResolvedValueOnce({ healthy: false });
    ensureServerMock.mockResolvedValueOnce({
      running: true,
      version: "2.1.2",
      managedByUs: true,
      url: "http://localhost:5000",
    });

    await expect(client.get("/api/info")).resolves.toEqual({ ok: true });

    expect(ensureServerMock).toHaveBeenCalledOnce();
    expect(client.getBaseUrl()).toBe("http://localhost:5000");
    // First 3 calls (the initial retry loop) target the original URL;
    // the 4th call — the retry triggered by the reconnect branch — must
    // observe the rebound baseUrl.
    expect(calls).toHaveLength(4);
    expect(calls[0].baseUrl).toBe("http://localhost:4096");
    expect(calls[calls.length - 1].baseUrl).toBe("http://localhost:5000");
    // SDK client should be re-instantiated when the URL changes.
    expect(client.api).not.toBe(originalApi);
  });

  it("keeps the base URL when ensureServer returns the same url", async () => {
    const calls = queueFlakySdkClients(2);

    const client = new OpenCodeClient({
      baseUrl: "http://localhost:4096",
      autoServe: true,
    });

    isServerRunningMock.mockResolvedValueOnce({ healthy: false });
    ensureServerMock.mockResolvedValueOnce({
      running: true,
      version: "2.1.2",
      managedByUs: true,
      url: "http://localhost:4096/",
    });

    await expect(client.get("/api/info")).resolves.toEqual({ ok: true });

    expect(client.getBaseUrl()).toBe("http://localhost:4096");
    expect(calls.every((call) => call.baseUrl === "http://localhost:4096")).toBe(true);
  });

  it("adopts the password generated for an auto-started server", async () => {
    queueFlakySdkClients(2);
    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096", username: "opencode", password: "stale", autoServe: true });

    isServerRunningMock.mockResolvedValueOnce({ healthy: false });
    ensureServerMock.mockResolvedValueOnce({
      running: true, version: "2.1.2", managedByUs: true, url: "http://localhost:4096", password: "generated-pw",
    });

    await client.get("/api/info");

    // The probe and ensureServer are called with the credentials held at the time.
    expect(isServerRunningMock).toHaveBeenCalledWith("http://localhost:4096", "opencode", "stale");
    expect(ensureServerMock).toHaveBeenCalledWith(expect.objectContaining({ autoServe: true, password: "stale" }));
    // The rebuilt SDK client authenticates with the new password...
    expect(sdkClientFactory.created.at(-1)!.headers).toEqual({ Authorization: "Basic " + Buffer.from("opencode:generated-pw").toString("base64") });

    // ...and so does the raw SSE path, which builds its own header.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("data: {}\n\n", { status: 200 }));
    for await (const _ of client.subscribeSSE("/api/event")) break;
    expect((fetchSpy.mock.calls[0][1]!.headers as Record<string, string>).Authorization)
      .toBe("Basic " + Buffer.from("opencode:generated-pw").toString("base64"));
  });

  it("does not call ensureServer when the server is reachable again", async () => {
    queueFlakySdkClients(1);
    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096", autoServe: true });
    isServerRunningMock.mockResolvedValueOnce({ healthy: true, version: "2.1.2" });
    await expect(client.get("/api/info")).resolves.toEqual({ ok: true });
    expect(ensureServerMock).not.toHaveBeenCalled();
  });

  it("does not reconnect when autoServe is disabled", async () => {
    queueFlakySdkClients(1);
    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    await expect(client.get("/api/info")).rejects.toThrow("fetch failed");
    expect(isServerRunningMock).not.toHaveBeenCalled();
    expect(ensureServerMock).not.toHaveBeenCalled();
  }, 5000);

  it.each(["post", "patch", "put", "delete"] as const)("never reconnects and replays a %s whose submission was lost", async (method) => {
    const calls = queueFlakySdkClients(2);
    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096", autoServe: true });
    isServerRunningMock.mockResolvedValue({ healthy: false });
    ensureServerMock.mockResolvedValue({ running: true, managedByUs: true, url: "http://localhost:4096" });

    const request = method === "post" ? client.post("/api/session/x/prompt", { text: "hi" })
      : client[method]("/api/session/x", undefined);
    await expect(request).rejects.toMatchObject({ name: "OpenCodeSubmissionError", submissionOutcome: "unknown" });
    expect(calls).toHaveLength(1);
    expect(isServerRunningMock).not.toHaveBeenCalled();
    expect(ensureServerMock).not.toHaveBeenCalled();
  });

  it("resets reconnectAttempts after a successful request", async () => {
    const client = new OpenCodeClient({
      baseUrl: "http://localhost:4096",
      autoServe: true,
    });

    // 4 round-trips, each: 3 failures → reconnect (healthy probe) → success.
    for (let i = 0; i < 4; i++) {
      queueFlakySdkClients(1);
      // Replace the SDK client's `client` with the freshly-queued factory's
      // output so the next request hits a fresh 3-fail-then-succeed cycle.
      const factory = sdkClientFactory.factories.shift();
      if (factory) {
        const fresh = factory({ baseUrl: client.getBaseUrl() }) as { client: unknown };
        (client.api as unknown as { client: unknown }).client = fresh.client;
      }
      isServerRunningMock.mockResolvedValueOnce({ healthy: true, version: "2.1.2" });
      await client.get("/api/info");
    }

    // All 4 requests should have invoked the reconnect path. If
    // reconnectAttempts had monotonically grown (the bug), the cap of 3
    // would have been hit on the 4th request and the reconnect branch
    // would have been skipped → only 3 probes.
    expect(isServerRunningMock).toHaveBeenCalledTimes(4);
  });
});

// ─── SSE line-ending handling ────────────────────────────────────────────

describe("subscribeSSE", () => {
  /**
   * Build a `ReadableStream<Uint8Array>` from a single string. Used to
   * drive `subscribeSSE` without standing up an HTTP server.
   */
  function streamFrom(body: string): ReadableStream<Uint8Array> {
    const encoded = new TextEncoder().encode(body);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    });
  }

  /** Drive a fake `fetch` so `subscribeSSE` consumes our scripted body. */
  function installFakeFetch(body: string) {
    return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: streamFrom(body),
      text: async () => "",
    } as unknown as Response);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Regression: the SSE parser used to `split("\n")`, which left a
   * trailing `\r` on every line when servers emit `\r\n` (RFC 8895
   * permits CRLF). That broke the event name (`"message\r"` instead of
   * `"message"`) and the blank-line dispatcher (`"\r" !== ""`).
   */
  it("parses events when the server uses CRLF line endings", async () => {
    const body =
      "event: ready\r\n" +
      "data: hello\r\n" +
      "\r\n" +
      "event: chunk\r\n" +
      "data: world\r\n" +
      "\r\n";
    installFakeFetch(body);

    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    const events: Array<{ event: string; data: string }> = [];
    for await (const e of client.subscribeSSE("/events")) {
      events.push(e);
    }

    expect(events).toEqual([
      { event: "ready", data: "hello" },
      { event: "chunk", data: "world" },
    ]);
  });

  it("still parses events when the server uses LF line endings", async () => {
    const body = "event: ready\ndata: hello\n\n";
    installFakeFetch(body);

    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    const events: Array<{ event: string; data: string }> = [];
    for await (const e of client.subscribeSSE("/events")) {
      events.push(e);
    }

    expect(events).toEqual([{ event: "ready", data: "hello" }]);
  });

  /**
   * OpenCode 2.x `/api/event` wire format, captured from a live 2.1.2 server:
   * no `event:` lines, the event name lives in the JSON `type` field, and
   * heartbeats are SSE comments.
   */
  it("names v2 events after their JSON type and skips heartbeat comments", async () => {
    const connected = '{"id":"evt_16392e314001cjTQrygGeKUSCv","type":"server.connected","data":{}}';
    const busy = '{"id":"evt_2","type":"session.status","data":{"sessionID":"ses_1","status":{"type":"busy"}}}';
    installFakeFetch(`data: ${connected}\n\n: heartbeat\n\ndata: ${busy}\n\n`);

    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    const events: Array<{ event: string; data: string }> = [];
    for await (const e of client.subscribeSSE("/api/event")) events.push(e);

    expect(events).toEqual([
      { event: "server.connected", data: connected },
      { event: "session.status", data: busy },
    ]);
  });

  it("prefers an explicit event line and falls back to 'message' for untyped data", async () => {
    installFakeFetch('event: custom\ndata: {"type":"ignored"}\n\ndata: not json\n\ndata: {"type":42}\n\n');
    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    const events: Array<{ event: string; data: string }> = [];
    for await (const e of client.subscribeSSE("/api/event")) events.push(e);
    expect(events.map((e) => e.event)).toEqual(["custom", "message", "message"]);
  });

  it("sends Basic auth, the directory header and SSE accept headers", async () => {
    const fetchSpy = installFakeFetch("");
    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096", password: "pw" });
    for await (const _ of client.subscribeSSE("/api/event", { directory: "/repo" })) { /* drain */ }
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://localhost:4096/api/event");
    expect(init!.headers).toEqual({
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      "x-opencode-directory": "/repo",
      Authorization: "Basic " + Buffer.from("opencode:pw").toString("base64"),
    });
  });

  it("surfaces a 401 as an auth OpenCodeError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response('{"_tag":"UnauthorizedError","message":"Authentication required"}', { status: 401 }));
    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    await expect((async () => { for await (const _ of client.subscribeSSE("/api/event")) { /* none */ } })())
      .rejects.toMatchObject({ name: "OpenCodeError", status: 401, isAuth: true, path: "/api/event" });
  });
});
