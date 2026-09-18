import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runDoctor, formatDoctor } from "../src/doctor.js";
import { parseCliArgs } from "../src/cli.js";
import { BackendDetectionError, type DetectedBackend } from "../src/backend-detection.js";
import type { OpenCodeClient } from "../src/client.js";

const connection: DetectedBackend = { baseUrl: "http://fixture.test", identity: { kind: "v1", version: "1.18.31", connectionSource: "explicit", processOwnership: "external", survivesDisconnect: true } };
const check = (report: Awaited<ReturnType<typeof runDoctor>>, id: string) => report.checks.find(check => check.id === id)!;
function dependencies(handler?: (path: string) => Promise<unknown>) {
  const get = vi.fn(handler ?? (async (path: string) => path === "/provider" ? { all: [{ id: "fixture", source: "env" }] } : { id: "project", worktree: "/remote/project" }));
  return { get, detect: vi.fn(async () => connection), client: () => ({ get, getBackendIdentity: () => connection.identity } as unknown as OpenCodeClient) };
}

describe("CLI arguments", () => {
  it("preserves no-argument stdio and supports doctor/check", () => {
    expect(parseCliArgs([])).toEqual({ command: "stdio" });
    expect(parseCliArgs(["doctor", "--directory", "C:\\repo", "--json"])).toEqual({ command: "doctor", directory: "C:\\repo", json: true });
    expect(parseCliArgs(["doctor", "--directory", "\\\\server\\share\\repo"])).toEqual({ command: "doctor", directory: "\\\\server\\share\\repo", json: false });
    expect(parseCliArgs(["--check"])).toEqual({ command: "doctor", json: false });
    expect(parseCliArgs(["--version"])).toEqual({ command: "version" });
  });
  it.each([["--json"], ["doctor", "--directory"], ["doctor", "--json", "--json"], ["doctor", "--bogus"], ["doctor", "--directory", "--json"], ["doctor", "--directory", "relative/path"], ["--help", "doctor"]])("rejects invalid arguments %j", args => expect(() => parseCliArgs(args)).toThrow());
});

describe("read-only doctor", () => {
  it("reports readiness using configured credentials without invoking inference", async () => {
    const deps = dependencies();
    const report = await runDoctor({ ...deps, env: {}, directory: "/remote/project" });
    expect(report.ready).toBe(true); expect(report.schemaVersion).toBe(1);
    expect(report.backend).toMatchObject({ kind: "v1", integrationTargetVersion: "1.18.31", matchesIntegrationTarget: true });
    expect(deps.detect).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ allowStartup: false, signal: expect.any(AbortSignal) }), undefined);
    expect(deps.get.mock.calls.map(call => call[0])).toEqual(["/provider", "/project/current"]);
    expect(check(report, "provider_configuration").message).toContain("no inference");
    expect(formatDoctor(report)).toContain("local executable is not required");
  });
  it("does not require a default project when --directory is omitted", async () => {
    const deps = dependencies();
    const report = await runDoctor({ ...deps, env: {} });
    expect(report.ready).toBe(true); expect(deps.get).toHaveBeenCalledTimes(1);
    expect(check(report, "project_access").message).toContain("not requested");
  });
  it("distinguishes a recognized version from the integration target without claiming live evidence", async () => {
    const deps = dependencies();
    const report = await runDoctor({ ...deps, env: {}, detect: async () => ({ ...connection, identity: { ...connection.identity, version: "1.99.0" } }) });
    expect(report.ready).toBe(true); expect(report.backend?.matchesIntegrationTarget).toBe(false);
    expect(check(report, "supported_version").status).toBe("warn");
    expect(formatDoctor(report)).not.toContain("integration-tested");
  });
  it("fails readiness without configured providers", async () => {
    const deps = dependencies(async () => ({ all: [{ id: "fixture" }] }));
    const report = await runDoctor({ ...deps, env: {} });
    expect(report.ready).toBe(false); expect(check(report, "provider_configuration").status).toBe("fail");
  });
  it.each([{ OPENCODE_BASE_URL: "http://username:secret-sentinel@host.test" }, { OPENCODE_BASE_URL: "https://host.test/?token=secret-sentinel" }])("redacts invalid URL configuration from text and JSON", async env => {
    const deps = dependencies();
    const report = await runDoctor({ ...deps, env });
    expect(report.ready).toBe(false); expect(deps.detect).not.toHaveBeenCalled();
    expect(JSON.stringify(report) + formatDoctor(report)).not.toMatch(/secret-sentinel|username|host\.test/);
  });
  it("never emits provider bodies or upstream error messages", async () => {
    const deps = dependencies(async () => { throw new Error("secret-sentinel upstream credential"); });
    const report = await runDoctor({ ...deps, env: { OPENCODE_SERVER_PASSWORD: "secret-sentinel" }, directory: "/secret-sentinel" });
    expect(JSON.stringify(report) + formatDoctor(report)).not.toContain("secret-sentinel");
  });
  it("omits hostile server version text", async () => {
    const deps = dependencies();
    const report = await runDoctor({ ...deps, env: {}, detect: async () => ({ ...connection, identity: { ...connection.identity, version: "secret-sentinel\n" } }) });
    expect(JSON.stringify(report) + formatDoctor(report)).not.toContain("secret-sentinel");
    expect(report.ready).toBe(false);
  });
  it.each([{ status: 401 }, { status: 403 }, { _tag: "UnauthorizedError" }, { cause: { status: 403 } }])("stops all reads after authentication failure %j", async error => {
    const deps = dependencies(async () => { throw { ...error, secret: "secret-sentinel" }; });
    const report = await runDoctor({ ...deps, env: {}, directory: "/remote/project" });
    expect(report.ready).toBe(false); expect(deps.get).toHaveBeenCalledTimes(1);
    expect(check(report, "authentication").status).toBe("fail");
    expect(JSON.stringify(report)).not.toContain("secret-sentinel");
  });
  it("stops after a detection authentication error without initializing a client", async () => {
    const client = vi.fn();
    const report = await runDoctor({ env: {}, client, detect: async () => { throw new BackendDetectionError("authentication", "secret-sentinel", 401); } });
    expect(report.ready).toBe(false); expect(client).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain("secret-sentinel");
  });
  it("bounds the combined detection/provider/project work with one deadline", async () => {
    const deps = dependencies(() => new Promise(() => {}));
    const before = Date.now();
    const report = await runDoctor({ ...deps, env: {}, timeoutMs: 35, directory: "/remote/project" });
    expect(Date.now() - before).toBeLessThan(500); expect(report.ready).toBe(false);
    expect(deps.get).toHaveBeenCalledTimes(1);
  });
  it("checks Node requirement without starting detection", async () => {
    const deps = dependencies();
    const report = await runDoctor({ ...deps, env: {}, nodeVersion: "20.1.0" });
    expect(report.ready).toBe(false); expect(deps.detect).not.toHaveBeenCalled();
  });
});

