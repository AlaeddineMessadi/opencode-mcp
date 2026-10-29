import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

/**
 * Server manager tests (OpenCode 2.x).
 *
 * `startServer` spawns `opencode serve` itself with a generated
 * `OPENCODE_SERVER_PASSWORD`, waits for the `server listening on <url>` line,
 * then probes `GET /api/info` with Basic auth (user `opencode`). These tests
 * mock `node:child_process.spawn` and `fetch`, so no real server is started.
 */

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import {
  isServerRunning,
  startServer,
  stopServer,
  ensureServer,
  registerShutdownHandlers,
  resetShutdownRegisteredForTests,
} from "../src/server-manager.js";

// ─── Fixtures ────────────────────────────────────────────────────────────

/** `GET /api/info` body as served by OpenCode 2.1.2 (ServerInfo schema). */
function serverInfo(version = "2.1.2", url = "http://127.0.0.1:4096") {
  return { version, pid: 4242, urls: [url], paths: { tmp: "/tmp/opencode" }, capabilities: { persistentPty: true } };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Real 2.x 401 body for a missing or wrong password. */
const unauthorized = () => json({ _tag: "UnauthorizedError", message: "Authentication required" }, 401);
/** OpenCode 2.x serves its web UI for unknown non-API paths such as `/global/health`. */
const spaFallback = () => new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } });
/** OpenCode 1.x `/global/health`. */
const legacyHealth = () => json({ healthy: true, version: "1.14.46" });
const refused = () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: new Error("connect ECONNREFUSED 127.0.0.1:4096") }));

const basic = (user: string, password: string) => "Basic " + Buffer.from(`${user}:${password}`).toString("base64");

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill = vi.fn(() => { this.killed = true; return true; });
}

interface Spawned { proc: FakeProcess; password: string; url: string; args: string[]; options: any }
let spawned: Spawned[];

/**
 * Make `spawn("opencode", ...)` return a fake process. By default it prints
 * the 2.x startup line for the requested host/port on the next tick and then
 * answers `/api/info` (only with the generated password) via the fetch router.
 */
function fakeOpencode(behaviour: { lines?: string[]; listen?: boolean; exitCode?: number; error?: Error } = {}) {
  spawnMock.mockImplementation((_command: string, args: string[], options: any) => {
    const proc = new FakeProcess();
    const host = args.find((a) => a.startsWith("--hostname="))!.split("=")[1];
    const port = args.find((a) => a.startsWith("--port="))!.split("=")[1];
    const url = `http://${host}:${port}`;
    spawned.push({ proc, password: options.env.OPENCODE_SERVER_PASSWORD, url, args, options });
    setImmediate(() => {
      for (const line of behaviour.lines ?? []) proc.stdout.emit("data", Buffer.from(line + "\n"));
      if (behaviour.error) { proc.emit("error", behaviour.error); return; }
      if (behaviour.exitCode !== undefined) { proc.emit("exit", behaviour.exitCode); return; }
      if (behaviour.listen !== false) proc.stdout.emit("data", Buffer.from(`server listening on ${url}\n`));
    });
    return proc;
  });
}

/** Route fetches by URL: spawned, still-running fakes answer /api/info. */
let route: (url: string, init: RequestInit) => Response | Promise<Response>;
function defaultRoute(url: string, init: RequestInit): Response | Promise<Response> {
  const target = new URL(url);
  const server = spawned.find((s) => !s.proc.killed && new URL(s.url).host === target.host);
  if (!server) return refused();
  if (target.pathname !== "/api/info") return spaFallback();
  const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
  // Like the real binary: the username comes from OPENCODE_SERVER_USERNAME, default "opencode".
  const user = server.options.env.OPENCODE_SERVER_USERNAME ?? "opencode";
  return auth === basic(user, server.password) ? json(serverInfo("2.1.2", server.url)) : unauthorized();
}

let fetchMock: ReturnType<typeof vi.fn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

function headersOf(call: number): Record<string, string> {
  return ((fetchMock.mock.calls[call][1] as RequestInit).headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  spawned = [];
  route = defaultRoute;
  fetchMock = vi.fn(async (url: string, init: RequestInit) => route(String(url), init ?? {}));
  vi.stubGlobal("fetch", fetchMock);
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  spawnMock.mockReset();
  fakeOpencode();
  resetShutdownRegisteredForTests();
  // Capture lifecycle registration without installing handlers on the test runner.
  vi.spyOn(process, "on").mockReturnValue(process);
  vi.spyOn(process.stdin, "on").mockReturnValue(process.stdin);
});

