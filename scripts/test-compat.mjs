#!/usr/bin/env node

// Real, isolated native backends. Never discovers/reuses a user's server.
// Default execution is model-free. All temporary installs/state are removed.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, connect } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, open, chmod, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, delimiter } from "node:path";
import { pathToFileURL } from "node:url";
import { repository, isolatedEnvironment, npmCommand, run, childProcess, stopProcess,
  rpcConnection, packedInstall, packageOptions } from "./test-package.mjs";

// Windows cannot directly spawn a JavaScript shebang launcher. Resolve only
// the installed package's declared executable and preserve its native children.
export async function executableCommand(binary) {
  const file = await open(binary, "r");
  try {
    const buffer = Buffer.alloc(256); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0];
    return /^#!.*\bnode(?:\s|$)/.test(firstLine) ? [process.execPath, binary] : [binary];
  } finally { await file.close(); }
}
async function assertPortClosed(port) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const closed = await new Promise((resolve) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(false); });
      socket.once("error", error => { socket.destroy(); resolve(error.code === "ECONNREFUSED"); });
      socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
    });
    if (closed) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Isolated backend port remained open after process-tree cleanup");
}

export const targets = Object.freeze({
  v1: { package: "opencode-ai", version: "1.18.31", health: "/global/health" },
  v2: { package: "@opencode/cli", version: "2.0.6", health: "/api/info" },
});

export function compatibilityOptions(argv) {
  const options = { backend: "all", inference: false, credentialEnv: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--inference") { options.inference = true; continue; }
    if (!["--backend", "--provider", "--model", "--credential-env", "--archive"].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--archive") {
      if (options.archive !== undefined) throw new Error("--archive may only be provided once");
      options.archive = packageOptions(["--archive", value]).archive;
    }
    else if (flag === "--credential-env") options.credentialEnv.push(value);
    else options[flag.slice(2)] = value;
  }
  if (!["all", "v1", "v2"].includes(options.backend)) throw new Error("--backend must be all, v1, or v2");
  if (options.inference && (!options.provider || !options.model)) throw new Error("--inference requires explicit --provider and --model");
  if (!options.inference && (options.provider || options.model || options.credentialEnv.length)) {
    throw new Error("Provider, model, and credential options require --inference");
  }
  for (const key of options.credentialEnv) {
    if (!/^[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|ACCESS_KEY_ID|ACCESS_KEY)$/.test(key)) {
      throw new Error("--credential-env must name a provider credential variable, not runtime/configuration settings");
    }
    if (!process.env[key]) throw new Error(`Credential environment variable ${key} is empty`);
  }
  return options;
}

async function unusedPort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

