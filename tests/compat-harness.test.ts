import { afterEach, describe, expect, it, vi } from "vitest";
import { compatibilityErrorSummary, ownedServerPassword, targets, waitForBackend } from "../scripts/test-compat.mjs";

afterEach(() => vi.unstubAllGlobals());
describe("isolated compatibility authentication", () => {
  it("reads only the documented V2 password line from owned stdout", () => {
    expect(ownedServerPassword("server listening http://127.0.0.1:1234\nserver password fixture-only\n")).toBe("fixture-only");
    expect(ownedServerPassword("unrelated line with fixture-only")).toBeUndefined();
  });
  it.each([401, 403])("forwards configured Basic authentication and terminates on HTTP %i", async status => {
    const fetch = vi.fn(async () => new Response("{}", { status })); vi.stubGlobal("fetch", fetch);
    const processInfo = { child: { exitCode: null, signalCode: null }, stdout: "secret-sentinel", stderr: "secret-sentinel" };
    await expect(waitForBackend(processInfo, "http://fixture.test", targets.v2, { Authorization: "Basic fixture" }, 30)).rejects.toMatchObject({ code: "BACKEND_AUTHENTICATION" });
    expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][1]).toMatchObject({ headers: { Authorization: "Basic fixture" } });
  });
  it("does not make an unauthenticated V2 probe before the password line arrives", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const processInfo = { child: { exitCode: null, signalCode: null }, stdout: "", stderr: "secret-sentinel" };
    await expect(waitForBackend(processInfo, "http://fixture.test", targets.v2, () => undefined, 10)).rejects.toMatchObject({ code: "BACKEND_TIMEOUT" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("never includes process output or arbitrary error messages in diagnostics", async () => {
    const processInfo = { child: { exitCode: 1, signalCode: null }, stdout: "secret-sentinel", stderr: "secret-sentinel" };
    try { await waitForBackend(processInfo, "http://fixture.test", targets.v2, {}, 10); throw new Error("expected failure"); }
    catch (error) { expect(String(error) + compatibilityErrorSummary(error)).not.toContain("secret-sentinel"); }
    expect(compatibilityErrorSummary(new Error("secret-sentinel"))).not.toContain("secret-sentinel");
    expect(compatibilityErrorSummary({ code: "ERR_ASSERTION", message: "secret-sentinel" })).not.toContain("secret-sentinel");
  });
});

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { executableCommand } from "../scripts/test-compat.mjs";
import { childProcess, stopProcess, run } from "../scripts/test-package.mjs";

describe("isolated executable process ownership", () => {
  it("invokes JavaScript shebang wrappers through the current Node executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-launcher-"));
    try {
      const wrapper = join(root, "opencode"); await writeFile(wrapper, '#!/usr/bin/env node\nconsole.log("launcher-ok")\n');
      const [command, ...args] = await executableCommand(wrapper);
      expect(command).toBe(process.execPath); expect(args).toEqual([wrapper]);
      expect((await run(command, args)).trim()).toBe("launcher-ok");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("cleans up a native server child launched by an owned wrapper", async () => {
    const server = 'const net=require("node:net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>console.log(s.address().port));';
    const wrapper = `const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e",${JSON.stringify(server)}],{stdio:["ignore","pipe","ignore"]});child.stdout.pipe(process.stdout);setInterval(()=>{},1000);`;
    const owned = childProcess(process.execPath, ["-e", wrapper], { ownedProcessGroup: true });
    try {
      const deadline = Date.now() + 5000;
      while (!owned.stdout.trim() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      const port = Number(owned.stdout.trim()); expect(port).toBeGreaterThan(0);
      await stopProcess(owned);
      const closed = await new Promise(resolve => {
        const socket = connect({ host: "127.0.0.1", port });
        socket.once("connect", () => { socket.destroy(); resolve(false); });
        socket.once("error", error => { socket.destroy(); resolve((error as NodeJS.ErrnoException).code === "ECONNREFUSED"); });
      });
      expect(closed).toBe(true);
    } finally { await stopProcess(owned); }
  }, 15_000);
});

import { packageOptions } from "../scripts/test-package.mjs";
describe("preserved archive selection", () => {
  it("keeps default packing and accepts one absolute tgz candidate", () => {
    expect(packageOptions([])).toEqual({});
    const archive = join(tmpdir(), "candidate package.tgz");
    expect(packageOptions(["--archive", archive])).toEqual({ archive });
  });
  it.each([["--archive"], ["--archive", "relative.tgz"], ["--archive", "https://example.test/archive.tgz"], ["--archive", join(tmpdir(), "package.json")], ["--unknown"], ["--archive", join(tmpdir(), "a.tgz"), "extra"]].map(args => ({ args })))("rejects invalid archive arguments $args", ({ args }) => {
    expect(() => packageOptions(args)).toThrow();
  });
});

import { compatibilityOptions, assertDoctorResult, configuredProviderEvidence } from "../scripts/test-compat.mjs";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { isolatedEnvironment, npmCommand, packedInstall } from "../scripts/test-package.mjs";

describe("retained compatibility archives", () => {
  it("accepts archive selection without enabling inference", () => {
    const archive = join(tmpdir(), "retained candidate.tgz");
    expect(compatibilityOptions(["--backend", "v2", "--archive", archive])).toMatchObject({ backend: "v2", archive, inference: false, credentialEnv: [] });
  });
  it.each([["--archive"], ["--archive", "relative.tgz"], ["--archive", "https://example.test/candidate.tgz"], ["--archive", join(tmpdir(), "candidate.json")], ["--archive", join(tmpdir(), "a.tgz"), "--archive", join(tmpdir(), "b.tgz")]].map(args => ({ args })))("rejects invalid or duplicate archive arguments $args", ({ args }) => {
    expect(() => compatibilityOptions(args)).toThrow();
  });
  it("installs supplied bytes without packing the working tree or changing the original", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-retained-archive-"));
    try {
      const env = await isolatedEnvironment(root), producer = join(root, "producer"), consumer = join(root, "test");
      await mkdir(producer); await mkdir(consumer);
      await writeFile(join(producer, "package.json"), JSON.stringify({ name: "opencode-mcp", version: "99.0.0-fixture", bin: { "opencode-mcp": "index.js" } }));
      await writeFile(join(producer, "index.js"), '#!/usr/bin/env node\nconsole.log("retained-fixture")\n');
      const [npm, ...prefix] = await npmCommand();
      const [packed] = JSON.parse(await run(npm, [...prefix, "pack", "--ignore-scripts", "--json"], { env, cwd: producer }));
      const archive = join(producer, packed.filename), bytes = await readFile(archive);
      const installed = await packedInstall(consumer, env, archive);
      expect(installed.manifest.version).toBe("99.0.0-fixture");
      expect(installed.integrity).toBe("sha512-" + createHash("sha512").update(bytes).digest("base64"));
      expect(await readFile(archive)).toEqual(bytes); expect(await readFile(installed.archive)).toEqual(bytes);
      expect((await run(process.execPath, [installed.executable], { env })).trim()).toBe("retained-fixture");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});

function diagnostic(configured: boolean) {
  return { schemaVersion: 1, ready: configured, checks: ["node", "configuration", "backend", "authentication", "supported_version", "project_access", "lifecycle"].map(id => ({ id, status: "pass" })).concat([
    { id: "provider_configuration", status: configured ? "pass" : "fail", message: configured ? "Provider configured" : "No configured provider was found." } as any,
  ]), backend: { version: "2.0.6", integrationTargetVersion: "2.0.6", matchesIntegrationTarget: true, processOwnership: "external", connectionSource: "explicit", survivesDisconnect: true } };
}
describe("native doctor contract assertions", () => {
  it.each([false, true])("accepts accurate readiness when configured=%s", configured => {
    expect(assertDoctorResult({ stdout: JSON.stringify(diagnostic(configured)), stderr: "", code: configured ? 0 : 1 }, targets.v2)).toEqual({ ready: configured, providerConfigured: configured });
  });
  it("rejects provider read failures, mismatched readiness, and credential output", () => {
    const report = diagnostic(false); report.checks.at(-1)!.message = "Provider configuration could not be read.";
    expect(() => assertDoctorResult({ stdout: JSON.stringify(report), stderr: "", code: 1 }, targets.v2)).toThrow();
    expect(() => assertDoctorResult({ stdout: JSON.stringify(diagnostic(false)), stderr: "", code: 0 }, targets.v2)).toThrow();
    expect(() => assertDoctorResult({ stdout: JSON.stringify(diagnostic(false)), stderr: "private-fixture", code: 1 }, targets.v2, ["private-fixture"])).toThrow();
  });
  it("derives configuration from native connected providers and matching integration connections", () => {
    expect(configuredProviderEvidence(targets.v1, new Map([["/provider", { connected: [] }]]))).toBe(false);
    expect(configuredProviderEvidence(targets.v1, new Map([["/provider", { connected: ["free-provider"] }]]))).toBe(true);
    const response = new Map([["/api/provider", { data: [{ id: "p", integrationID: "i" }] }], ["/api/integration", { data: [{ id: "other", connections: [{}] }] }]]);
    expect(configuredProviderEvidence(targets.v2, response)).toBe(false);
    response.set("/api/integration", { data: [{ id: "i", connections: [{}] }] });
    expect(configuredProviderEvidence(targets.v2, response)).toBe(true);
  });
});

import { safeFailureDetails } from "../scripts/test-compat.mjs";
describe("safe native failure classification", () => {
  it("classifies nested transport failures and process status without emitting messages", () => {
    expect(safeFailureDetails({ name: "TypeError", message: "secret-sentinel", cause: { code: "UND_ERR_SOCKET", message: "secret-sentinel" } }, { child: { exitCode: null, signalCode: null } })).toEqual({ name: "TypeError", code: "UND_ERR_SOCKET", backendExitCode: null, backendSignal: null });
  });
  it("allows only known names, codes, signals and numeric exit status", () => {
    expect(safeFailureDetails({ name: "secret-sentinel", code: "secret-sentinel" }, { child: { exitCode: "secret-sentinel", signalCode: "secret-sentinel" } })).toEqual({ backendExitCode: null, backendSignal: null });
    expect(safeFailureDetails({ name: "Error", code: "ESRCH" }, { child: { exitCode: 1, signalCode: "SIGTERM" } })).toEqual({ name: "Error", code: "ESRCH", backendExitCode: 1, backendSignal: "SIGTERM" });
  });
});
