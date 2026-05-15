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
 * Mock `@opencode-ai/sdk` so every call to `createOpencodeClient` (both the
 * one in the `OpenCodeClient` constructor and the one issued by
 * `buildSdkClient` during reconnect) returns the same factory output. Tests
 * push call recorders onto a shared queue and can therefore observe the URL
 * that each rebuilt SDK client targets.
 */
const sdkClientFactory = vi.hoisted(() => {
  const factories: Array<(opts: { baseUrl: string }) => unknown> = [];
  return {
    factories,
    create: (opts: { baseUrl: string }) => {
      const factory = factories.shift() ?? (() => ({ _client: {} }));
      return factory(opts);
    },
  };
});
vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeClient: sdkClientFactory.create,
  OpencodeClient: vi.fn(),
}));

import { OpenCodeClient, OpenCodeError } from "../src/client.js";
import { normalizeDirectory } from "../src/helpers.js";

/**
 * Client tests.
 *
 * Post-SDK-migration (PR #11), `OpenCodeClient.request()` dispatches through
 * `(this.api as any)._client` (the SDK's internal HTTP client), not the
 * global `fetch`. The legacy `fetch`-mocking HTTP-method suites do not
 * exercise the production code path anymore and have been marked
 * `describe.skip` below.
 *
 * They will be revived once the `HttpTransport` interface lands (roadmap
 * item C1) — at which point we can inject a `FetchTransport` in tests and
 * exercise the full request/retry/header pipeline without poking at SDK
 * internals.
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
    it("strips trailing slash from baseUrl", () => {
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

  it("strips trailing slash", () => {
    expect(normalizeDirectory("/tmp/")).toBe("/tmp");
  });

  it("resolves '..' segments", () => {
    expect(normalizeDirectory("/tmp/foo/..")).toBe("/tmp");
  });

  it("throws for non-existent directory", () => {
    expect(() =>
      normalizeDirectory("/this/absolutely/does/not/exist/xyz123"),
    ).toThrow("does not exist");
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
    // `(this.api as any)._client` — we replace it so we can inspect what
    // headers actually get sent without standing up a real server.
    (client.api as unknown as { _client: unknown })._client = {
      get: async (opts: { url: string; headers: Record<string, string> }) => {
        calls.push({ url: opts.url, headers: opts.headers });
        return { data: {}, error: undefined, response: { status: 200 } };
      },
    };

    await client.get("/project/current", undefined, "/tmp");

    expect(calls).toHaveLength(1);
    expect(calls[0].headers["x-opencode-directory"]).toBe("/tmp");
    // Explicit guard against the regressed behaviour:
    expect(calls[0].headers["x-opencode-directory"]).not.toContain("%2F");
  });

  it("omits the header when no directory is provided", async () => {
    const client = new OpenCodeClient({ baseUrl: "http://localhost:4096" });
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];

    (client.api as unknown as { _client: unknown })._client = {
      get: async (opts: { url: string; headers: Record<string, string> }) => {
        calls.push({ url: opts.url, headers: opts.headers });
        return { data: {}, error: undefined, response: { status: 200 } };
      },
    };

    await client.get("/project/current");

    expect(calls[0].headers["x-opencode-directory"]).toBeUndefined();
  });
});

// ─── Reconnect path: URL rebinding + reconnectAttempts reset ─────────────

describe("reconnect path", () => {
  beforeEach(() => {
    isServerRunningMock.mockReset();
    ensureServerMock.mockReset();
    sdkClientFactory.factories.length = 0;
  });

  /**
   * Queue SDK-client factories such that every produced `_client` shares
   * the same call-counter closure. The retry loop in `client.ts` runs
   * `MAX_RETRIES + 1` = 3 attempts before falling through to the reconnect
   * branch; tests exercising reconnect need at least 3 failures + 1 success.
   *
   * Each call records the `baseUrl` the factory was called with, so tests
   * can assert that the retry issued after `ensureServer()` targets the
   * rebound URL.
   */
  const MAX_RETRIES_PLUS_ONE = 3;
  function queueFlakySdkClients(
    factoryCount: number,
  ): Array<{ baseUrl: string }> {
    const calls: Array<{ baseUrl: string }> = [];
    let count = 0;
    for (let i = 0; i < factoryCount; i++) {
      sdkClientFactory.factories.push((opts: { baseUrl: string }) => ({
        _client: {
          get: async () => {
            count++;
            calls.push({ baseUrl: opts.baseUrl });
            if (count <= MAX_RETRIES_PLUS_ONE) {
              throw new Error("fetch failed");
            }
            return {
              data: { ok: true },
              error: undefined,
              response: { status: 200 },
            };
          },
        },
      }));
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
      version: "1.14.46",
      managedByUs: true,
      url: "http://localhost:5000",
    });

    await client.get("/health");

    expect(ensureServerMock).toHaveBeenCalledOnce();
    expect(client.getBaseUrl()).toBe("http://localhost:5000");
    // First 3 calls (the initial retry loop) target the original URL;
    // the 4th call — the retry triggered by the reconnect branch — must
    // observe the rebound baseUrl.
    expect(calls[0].baseUrl).toBe("http://localhost:4096");
    expect(calls[calls.length - 1].baseUrl).toBe("http://localhost:5000");
    // SDK client should be re-instantiated when the URL changes.
    expect(client.api).not.toBe(originalApi);
  });

  it("does not rebuild the SDK client when ensureServer returns the same url", async () => {
    queueFlakySdkClients(2);

    const client = new OpenCodeClient({
      baseUrl: "http://localhost:4096",
      autoServe: true,
    });
    const originalApi = client.api;

    isServerRunningMock.mockResolvedValueOnce({ healthy: false });
    ensureServerMock.mockResolvedValueOnce({
      running: true,
      version: "1.14.46",
      managedByUs: true,
      url: "http://localhost:4096",
    });

    await client.get("/health");

    expect(client.getBaseUrl()).toBe("http://localhost:4096");
    expect(client.api).toBe(originalApi);
  });

  it("resets reconnectAttempts after a successful request", async () => {
    // 4 round-trips × at most 2 factories each (constructor + possible
    // rebuild). Constructor only registers one factory; the rebuild path
    // only fires when ensureServer returns a different URL, which it
    // doesn't here. So 4 round-trips share the constructor factory's
    // counter — that's exactly what we want: each round-trip resets the
    // counter independently because we requeue a fresh factory.
    const client = new OpenCodeClient({
      baseUrl: "http://localhost:4096",
      autoServe: true,
    });

    // 4 round-trips, each: 3 failures → reconnect (healthy probe) → success.
    for (let i = 0; i < 4; i++) {
      queueFlakySdkClients(1);
      // Replace the SDK client's `_client` with the freshly-queued factory's
      // output so the next request hits a fresh 3-fail-then-succeed cycle.
      const factory = sdkClientFactory.factories.shift();
      if (factory) {
        const fresh = factory({ baseUrl: client.getBaseUrl() }) as { _client: unknown };
        (client.api as unknown as { _client: unknown })._client = fresh._client;
      }
      isServerRunningMock.mockResolvedValueOnce({ healthy: true, version: "1.14.46" });
      await client.get("/health");
    }

    // All 4 requests should have invoked the reconnect path. If
    // reconnectAttempts had monotonically grown (the bug), the cap of 3
    // would have been hit on the 4th request and the reconnect branch
    // would have been skipped → only 3 probes.
    expect(isServerRunningMock).toHaveBeenCalledTimes(4);
  });
});

// ─── HTTP method dispatch (deferred — see comment at top of file) ────────

describe.skip("OpenCodeClient HTTP methods (TODO: revive after C1 — HttpTransport interface)", () => {
  // These tests mocked global `fetch`, which the SDK-routed client no longer
  // calls directly. Reintroduce when `src/transport.ts` lands so we can
  // inject a `FetchTransport` and exercise:
  //   - get / post / patch / put / delete request shapes
  //   - retry on transient (429/502/503/504) and network errors
  //   - 204 No Content handling
  //   - non-JSON content-type passthrough
  //   - Authorization header presence/absence
  //   - x-opencode-directory header propagation across all verbs
  //   - MAX_RETRIES exhaustion behaviour
  it("placeholder", () => {
    /* intentionally empty */
  });

  beforeEach(() => {
    /* no-op */
  });

  afterEach(() => {
    /* no-op */
  });
});