const failurePhases = new WeakMap();
const failureDiagnostics = new WeakMap();
function withFailurePhase(error, phase) {
  const value = error && typeof error === "object" ? error : new Error("Compatibility operation failed");
  if (!failurePhases.has(value)) failurePhases.set(value, phase);
  return value;
}
export function safeFailureDetails(error, processInfo) {
  const names = new Set(["Error", "TypeError", "AssertionError", "TimeoutError", "AbortError", "SystemError"]);
  const codes = new Set(["ERR_ASSERTION", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ENOTFOUND", "ETIMEDOUT", "ESRCH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "ERR_STREAM_PREMATURE_CLOSE"]);
  const signals = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV"]);
  const result = {};
  if (names.has(error?.name)) result.name = error.name;
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++, current = current.cause) {
    if (codes.has(current.code)) { result.code = current.code; break; }
  }
  if (processInfo) {
    result.backendExitCode = Number.isInteger(processInfo.child.exitCode) ? processInfo.child.exitCode : null;
    result.backendSignal = signals.has(processInfo.child.signalCode) ? processInfo.child.signalCode : null;
  }
  return result;
}
function captureFailure(error, phase, backend) {
  const value = withFailurePhase(error, phase);
  if (!failureDiagnostics.has(value)) failureDiagnostics.set(value, safeFailureDetails(value, backend));
  return value;
}
export function compatibilityErrorSummary(error) {
  const phase = error && typeof error === "object" ? failurePhases.get(error) : undefined;
  const detail = phase ? `Phase: ${phase}. ` : "";
  return detail + failureSummary(error);
}
function failureSummary(error) {
  if (error?.code === "BACKEND_AUTHENTICATION") return "The isolated server rejected its configured authentication. Raw diagnostics are omitted.";
  if (error?.code === "BACKEND_STARTUP") return "The isolated server exited before readiness. Raw diagnostics are omitted.";
  if (error?.code === "BACKEND_TIMEOUT") return "The isolated server did not become ready before its deadline. Raw diagnostics are omitted.";
  if (error?.code === "ERR_ASSERTION") return "A compatibility assertion failed. Raw responses and diagnostics are omitted.";
  return "A compatibility operation failed. Raw responses and diagnostics are omitted.";
}
/** V2's documented foreground discovery line; keep the extracted value in memory. */
export function ownedServerPassword(stdout) {
  const plain = stdout.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  return plain.match(/^\s*server password\s+(\S+)\s*$/m)?.[1];
}
export async function waitForBackend(processInfo, baseUrl, target, headers, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processInfo.child.exitCode !== null || processInfo.child.signalCode !== null) {
      throw Object.assign(new Error("Isolated backend exited during startup."), { code: "BACKEND_STARTUP" });
    }
    try {
      const authentication = typeof headers === "function" ? headers() : headers;
      if (!authentication) { await new Promise(done => setTimeout(done, 150)); continue; }
      const response = await fetch(baseUrl + target.health, { headers: authentication, redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(1500, deadline - Date.now()))) });
      if (response.status === 401 || response.status === 403) throw Object.assign(new Error("Isolated backend authentication failed."), { code: "BACKEND_AUTHENTICATION" });
      if (response.ok) {
        const body = await response.json();
        assert.equal(body.version, target.version, "Backend runtime identity must match pinned package version");
        return body;
      }
    } catch (error) { if (error.code === "ERR_ASSERTION" || error.code === "BACKEND_AUTHENTICATION") throw error; }
    await new Promise((done) => setTimeout(done, 150));
  }
  throw Object.assign(new Error("Isolated backend readiness timed out."), { code: "BACKEND_TIMEOUT" });
}

/** Assert only public diagnostic fields; never interpolate doctor output into errors. */
export function assertDoctorResult(result, target, secrets = []) {
  const output = result.stdout + result.stderr;
  assert.ok(secrets.filter(Boolean).every(value => !output.includes(value)), "Doctor output leaked an isolated credential");
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  const checks = new Map(report.checks.map(check => [check.id, check]));
  for (const id of ["node", "configuration", "backend", "authentication", "supported_version", "project_access", "lifecycle"]) {
    assert.equal(checks.get(id)?.status, "pass", `Doctor ${id} must pass against the isolated native server`);
  }
  const provider = checks.get("provider_configuration");
  // A free/built-in provider may be configured without supplied credentials.
  // A failed provider read is not equivalent to successfully reading an empty list.
  assert.ok(provider?.status === "pass" || provider?.status === "fail" && provider.message === "No configured provider was found.", "Doctor must distinguish absent providers from failed provider reads");
  const ready = provider.status === "pass";
  assert.equal(report.ready, ready); assert.equal(result.code, ready ? 0 : 1);
  assert.equal(report.backend?.version, target.version);
  assert.equal(report.backend?.integrationTargetVersion, target.version);
  assert.equal(report.backend?.matchesIntegrationTarget, true);
  assert.equal(report.backend?.processOwnership, "external");
  assert.equal(report.backend?.connectionSource, "explicit");
  assert.equal(report.backend?.survivesDisconnect, true);
  return { ready, providerConfigured: ready };
}

export function configuredProviderEvidence(target, responses) {
  if (target === targets.v1) {
    const value = responses.get("/provider");
    assert.ok(Array.isArray(value?.connected), "Native V1 provider response must contain connected IDs");
    return value.connected.length > 0;
  }
  const providers = responses.get("/api/provider")?.data;
  const integrations = responses.get("/api/integration")?.data;
  assert.ok(Array.isArray(providers) && Array.isArray(integrations), "Native V2 provider/integration responses must be available");
  return providers.some(provider => integrations.some(integration => integration.id === provider.integrationID && Array.isArray(integration.connections) && integration.connections.length > 0));
}