describe("doctor CLI process", () => {
  let http: Server | undefined;
  afterEach(async () => { if (http) { http.closeAllConnections(); await new Promise<void>(resolve => http!.close(() => resolve())); http = undefined; } });
  async function run(args: string[], env: NodeJS.ProcessEnv = {}) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url)), ...args], {
        env: { ...process.env, OPENCODE_BACKEND: "auto", OPENCODE_AUTO_SERVE: "false", OPENCODE_DEFAULT_PROVIDER: "", OPENCODE_DEFAULT_MODEL: "", ...env }, stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", value => { stdout += value; }); child.stderr.on("data", value => { stderr += value; });
      child.once("error", reject); child.once("exit", code => resolve({ code, stdout, stderr }));
    });
  }
  it("help/version work without backend readiness and invalid arguments exit2", async () => {
    expect((await run(["--help"])).stdout).toContain("Usage:");
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect((await run(["--version"])).stdout.trim()).toBe(pkg.version);
    expect((await run(["doctor", "--invalid"])).code).toBe(2);
    expect((await run(["doctor", "--directory", "relative/path"])).code).toBe(2);
  });
  it.each([true, false])("emits parseable JSON and exit status; provider configured=%s", async configured => {
    const requests: string[] = [];
    http = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`); res.setHeader("content-type", "application/json");
      if (req.url === "/global/health") res.end(JSON.stringify({ healthy: true, version: "1.18.31" }));
      else if (req.url?.startsWith("/provider")) res.end(JSON.stringify({ all: configured ? [{ id: "fixture", source: "env", options: { apiKey: "secret-sentinel" } }] : [] }));
      else res.end(JSON.stringify({ id: "project", worktree: "/remote/project" }));
    });
    await new Promise<void>(resolve => http!.listen(0, "127.0.0.1", resolve));
    const result = await run(["--check", "--json", "--directory", "/remote/project"], { OPENCODE_BASE_URL: `http://127.0.0.1:${(http.address() as { port: number }).port}`, OPENCODE_AUTO_SERVE: "true" });
    expect(result.code).toBe(configured ? 0 : 1); expect(JSON.parse(result.stdout).ready).toBe(configured);
    expect(result.stdout + result.stderr).not.toContain("secret-sentinel");
    expect(requests).toHaveLength(3); expect(requests.every(value => value.startsWith("GET "))).toBe(true);
  });
  it.each([401, 403])("stops V2 SDK reads after provider HTTP %i and redacts the body", async status => {
    const requests: string[] = [];
    http = createServer((req, res) => {
      requests.push(req.url ?? ""); res.setHeader("content-type", "application/json");
      if (req.url === "/global/health") { res.statusCode = 404; res.end("{}"); }
      else if (req.url === "/api/info") res.end(JSON.stringify({ version: "2.0.6", pid: 42, urls: [], paths: { tmp: "/tmp" } }));
      else { res.statusCode = status; res.end(JSON.stringify({ _tag: "UnauthorizedError", message: "secret-sentinel" })); }
    });
    await new Promise<void>(resolve => http!.listen(0, "127.0.0.1", resolve));
    const result = await run(["doctor", "--json", "--directory", "/remote/project"], { OPENCODE_BASE_URL: `http://127.0.0.1:${(http.address() as { port: number }).port}` });
    expect(result.code).toBe(1); expect(JSON.parse(result.stdout).checks.find((entry: any) => entry.id === "authentication").status).toBe("fail");
    expect(requests).toHaveLength(3); expect(requests[2]).toMatch(/provider/);
    expect(result.stdout + result.stderr).not.toContain("secret-sentinel");
  });
});
