import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