async function checkDoctor(installed, target, env, credentials, project, workspace, baseUrl) {
  const requests = [], responses = new Map();
  // Only this doctor subprocess uses the proxy. A mutation is recorded and
  // rejected before reaching the real server, so the verification stays read-only.
  const proxy = createHttpServer(async (req, res) => {
    requests.push({ method: req.method, path: req.url });
    if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405); res.end(); return; }
    try {
      const response = await fetch(baseUrl + req.url, { method: req.method, redirect: "manual",
        headers: req.headers.authorization ? { Authorization: req.headers.authorization } : {}, signal: AbortSignal.timeout(16000) });
      const body = Buffer.from(await response.arrayBuffer());
      const path = new URL(req.url, "http://fixture").pathname;
      if (["/provider", "/api/provider", "/api/integration"].includes(path) && response.ok) responses.set(path, JSON.parse(body.toString()));
      res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" });
      res.end(body);
    } catch { if (res.headersSent) res.destroy(); else { res.writeHead(502); res.end(); } }
  });
  let doctor;
  const sentinel = join(workspace, "doctor-bin"), invoked = join(sentinel, "invoked");
  await mkdir(sentinel);
  const script = join(sentinel, "sentinel.cjs");
  await writeFile(script, `require("node:fs").writeFileSync(${JSON.stringify(invoked)}, "startup attempted");process.exit(99);`);
  await writeFile(join(sentinel, "opencode"), `#!${process.execPath}\n` + await readFile(script, "utf8"));
  await chmod(join(sentinel, "opencode"), 0o755);
  await writeFile(join(sentinel, "opencode.cmd"), `@"${process.execPath}" "${script}"\r\n`);
  try {
    await new Promise((done, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", done); });
    const endpoint = `http://127.0.0.1:${proxy.address().port}`;
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH";
    doctor = childProcess(process.execPath, [installed.executable, "doctor", "--json", "--directory", project], { cwd: project,
      env: { ...env, ...credentials, [pathKey]: [sentinel, dirname(process.execPath)].join(delimiter), OPENCODE_BASE_URL: endpoint,
        OPENCODE_BACKEND: "auto", OPENCODE_AUTO_SERVE: "true" }, ownedProcessGroup: true });
    let timer;
    try {
      const result = await Promise.race([doctor.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Doctor deadline exceeded")), 20000); })]);
      const secret = credentials.OPENCODE_SERVER_PASSWORD;
      const report = assertDoctorResult({ ...result, stdout: doctor.stdout, stderr: doctor.stderr }, target,
        [secret, Buffer.from(`opencode:${secret}`).toString("base64")]);
      assert.equal(report.providerConfigured, configuredProviderEvidence(target, responses), "Doctor readiness must match native provider configuration evidence");
      assert.ok(requests.length > 0 && requests.every(request => ["GET", "HEAD"].includes(request.method)), "Doctor must make only read requests");
      await assert.rejects(access(invoked), { code: "ENOENT" });
      return { ...report, readRequests: requests.length, startupAttempted: false, mutations: 0 };
    } finally { clearTimeout(timer); }
  } finally {
    if (doctor) await stopProcess(doctor);
    proxy.closeAllConnections(); await new Promise(done => proxy.close(done));
  }
}

const textOf = (result) => (result.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
const sessionIdOf = (result) => result.structuredContent?.sessionId ?? result.structuredContent?.session?.id
  ?? result.structuredContent?.data?.id ?? textOf(result).match(/^ID: (\S+)$/m)?.[1];

async function checkBackend(kind, root, installed, options) {
  let phase = "fixture-setup";
  try {
  const target = targets[kind];
  const workspace = join(root, kind);
  await mkdir(workspace, { recursive: true });
  const env = await isolatedEnvironment(workspace);
  const installation = join(workspace, "installation"), project = join(workspace, "project");
  await mkdir(installation); await mkdir(project);
  await writeFile(join(installation, "package.json"), JSON.stringify({ private: true, name: `compat-${kind}` }));
  const marker = `opencode-mcp-live-${kind}-${target.version}`;
  await writeFile(join(project, "README.md"), `${marker}\n`);
  // Explicit config lives only inside this disposable project/home.
  await writeFile(join(project, "opencode.json"), JSON.stringify(kind === "v1"
    ? { permission: "deny", autoupdate: false, plugin: [] }
    : { permissions: [{ action: "*", resource: "*", effect: "deny" }], update: "disable", warming: false, plugins: [] }));
  await run("git", ["-c", "init.templateDir=", "init", "--quiet", project], { env, cwd: workspace });
  await run("git", ["-C", project, "add", "README.md", "opencode.json"], { env, cwd: workspace });
  await run("git", ["-C", project, "-c", "user.name=Compatibility Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=", "commit", "--quiet", "-m", "Isolated compatibility fixture"], { env, cwd: workspace });
  console.log(`Installing isolated ${target.package}@${target.version} (${process.platform}/${process.arch}, Node ${process.version})`);
  phase = "native-install";
  await run(installed.npm, [...installed.prefix, "install", "--omit=dev", "--no-audit", "--no-fund", "--save-exact",
    `${target.package}@${target.version}`], { env, cwd: installation }, 240_000);
  await rm(join(workspace, "npm-cache"), { recursive: true, force: true });
  const packageRoot = join(installation, "node_modules", target.package);
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.version, target.version);
  const binary = join(packageRoot, manifest.bin.opencode);
  const [command, ...commandPrefix] = await executableCommand(binary);
  phase = "native-version";
  const reported = (await run(command, [...commandPrefix, "--version"], { env, cwd: project }, 30_000)).trim();
  assert.ok(reported.split(/\s+/).some(token => token.replace(/^v/, "") === target.version), `Unexpected executable version: ${reported}`);
  const port = await unusedPort(), baseUrl = `http://127.0.0.1:${port}`;
  let password = kind === "v1" ? randomBytes(32).toString("hex") : undefined;
  const credentials = password ? { OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password } : {};
  let headers = password ? { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : undefined;
  const backendEnv = { ...env, ...credentials };
  if (options.inference) for (const key of options.credentialEnv) backendEnv[key] = process.env[key];
  // `serve` starts the explicitly owned headless process; never invoke the
  // default TUI/shared-service startup or install a global executable.
  phase = "backend-launch";
  const backend = childProcess(command, [...commandPrefix, "serve", "--hostname", "127.0.0.1", "--port", String(port)], { env: backendEnv, cwd: project, ownedProcessGroup: true });
  let connection;
  const ownedSessions = new Set(), checks = [];
  let failure;
  try {
    phase = "backend-readiness";
    await waitForBackend(backend, baseUrl, target, () => {
      if (kind === "v2" && !password) {
        password = ownedServerPassword(backend.stdout);
        if (password) {
          credentials.OPENCODE_SERVER_USERNAME = "opencode";
          credentials.OPENCODE_SERVER_PASSWORD = password;
          headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
        }
      }
      return headers;
    });
    checks.push("native executable and HTTP runtime version");
    phase = "doctor-json";
    const doctor = await checkDoctor(installed, target, env, credentials, project, workspace, baseUrl);
    assert.equal(backend.child.exitCode, null, "Doctor must leave the owned native server running");
    checks.push("archive doctor JSON/read-only readiness/no startup/no credential disclosure");
    connection = rpcConnection(process.execPath, [installed.executable], { cwd: project, env: {
      ...env, ...credentials, OPENCODE_BASE_URL: baseUrl, OPENCODE_BACKEND: "auto", OPENCODE_TOOL_PROFILE: "full",
    } });
    phase = "mcp-initialize";
    await connection.initialize();
    const call = (name, input = {}, timeout) => { phase = `tool:${name}`; return connection.call(name, input, timeout); };
    phase = "mcp-catalog";
    const catalog = await connection.request("tools/list");
    assert.ok(catalog.tools.some((tool) => tool.name === "opencode_session_create"));
    await call("opencode_health");
    for (const name of ["opencode_project_current", "opencode_path_get", "opencode_agent_list", "opencode_config_get"]) {
      await call(name, { directory: project });
    }
    const file = await call("opencode_file_read", { path: "README.md", directory: project });
    assert.ok(textOf(file).includes(marker), "Remote file read must return the disposable project's marker");
    checks.push("archive stdio initialize/catalog/health/project/path/agents/config/file");
    const created = await call("opencode_session_create", { title: "Compatibility fixture", directory: project });
    const sessionId = sessionIdOf(created);
    assert.equal(typeof sessionId, "string", "Session creation must return a stable ID");
    ownedSessions.add(sessionId);
    await call("opencode_session_get", { id: sessionId, directory: project });
    await call("opencode_session_update", { id: sessionId, title: "Updated compatibility fixture", directory: project });
    const updated = await call("opencode_session_get", { id: sessionId, directory: project });
    assert.ok(textOf(updated).includes("Updated compatibility fixture"));
    const sessions = await call("opencode_session_list", { directory: project });
    assert.ok(JSON.stringify(sessions).includes(sessionId));
    await call("opencode_session_delete", { id: sessionId, directory: project });
    ownedSessions.delete(sessionId);
    checks.push("model-free session create/get/update/list/delete");
    if (options.inference) {
      // Deny every model tool action; only a text response is requested.
      const answer = await call("opencode_ask", { prompt: "Reply with exactly: compatibility-ok. Do not use tools.",
        providerID: options.provider, modelID: options.model, directory: project }, 180_000);
      const inferredSession = sessionIdOf(answer);
      if (inferredSession) ownedSessions.add(inferredSession);
      assert.match(textOf(answer), /compatibility-ok/);
      checks.push(`explicit inference ${options.provider}/${options.model}`);
    }
    for (const id of ownedSessions) await call("opencode_session_delete", { id, directory: project });
    ownedSessions.clear();
    phase = "mcp-shutdown";
    await connection.close(); connection = undefined;
    phase = "backend-survival";
    assert.equal((await fetch(baseUrl + target.health, { headers, redirect: "error", signal: AbortSignal.timeout(3000) })).ok, true,
      "Closing the bridge must leave its externally owned backend alive");
    checks.push("bridge clean shutdown and backend ownership");
    return { backend: kind, package: target.package, version: target.version, evidence: "live isolated native backend + installed archive",
      status: "passed", checks, doctor, skips: ["Durable jobs, input forms/permissions, revert and model execution recovery: fixture coverage only", "Interactive GUI clients and provider OAuth: not exercised", ...(options.inference ? [] : ["Inference: not explicitly enabled", "Provider credentials: not supplied"])] };
  } catch (error) {
    failure = captureFailure(error, phase, backend);
    throw failure;
  } finally {
    try {
      if (connection) await stopProcess(connection.process);
      await stopProcess(backend);
      await assertPortClosed(port);
    } catch (error) {
      if (failure) failureDiagnostics.set(failure, { ...failureDiagnostics.get(failure), cleanup: safeFailureDetails(error, backend) });
      else throw captureFailure(error, "backend-cleanup", backend);
    }
  }
  } catch (error) { throw withFailurePhase(error, phase); }
}

export async function compatibilityCheck(options) {
  if (options.archive !== undefined) packageOptions(["--archive", options.archive]);
  const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-compat-")));
  const results = [];
  let phase = "fixture-setup";
  try {
    const env = await isolatedEnvironment(root);
    const [npm, ...prefix] = await npmCommand();
    if (!options.archive) {
      phase = "build";
      await run(npm, [...prefix, "run", "build"], { env, cwd: repository });
    }
    phase = "archive-install";
    const installed = await packedInstall(root, env, options.archive);
    for (const kind of options.backend === "all" ? ["v1", "v2"] : [options.backend]) {
      try { results.push(await checkBackend(kind, root, installed, options)); }
      catch (error) { results.push({ backend: kind, ...targets[kind], status: "failed", error: compatibilityErrorSummary(error), diagnostics: failureDiagnostics.get(error) ?? safeFailureDetails(error) }); }
      finally { await rm(join(root, kind), { recursive: true, force: true }); }
    }
    const report = { check: "compatibility", packageVersion: installed.manifest.version,
      archive: installed.sourceArchive, integrity: installed.integrity,
      node: process.version, platform: process.platform, architecture: process.arch, results };
    let serialized = JSON.stringify(report, null, 2);
    for (const key of options.credentialEnv) serialized = serialized.replaceAll(process.env[key], "[REDACTED]");
    console.log(serialized);
    phase = "compatibility-results";
    assert.ok(results.every((result) => result.status === "passed"), "One or more pinned live backend checks failed (see report)");
    return report;
  } catch (error) { throw withFailurePhase(error, phase); }
  finally { await rm(root, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  Promise.resolve().then(() => compatibilityCheck(compatibilityOptions(process.argv.slice(2)))).catch((error) => {
    console.error(`Compatibility verification FAILED: ${compatibilityErrorSummary(error)}`); process.exitCode = 1;
  });
}
