import { describe, expect, it, vi } from "vitest";
import { BackendDetectionError, DEFAULT_BASE_URL, detectBackend, readBackendConfig } from "../src/backend-detection.js";

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const info = { version: "2.0.6", pid: 42, urls: ["http://127.0.0.1:4100"], paths: { tmp: "/tmp" } };
const config = (values: NodeJS.ProcessEnv = {}) => readBackendConfig(values);
const absent = () => Promise.resolve(undefined);

describe("backend configuration", () => {
  it.each([{ OPENCODE_BACKEND: "v3" }, { OPENCODE_TOOL_PROFILE: "invalid" }, { OPENCODE_AUTO_SERVE: "1" }, { OPENCODE_DEFAULT_MODEL: "one" },
    { OPENCODE_BASE_URL: "https://user:secret@example.test" }, { OPENCODE_BASE_URL: "https://example.test?token=secret" }, { OPENCODE_BASE_URL: "file:///tmp" }, { OPENCODE_BASE_URL: "invalid" }])("rejects invalid config without echoing values %j", values => {
    expect(() => config(values)).toThrow(BackendDetectionError);
    try { config(values); } catch (error) { expect(String(error)).not.toContain("secret"); }
  });
  it("keeps explicit URL authoritative and preserves prefix", () => {
    expect(config({ OPENCODE_BASE_URL: "http://host.test/prefix/" }).baseUrl).toBe("http://host.test/prefix");
    expect(config()).toMatchObject({ backend: "auto", autoServe: false, profile: "full", baseUrl: undefined });
  });
});

