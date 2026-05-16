import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Server manager tests.
 *
 * Post-SDK-migration (PR #11), `startServer` calls `createOpencodeServer` from
 * `@opencode-ai/sdk` instead of spawning `opencode serve` as a subprocess.
 * These tests cover the surviving contract: `isServerRunning` health probes
 * via `fetch`, and `ensureServer`'s detect-or-start branching.
 *
 * Deep startup / lifecycle integration is deferred to a real integration
 * suite (see roadmap C2) — we can't fully exercise `createOpencodeServer`
 * without booting a real port.
 */

// Mock the SDK before importing the server-manager module so the import chain
// picks up the mock. `vi.hoisted` keeps the mock reference accessible from
// both the (hoisted) `vi.mock` factory and the assertions below.
const { createOpencodeServerMock } = vi.hoisted(() => ({
  createOpencodeServerMock: vi.fn(),
}));
vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeServer: createOpencodeServerMock,
  OpencodeClient: vi.fn(),
}));

import {
  isServerRunning,
  startServer,
  stopServer,
  ensureServer,
} from "../src/server-manager.js";

// ─── Helpers ─────────────────────────────────────────────────────────────

let fetchMock: ReturnType<typeof vi.fn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

function mockFetchHealthy(version = "1.14.46") {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ healthy: true, version }),
  } as unknown as Response);
}

function mockFetchDown() {
  fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
}

function mockFetchUnhealthy() {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ healthy: false }),
  } as unknown as Response);
}

function mockFetchNotOk() {
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status: 500,
    text: async () => "Internal Server Error",
  } as unknown as Response);
}

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  createOpencodeServerMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  stopServer();
});

// ─── isServerRunning ─────────────────────────────────────────────────────

describe("isServerRunning", () => {
  it("returns healthy=true with version when server responds", async () => {
    mockFetchHealthy("1.14.46");
    const result = await isServerRunning("http://127.0.0.1:4096");
    expect(result).toEqual({ healthy: true, version: "1.14.46" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4096/global/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("returns healthy=false when server is down", async () => {
    mockFetchDown();
    const result = await isServerRunning("http://127.0.0.1:4096");
    expect(result).toEqual({ healthy: false });
  });

  it("returns healthy=false when response is not ok", async () => {
    mockFetchNotOk();
    const result = await isServerRunning("http://127.0.0.1:4096");
    expect(result).toEqual({ healthy: false });
  });

  it("returns healthy=false when body says not healthy", async () => {
    mockFetchUnhealthy();
    const result = await isServerRunning("http://127.0.0.1:4096");
    expect(result).toEqual({ healthy: false, version: undefined });
  });

  it("strips trailing slash from base URL", async () => {
    mockFetchHealthy();
    await isServerRunning("http://127.0.0.1:4096/");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4096/global/health",
      expect.anything(),
    );
  });

  it("handles version missing from response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ healthy: true }),
    } as unknown as Response);
    const result = await isServerRunning("http://127.0.0.1:4096");
    expect(result).toEqual({ healthy: true, version: undefined });
  });

  it("times out cleanly (returns unhealthy on AbortError)", async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    );
    const result = await isServerRunning("http://127.0.0.1:4096");
    expect(result).toEqual({ healthy: false });
  });

  it("does not send an Authorization header when no password is given", async () => {
    mockFetchHealthy();
    await isServerRunning("http://127.0.0.1:4096");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("sends Basic auth header when password is provided", async () => {
    mockFetchHealthy();
    await isServerRunning("http://127.0.0.1:4096", "admin", "secret123");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Basic YWRtaW46c2VjcmV0MTIz");
  });

  it("defaults username to 'opencode' when only password is provided", async () => {
    mockFetchHealthy();
    await isServerRunning("http://127.0.0.1:4096", undefined, "secret123");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    // base64("opencode:secret123") === "b3BlbmNvZGU6c2VjcmV0MTIz"
    expect(headers.Authorization).toBe("Basic b3BlbmNvZGU6c2VjcmV0MTIz");
  });
});