afterEach(() => {
  stopServer();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ─── isServerRunning ─────────────────────────────────────────────────────

describe("isServerRunning", () => {
  it("returns healthy=true with version from GET /api/info", async () => {
    route = () => json(serverInfo("2.1.2"));
    const result = await isServerRunning("http://127.0.0.1:4096");
    expect(result).toEqual({ healthy: true, version: "2.1.2" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:4096/api/info", expect.objectContaining({ method: "GET" }));
  });

  it("strips trailing slash from base URL", async () => {
    route = () => json(serverInfo());
    await isServerRunning("http://127.0.0.1:4096/");
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:4096/api/info", expect.anything());
  });

  it("handles version missing from response", async () => {
    route = () => json({ pid: 1, urls: [], paths: { tmp: "/tmp" } });
    expect(await isServerRunning("http://127.0.0.1:4096")).toEqual({ healthy: true, version: undefined });
  });

  it("reports authFailed on 401 without probing the legacy endpoint", async () => {
    route = () => unauthorized();
    const result = await isServerRunning("http://127.0.0.1:4096", "opencode", "wrong");
    expect(result).toEqual({ healthy: false, authFailed: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("detects a legacy 1.x server when /api/info is 404 and /global/health answers", async () => {
    route = (url) => url.endsWith("/api/info") ? new Response("Not Found", { status: 404 }) : legacyHealth();
    const result = await isServerRunning("http://127.0.0.1:4096");
    expect(result).toEqual({ healthy: false, legacy: true });
    expect(fetchMock).toHaveBeenLastCalledWith("http://127.0.0.1:4096/global/health", expect.anything());
  });

  it("detects a legacy 1.x server whose /api/info falls through to HTML", async () => {
    route = (url) => url.endsWith("/api/info") ? spaFallback() : legacyHealth();
    expect(await isServerRunning("http://127.0.0.1:4096")).toEqual({ healthy: false, legacy: true });
  });

  it("does not mistake the 2.x web UI fallback for a legacy health endpoint", async () => {
    route = (url) => url.endsWith("/api/info") ? new Response("", { status: 404 }) : spaFallback();
    expect(await isServerRunning("http://127.0.0.1:4096")).toEqual({ healthy: false });
  });

  it("returns healthy=false when the server is down", async () => {
    route = () => refused();
    expect(await isServerRunning("http://127.0.0.1:4096")).toEqual({ healthy: false });
  });

  it("returns healthy=false on a non-401/404 error status", async () => {
    route = () => new Response("Internal Server Error", { status: 500 });
    expect(await isServerRunning("http://127.0.0.1:4096")).toEqual({ healthy: false });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("times out cleanly (returns unhealthy on AbortError)", async () => {
    route = () => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    expect(await isServerRunning("http://127.0.0.1:4096")).toEqual({ healthy: false });
  });

  it("does not send an Authorization header when no password is given", async () => {
    route = () => json(serverInfo());
    await isServerRunning("http://127.0.0.1:4096");
    expect(headersOf(0).Authorization).toBeUndefined();
  });

  it("sends Basic auth header when password is provided", async () => {
    route = () => json(serverInfo());
    await isServerRunning("http://127.0.0.1:4096", "admin", "secret123");
    expect(headersOf(0).Authorization).toBe("Basic YWRtaW46c2VjcmV0MTIz");
  });

  it("defaults username to 'opencode' when only password is provided", async () => {
    route = () => json(serverInfo());
    await isServerRunning("http://127.0.0.1:4096", undefined, "secret123");
    // base64("opencode:secret123") === "b3BlbmNvZGU6c2VjcmV0MTIz"
    expect(headersOf(0).Authorization).toBe("Basic b3BlbmNvZGU6c2VjcmV0MTIz");
  });

  it("never sends credentials to the legacy probe", async () => {
    route = (url) => url.endsWith("/api/info") ? new Response("", { status: 404 }) : legacyHealth();
    await isServerRunning("http://127.0.0.1:4096", "opencode", "secret123");
    expect(headersOf(1).Authorization).toBeUndefined();
  });

  it("prefers an explicit Authorization header over Basic credentials", async () => {
    route = () => json(serverInfo());
    await isServerRunning("http://127.0.0.1:4096", "admin", "secret123", "Bearer oc_client_x");
    expect(headersOf(0).Authorization).toBe("Bearer oc_client_x");
  });
});

// ─── startServer ─────────────────────────────────────────────────────────

describe("startServer", () => {
  it("spawns `opencode serve` with a generated password and probes /api/info with it", async () => {
    const result = await startServer("http://127.0.0.1:4096", 5000);

    expect(spawnMock).toHaveBeenCalledOnce();
    const [command, args, options] = spawnMock.mock.calls[0];
    expect(command).toBe("opencode");
    expect(args).toEqual(["serve", "--hostname=127.0.0.1", "--port=4096"]);
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    const password = options.env.OPENCODE_SERVER_PASSWORD;
    expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // The child inherits the rest of the environment.
    expect(options.env.PATH).toBe(process.env.PATH);

    expect(result).toEqual({ url: "http://127.0.0.1:4096", version: "2.1.2", password });
    const probe = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/info"))!;
    expect((probe[1] as RequestInit).headers).toMatchObject({ Authorization: basic("opencode", password) });
  });

  it("generates a fresh password for every start", async () => {
    const first = await startServer("http://127.0.0.1:4096", 5000);
    stopServer();
    const second = await startServer("http://127.0.0.1:4096", 5000);
    expect(first.password).not.toBe(second.password);
  });

  it("parses custom hostname and port from baseUrl", async () => {
    const result = await startServer("http://localhost:5000", 5000);
    expect(spawnMock.mock.calls[0][1]).toEqual(["serve", "--hostname=localhost", "--port=5000"]);
    expect(result.url).toBe("http://localhost:5000");
  });

  it("falls back to port 4096 when baseUrl omits port", async () => {
    await startServer("http://localhost", 5000);
    expect(spawnMock.mock.calls[0][1]).toContain("--port=4096");
  });

  it("uses the URL reported on stdout rather than the requested one", async () => {
    spawnMock.mockImplementation((_c: string, _a: string[], options: any) => {
      const proc = new FakeProcess();
      spawned.push({ proc, password: options.env.OPENCODE_SERVER_PASSWORD, url: "http://127.0.0.1:4555", args: _a, options });
      setImmediate(() => proc.stdout.emit("data", Buffer.from("server listening on http://127.0.0.1:4555\n")));
      return proc;
    });
    expect((await startServer("http://localhost:4555", 5000)).url).toBe("http://127.0.0.1:4555");
  });

  it("detects the listening line on stderr too", async () => {
    spawnMock.mockImplementation((_c: string, args: string[], options: any) => {
      const proc = new FakeProcess();
      spawned.push({ proc, password: options.env.OPENCODE_SERVER_PASSWORD, url: "http://127.0.0.1:4096", args, options });
      setImmediate(() => proc.stderr.emit("data", Buffer.from("server listening on http://127.0.0.1:4096\r\n")));
      return proc;
    });
    expect((await startServer("http://127.0.0.1:4096", 5000)).url).toBe("http://127.0.0.1:4096");
  });

  it("keeps its own password even if the server prints a generated one", async () => {
    fakeOpencode({ lines: ["server password not-ours"] });
    const result = await startServer("http://127.0.0.1:4096", 5000);
    expect(result.password).toBe(spawned[0].password);
    expect(result.password).not.toBe("not-ours");
  });

  it("rejects and kills the child on a listen error line", async () => {
    fakeOpencode({ lines: ["Error: listen EADDRINUSE: address already in use 127.0.0.1:4096"], listen: false });
    await expect(startServer("http://127.0.0.1:4096", 5000)).rejects.toThrow("OpenCode server failed to start: Error: listen EADDRINUSE");
    expect(spawned[0].proc.kill).toHaveBeenCalled();
  });

  it("rejects when the child exits before listening, including its output", async () => {
    fakeOpencode({ lines: ["fatal: bad config"], exitCode: 1 });
    await expect(startServer("http://127.0.0.1:4096", 5000)).rejects.toThrow(/exited before listening \(code 1\)\nfatal: bad config/);
  });

  it("rejects when the binary cannot be spawned", async () => {
    fakeOpencode({ error: Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" }) });
    await expect(startServer("http://127.0.0.1:4096", 5000)).rejects.toThrow("spawn opencode ENOENT");
  });

  it("times out and kills the child when it never reports listening", async () => {
    fakeOpencode({ listen: false });
    await expect(startServer("http://127.0.0.1:4096", 50)).rejects.toThrow("Timeout waiting for the OpenCode server to start after 50ms");
    expect(spawned[0].proc.kill).toHaveBeenCalled();
  });

  it("kills the child and throws when it never becomes healthy", async () => {
    route = () => unauthorized(); // e.g. the child ignored our password
    await expect(startServer("http://127.0.0.1:4096", 300)).rejects.toThrow("did not become healthy");
    expect(spawned[0].proc.kill).toHaveBeenCalledOnce();
  });

  it("detects the listening line when it arrives split across stdout chunks", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[], options: any) => {
      const proc = new FakeProcess();
      spawned.push({ proc, password: options.env.OPENCODE_SERVER_PASSWORD, url: "http://127.0.0.1:4096", args, options });
      setImmediate(() => {
        proc.stdout.emit("data", Buffer.from("server listen"));
        proc.stdout.emit("data", Buffer.from("ing on http://127.0.0.1:4096\n"));
      });
      return proc;
    });
    expect((await startServer("http://127.0.0.1:4096", 5000)).url).toBe("http://127.0.0.1:4096");
  });

  it.each(["http://remote.example:4096", "https://localhost:4096", "http://localhost:4096/proxy", "http://0.0.0.0:4096"])(
    "refuses to spawn for non-loopback or prefixed URL %s",
    async (baseUrl) => {
      await expect(startServer(baseUrl, 5000)).rejects.toThrow("local loopback HTTP URL");
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );
});

// ─── stopServer ──────────────────────────────────────────────────────────

describe("stopServer", () => {
  it("does not throw when no managed server exists", () => {
    expect(() => stopServer()).not.toThrow();
  });

  it("kills the managed process when one exists", async () => {
    await startServer("http://127.0.0.1:4096", 5000);
    stopServer();
    expect(spawned[0].proc.kill).toHaveBeenCalledOnce();
  });

  it("is idempotent (subsequent calls are no-ops)", async () => {
    await startServer("http://127.0.0.1:4096", 5000);
    stopServer();
    stopServer();
    expect(spawned[0].proc.kill).toHaveBeenCalledOnce();
  });

  it("tolerates a process that already exited", async () => {
    await startServer("http://127.0.0.1:4096", 5000);
    spawned[0].proc.kill.mockImplementation(() => { throw new Error("ESRCH"); });
    expect(() => stopServer()).not.toThrow();
  });
});

// ─── registerShutdownHandlers ─────────────────────────────────────────────

describe("registerShutdownHandlers", () => {
  it("registers listeners for SIGINT, SIGTERM, SIGHUP and STDIN events", () => {
    registerShutdownHandlers();

    expect(process.on).toHaveBeenCalledWith("exit", expect.any(Function));
    expect(process.on).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(process.on).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(process.on).toHaveBeenCalledWith("SIGHUP", expect.any(Function));
    expect(process.stdin.on).toHaveBeenCalledWith("end", expect.any(Function));
    expect(process.stdin.on).toHaveBeenCalledWith("close", expect.any(Function));
  });
});

describe("shutdown behavior", () => {
  it.each(["SIGINT", "SIGTERM", "SIGHUP", "end", "close"])("%s kills the owned server and exits", async (event) => {
    await startServer("http://127.0.0.1:4096");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const source = event === "end" || event === "close" ? process.stdin : process;
    const handler = vi.mocked(source.on).mock.calls.find(([name]) => name === event)![1] as () => void;
    handler();
    stopServer();
    expect(spawned[0].proc.kill).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exit cleanup kills the owned server without calling process.exit", async () => {
    await startServer("http://127.0.0.1:4096");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const handler = vi.mocked(process.on).mock.calls.find(([name]) => name === "exit")![1] as () => void;
    handler();
    expect(spawned[0].proc.kill).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });

  it("registers shutdown handlers only once", () => {
    registerShutdownHandlers();
    registerShutdownHandlers();
    expect(vi.mocked(process.on).mock.calls.filter(([name]) => name === "SIGTERM")).toHaveLength(1);
  });
});

// ─── ensureServer ────────────────────────────────────────────────────────

describe("ensureServer", () => {
  it("returns immediately when server is already running", async () => {
    route = () => json(serverInfo("2.1.2"));

    const result = await ensureServer({ baseUrl: "http://127.0.0.1:4096", autoServe: true });

    expect(result).toEqual({ running: true, version: "2.1.2", managedByUs: false, url: "http://127.0.0.1:4096" });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("already running"));
  });

  it("starts the child with the configured username and probes with it", async () => {
    vi.stubEnv("OPENCODE_SERVER_USERNAME", "inherited");
    await ensureServer({ baseUrl: "http://127.0.0.1:4096", autoServe: true, username: "alice" });
    expect(spawned[0].options.env.OPENCODE_SERVER_USERNAME).toBe("alice");
    const probe = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/info")).at(-1)!;
    expect((probe[1] as RequestInit).headers).toMatchObject({ Authorization: basic("alice", spawned[0].password) });
  });

  it("starts the server when not running and autoServe is explicitly true, returning its password", async () => {
    const result = await ensureServer({ baseUrl: "http://127.0.0.1:4096", autoServe: true });

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(result).toEqual({
      running: true,
      version: "2.1.2",
      managedByUs: true,
      url: "http://127.0.0.1:4096",
      password: spawned[0].password,
    });
  });

  it("throws when autoServe is false and server is not running", async () => {
    route = () => refused();
    await expect(ensureServer({ baseUrl: "http://127.0.0.1:4096", autoServe: false })).rejects.toThrow("OPENCODE_AUTO_SERVE=false");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("reports a credential mismatch instead of spawning a second server", async () => {
    route = () => unauthorized();
    await expect(ensureServer({ baseUrl: "http://127.0.0.1:4096", autoServe: true, password: "stale" }))
      .rejects.toThrow("rejected the configured credentials (HTTP 401)");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses a legacy 1.x server instead of spawning over it", async () => {
    route = (url) => url.endsWith("/api/info") ? new Response("", { status: 404 }) : legacyHealth();
    await expect(ensureServer({ baseUrl: "http://127.0.0.1:4096", autoServe: true }))
      .rejects.toThrow("OpenCode 1.x server detected");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("propagates startServer errors", async () => {
    fakeOpencode({ lines: ["Error: listen EADDRINUSE: address already in use"], listen: false });
    await expect(ensureServer({ baseUrl: "http://127.0.0.1:4096", autoServe: true })).rejects.toThrow("EADDRINUSE");
  });

  it("forwards Basic auth credentials to the health probe", async () => {
    route = () => json(serverInfo());
    await ensureServer({ baseUrl: "http://127.0.0.1:4096", username: "admin", password: "secret123" });
    expect(headersOf(0).Authorization).toBe("Basic YWRtaW46c2VjcmV0MTIz");
  });

  it("serializes concurrent startups onto one spawn", async () => {
    // Both initial probes observe a dead port. Without the in-flight lock
    // both callers would spawn (EADDRINUSE / leaked child).
    const [a, b] = await Promise.all([
      ensureServer({ baseUrl: "http://127.0.0.1:4096", autoServe: true }),
      ensureServer({ baseUrl: "http://127.0.0.1:4096/", autoServe: true }),
    ]);

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(a.running).toBe(true);
    expect(b.running).toBe(true);
    expect(a.password).toBe(spawned[0].password);
    expect(b.password).toBe(spawned[0].password);
  });

  it("does NOT coalesce concurrent startups across different baseUrls", async () => {
    const [a, b] = await Promise.all([
      ensureServer({ baseUrl: "http://127.0.0.1:4096", autoServe: true }),
      ensureServer({ baseUrl: "http://127.0.0.1:5000", autoServe: true }),
    ]);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(a.url).toBe("http://127.0.0.1:4096");
    expect(b.url).toBe("http://127.0.0.1:5000");
    expect(a.password).not.toBe(b.password);
  });

  it("allows a new startup after a failed one", async () => {
    fakeOpencode({ exitCode: 1 });
    await expect(ensureServer({ baseUrl: "http://127.0.0.1:4096", autoServe: true })).rejects.toThrow("exited before listening");
    fakeOpencode();
    await expect(ensureServer({ baseUrl: "http://127.0.0.1:4096", autoServe: true })).resolves.toMatchObject({ managedByUs: true });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});

describe("Issue #18: explicit server ownership", () => {
  it("does not spawn a second server by default", async () => {
    route = () => refused();
    await expect(ensureServer({ baseUrl: "http://127.0.0.1:4096" })).rejects.toThrow("OPENCODE_AUTO_SERVE=false");
    expect(spawnMock).not.toHaveBeenCalled();
  });
  it("attaches to an existing TUI server without opting into startup", async () => {
    route = () => json(serverInfo());
    expect((await ensureServer({ baseUrl: "http://127.0.0.1:4096" })).managedByUs).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });
  it.each(["http://remote.example:4096", "https://localhost:4096", "http://localhost:4096/proxy"])("never tries to spawn for %s", async (baseUrl) => {
    route = () => refused();
    await expect(ensureServer({ baseUrl, autoServe: true })).rejects.toThrow("local loopback HTTP URL");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