describe("backend detection", () => {
  it("identifies V1 at the explicit URL without local discovery or executable", async () => {
    const fetch = vi.fn(async () => response({ healthy: true, version: "1.18.31" }));
    const discover = vi.fn(absent), registration = vi.fn(absent), start = vi.fn();
    const result = await detectBackend(config({ OPENCODE_BASE_URL: "https://remote.test/prefix" }), {}, { fetch, discover, registration, start });
    expect(result.identity).toEqual({ kind: "v1", version: "1.18.31", connectionSource: "explicit", processOwnership: "external", survivesDisconnect: true });
    expect(fetch.mock.calls[0][0]).toBe("https://remote.test/prefix/global/health");
    expect(discover).not.toHaveBeenCalled(); expect(registration).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });
  it("recognizes V2 server.info after a rejected V1 health contract", async () => {
    const fetch = vi.fn(async (url: any) => response(String(url).endsWith("/api/info") ? info : { error: "not found" }, String(url).endsWith("/api/info") ? 200 : 404));
    const result = await detectBackend(config({ OPENCODE_BASE_URL: "http://remote.test" }), {}, { fetch });
    expect(result.identity.kind).toBe("v2"); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(["v1", "v2"] as const)("forced %s validates only that contract", async backend => {
    const fetch = vi.fn(async () => response(backend === "v1" ? info : { healthy: true, version: "1.18.31" }));
    const start = vi.fn();
    await expect(detectBackend(config({ OPENCODE_BACKEND: backend, OPENCODE_BASE_URL: "http://host.test", OPENCODE_AUTO_SERVE: "true" }), { allowStartup: true }, { fetch, start })).rejects.toMatchObject({ code: "incompatible" });
    expect(fetch).toHaveBeenCalledTimes(1); expect(start).not.toHaveBeenCalled();
  });
  it.each([401, 403])("stops on HTTP %i without alternate probe, discovery, or startup", async status => {
    const fetch = vi.fn(async () => response({ secret: "secret-sentinel" }, status));
    const discover = vi.fn(absent), registration = vi.fn(absent), start = vi.fn();
    await expect(detectBackend(config({ OPENCODE_AUTO_SERVE: "true" }), { allowStartup: true }, { fetch, discover, registration, start })).rejects.toMatchObject({ code: "authentication", status });
    expect(fetch).toHaveBeenCalledTimes(1); expect(discover).not.toHaveBeenCalled(); expect(registration).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });
  it("never discovers another endpoint after an explicit endpoint fails", async () => {
    const fetch = vi.fn(async () => { throw new Error("offline"); }), discover = vi.fn(absent), registration = vi.fn(absent);
    await expect(detectBackend(config({ OPENCODE_BASE_URL: "http://host.test" }), {}, { fetch, discover, registration })).rejects.toMatchObject({ code: "unavailable" });
    expect(discover).not.toHaveBeenCalled(); expect(registration).not.toHaveBeenCalled();
  });
  it("preflights a service registration and selects via read-only SDK discovery", async () => {
    const fetch = vi.fn(async (url: any) => { if (String(url).startsWith(DEFAULT_BASE_URL)) throw new Error("offline"); return response(info); });
    const discover = vi.fn(async () => ({ url: "http://127.0.0.1:4100", auth: { type: "basic" as const, username: "opencode", password: "fixture-only" } }));
    const registration = vi.fn(async () => ({ url: "http://127.0.0.1:4100", pid: 42, version: "2.0.6", password: "fixture-only" }));
    const start = vi.fn();
    const result = await detectBackend(config({ OPENCODE_AUTO_SERVE: "true" }), { allowStartup: true }, { fetch, discover, registration, start });
    expect(result.identity).toMatchObject({ kind: "v2", connectionSource: "discovered", processOwnership: "shared", survivesDisconnect: true });
    expect(discover).toHaveBeenCalledOnce(); expect(start).not.toHaveBeenCalled();
    expect(fetch.mock.calls.filter(call => String(call[0]).includes(":4100"))).toHaveLength(2);
  });
  it.each([401, 403])("registration HTTP %i terminates before opaque SDK discovery or startup", async status => {
    const fetch = vi.fn(async (url: any) => { if (String(url).startsWith(DEFAULT_BASE_URL)) throw new Error("offline"); return response({}, status); });
    const discover = vi.fn(absent), start = vi.fn();
    await expect(detectBackend(config({ OPENCODE_AUTO_SERVE: "true" }), { allowStartup: true }, { fetch, discover, start, registration: async () => ({ url: "http://127.0.0.1:4100", pid: 42 }) })).rejects.toMatchObject({ code: "authentication" });
    expect(discover).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });
  it("does not replace an unresponsive registered service", async () => {
    const start = vi.fn(), discover = vi.fn(absent);
    await expect(detectBackend(config({ OPENCODE_AUTO_SERVE: "true" }), { allowStartup: true }, { fetch: vi.fn(async () => { throw new Error("offline"); }), start, discover, registration: async () => ({ url: "http://127.0.0.1:4100", pid: 42 }) })).rejects.toMatchObject({ code: "incompatible" });
    expect(start).not.toHaveBeenCalled(); expect(discover).not.toHaveBeenCalled();
  });
  it("starts an owned V1 child only with opt-in, absent registration, and allowed startup", async () => {
    let running = false;
    const fetch = vi.fn(async () => { if (!running) throw new Error("offline"); return response({ healthy: true, version: "1.18.31" }); });
    const start = vi.fn(async () => { running = true; return { running: true, managedByUs: true, url: DEFAULT_BASE_URL, version: "1.18.31" }; });
    const result = await detectBackend(config({ OPENCODE_AUTO_SERVE: "true" }), { allowStartup: true }, { fetch, start, registration: absent });
    expect(result.identity).toMatchObject({ kind: "v1", connectionSource: "owned-child", processOwnership: "owned", survivesDisconnect: false });
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0][0]).toMatchObject({ timeoutMs: expect.any(Number) });
  });
  it.each([{}, { OPENCODE_AUTO_SERVE: "true", OPENCODE_BACKEND: "v2" }])("never starts without permitted V1 startup %j", async env => {
    const start = vi.fn();
    await expect(detectBackend(config(env), { allowStartup: false }, { fetch: vi.fn(async () => { throw new Error(); }), start, registration: absent })).rejects.toBeInstanceOf(BackendDetectionError);
    expect(start).not.toHaveBeenCalled();
  });
  it("bounds a hung discovery inside the total deadline", async () => {
    const fetch = vi.fn(async (url: any) => { if (String(url).startsWith(DEFAULT_BASE_URL)) throw new Error("offline"); return response(info); });
    const start = vi.fn();
    const before = Date.now();
    await expect(detectBackend(config(), { timeout: 40 }, { fetch, start, discover: () => new Promise(() => {}), registration: async () => ({ url: "http://127.0.0.1:4100", pid: 42 }) })).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - before).toBeLessThan(500); expect(start).not.toHaveBeenCalled();
  });
});