// ─── startServer ─────────────────────────────────────────────────────────

describe("startServer", () => {
  it("calls createOpencodeServer with parsed hostname and port", async () => {
    createOpencodeServerMock.mockResolvedValueOnce({
      url: "http://127.0.0.1:4096",
      close: vi.fn(),
    });
    // Post-start health check
    mockFetchHealthy("1.14.46");

    const result = await startServer("http://127.0.0.1:4096", 5000);

    expect(createOpencodeServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "127.0.0.1",
        port: 4096,
        timeout: 5000,
      }),
    );
    expect(result.url).toBe("http://127.0.0.1:4096");
    expect(result.version).toBe("1.14.46");
  });

  it("parses custom hostname and port from baseUrl", async () => {
    createOpencodeServerMock.mockResolvedValueOnce({
      url: "http://192.168.1.100:5000",
      close: vi.fn(),
    });
    mockFetchHealthy("1.14.46");

    await startServer("http://192.168.1.100:5000", 5000);

    expect(createOpencodeServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "192.168.1.100",
        port: 5000,
      }),
    );
  });

  it("falls back to port 4096 when baseUrl omits port", async () => {
    createOpencodeServerMock.mockResolvedValueOnce({
      url: "http://example.com:4096",
      close: vi.fn(),
    });
    mockFetchHealthy("1.14.46");

    await startServer("http://example.com", 5000);

    expect(createOpencodeServerMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 4096 }),
    );
  });

  it("propagates createOpencodeServer rejection", async () => {
    createOpencodeServerMock.mockRejectedValueOnce(
      new Error("port already in use"),
    );

    await expect(startServer("http://127.0.0.1:4096", 5000)).rejects.toThrow(
      "port already in use",
    );
  });

  it("returns version=undefined when post-start health check fails", async () => {
    createOpencodeServerMock.mockResolvedValueOnce({
      url: "http://127.0.0.1:4096",
      close: vi.fn(),
    });
    mockFetchDown(); // health check after start fails

    const result = await startServer("http://127.0.0.1:4096", 5000);

    expect(result.url).toBe("http://127.0.0.1:4096");
    expect(result.version).toBeUndefined();
  });
});

// ─── stopServer ──────────────────────────────────────────────────────────

describe("stopServer", () => {
  it("does not throw when no managed server exists", () => {
    expect(() => stopServer()).not.toThrow();
  });

  it("calls close() on the managed server when one exists", async () => {
    const closeMock = vi.fn();
    createOpencodeServerMock.mockResolvedValueOnce({
      url: "http://127.0.0.1:4096",
      close: closeMock,
    });
    mockFetchHealthy();

    await startServer("http://127.0.0.1:4096", 5000);
    stopServer();

    expect(closeMock).toHaveBeenCalledOnce();
  });

  it("is idempotent (subsequent calls are no-ops)", async () => {
    const closeMock = vi.fn();
    createOpencodeServerMock.mockResolvedValueOnce({
      url: "http://127.0.0.1:4096",
      close: closeMock,
    });
    mockFetchHealthy();

    await startServer("http://127.0.0.1:4096", 5000);
    stopServer();
    stopServer();

    expect(closeMock).toHaveBeenCalledOnce();
  });
});

// ─── ensureServer ────────────────────────────────────────────────────────

describe("ensureServer", () => {
  it("returns immediately when server is already running", async () => {
    mockFetchHealthy("1.14.46");

    const result = await ensureServer({ baseUrl: "http://127.0.0.1:4096" });

    expect(result).toEqual({
      running: true,
      version: "1.14.46",
      managedByUs: false,
      url: "http://127.0.0.1:4096",
    });
    expect(createOpencodeServerMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("already running"),
    );
  });

  it("starts the server when not running and autoServe is true (default)", async () => {
    mockFetchDown(); // initial probe fails
    createOpencodeServerMock.mockResolvedValueOnce({
      url: "http://127.0.0.1:4096",
      close: vi.fn(),
    });
    mockFetchHealthy("1.14.46"); // post-start probe

    const result = await ensureServer({ baseUrl: "http://127.0.0.1:4096" });

    expect(result).toEqual({
      running: true,
      version: "1.14.46",
      managedByUs: true,
      url: "http://127.0.0.1:4096",
    });
    expect(createOpencodeServerMock).toHaveBeenCalledOnce();
  });

  it("throws when autoServe is false and server is not running", async () => {
    mockFetchDown();

    await expect(
      ensureServer({
        baseUrl: "http://127.0.0.1:4096",
        autoServe: false,
      }),
    ).rejects.toThrow("OPENCODE_AUTO_SERVE=false");
    expect(createOpencodeServerMock).not.toHaveBeenCalled();
  });

  it("propagates startServer errors", async () => {
    mockFetchDown();
    createOpencodeServerMock.mockRejectedValueOnce(new Error("EADDRINUSE"));

    await expect(
      ensureServer({ baseUrl: "http://127.0.0.1:4096" }),
    ).rejects.toThrow("EADDRINUSE");
  });

  it("forwards Basic auth credentials to the health probe", async () => {
    mockFetchHealthy("1.14.46");

    await ensureServer({
      baseUrl: "http://127.0.0.1:4096",
      username: "admin",
      password: "secret123",
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Basic YWRtaW46c2VjcmV0MTIz");
  });

  it("serializes concurrent startups onto one createOpencodeServer call", async () => {
    // Both initial probes report unhealthy → both callers reach the
    // startServer branch. Without the in-flight lock, this would race
    // `createOpencodeServer` twice (EADDRINUSE / leaked handle).
    mockFetchDown();
    mockFetchDown();

    // Single createOpencodeServer resolution shared by both callers.
    let resolveStart: (value: { url: string; close(): void }) => void;
    const startPromise = new Promise<{ url: string; close(): void }>((r) => {
      resolveStart = r;
    });
    createOpencodeServerMock.mockReturnValueOnce(startPromise);

    // Post-start health probe for both callers.
    mockFetchHealthy("1.14.46");
    mockFetchHealthy("1.14.46");

    const [a, b] = await Promise.all([
      (async () => {
        const p = ensureServer({ baseUrl: "http://127.0.0.1:4096" });
        // Resolve after both callers have queued, so both observe the
        // in-flight promise rather than racing into a second start.
        resolveStart({ url: "http://127.0.0.1:4096", close: vi.fn() });
        return p;
      })(),
      ensureServer({ baseUrl: "http://127.0.0.1:4096" }),
    ]);

    expect(createOpencodeServerMock).toHaveBeenCalledOnce();
    expect(a.running).toBe(true);
    expect(b.running).toBe(true);
  });

  it("does NOT coalesce concurrent startups across different baseUrls", async () => {
    // Two concurrent callers targeting different URLs must each invoke
    // their own `createOpencodeServer`. Before the per-baseUrl keying,
    // the second caller would await the first caller's in-flight promise
    // and receive the wrong endpoint.
    //
    // The mock returns whichever URL was passed in, so each caller gets
    // back its own startup result regardless of which one races to call
    // the mock first.
    mockFetchDown();
    mockFetchDown();

    createOpencodeServerMock.mockImplementation(
      async (opts: { hostname: string; port: number }) => ({
        url: `http://${opts.hostname}:${opts.port}`,
        close: vi.fn(),
      }),
    );

    // Post-start health probes for both.
    mockFetchHealthy("1.14.46");
    mockFetchHealthy("1.14.46");

    const [a, b] = await Promise.all([
      ensureServer({ baseUrl: "http://127.0.0.1:4096" }),
      ensureServer({ baseUrl: "http://127.0.0.1:5000" }),
    ]);

    expect(createOpencodeServerMock).toHaveBeenCalledTimes(2);
    expect(a.url).toBe("http://127.0.0.1:4096");
    expect(b.url).toBe("http://127.0.0.1:5000");
  });
});
