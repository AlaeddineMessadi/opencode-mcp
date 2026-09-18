#!/usr/bin/env node

// Exercise the published archive, without importing repository/dev dependencies.
// Helpers are shared with test-compat; importing this module does not run checks.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm, access, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repository = fileURLToPath(new URL("../", import.meta.url));
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

export async function isolatedEnvironment(root) {
  // Deliberately allowlist inherited OS necessities. No provider credentials,
  // user npm config, OpenCode settings, NODE_OPTIONS, or shared-service settings.
  const env = {};
  const allowed = new Set(["path", "systemroot", "windir", "comspec", "pathext", "lang", "lc_all"]);
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key.toLowerCase()) && value !== undefined) env[key] = value;
  }
  for (const dir of ["home", "config", "data", "state", "cache", "tmp", "npm-cache", "appdata", "localappdata"]) {
    await mkdir(join(root, dir), { recursive: true });
  }
  const npmrc = join(root, "npmrc");
  await writeFile(npmrc, "");
  const globalNpmrc = join(root, "npmrc-global");
  await writeFile(globalNpmrc, "");
  return { ...env, HOME: join(root, "home"), USERPROFILE: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
    APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "localappdata"),
    TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
    npm_config_userconfig: npmrc, npm_config_globalconfig: globalNpmrc,
    npm_config_cache: join(root, "npm-cache"), npm_config_update_notifier: "false",
    OPENCODE_AUTO_SERVE: "false", OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_TASK_STORE: join(root, "jobs"),
    CI: "true", NO_COLOR: "1" };
}

export async function npmCommand() {
  const candidates = [process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")].filter(Boolean);
  for (const candidate of candidates) {
    if (!candidate.endsWith("npm-cli.js")) continue;
    try { await access(candidate); return [process.execPath, candidate]; } catch { /* next layout */ }
  }
  // Resolve the installed npm entry without executing a shell (also works on Windows).
  for (const part of (process.env.PATH ?? process.env.Path ?? "").split(process.platform === "win32" ? ";" : ":")) {
    for (const candidate of [join(part, "npm"), join(part, "node_modules/npm/bin/npm-cli.js")]) {
      try {
        const target = await realpath(candidate);
        if (target.endsWith("npm-cli.js")) return [process.execPath, target];
      } catch { /* next PATH entry */ }
    }
  }
  throw new Error("Cannot locate npm-cli.js; run this check through npm run test:package or npm run test:compat");
}

export function childProcess(command, args, options) {
  const { ownedProcessGroup = false, ...spawnOptions } = options ?? {};
  const child = spawn(command, args, { ...spawnOptions, ...(ownedProcessGroup && process.platform !== "win32" ? { detached: true } : {}), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-100_000); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-100_000); });
  const exited = new Promise((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => done({ code, signal }));
  });
  // Attach a rejection handler now, even when a caller first waits for readiness.
  exited.catch(() => {});
  return { child, exited, ownedProcessGroup, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

export async function stopProcess(processInfo) {
  if (processInfo.stopped) return;
  const { child, exited } = processInfo;
  if (processInfo.ownedProcessGroup && child.pid) {
    // Only explicitly isolated children have their own process group. This
    // handles launchers whose native child outlives the JavaScript wrapper.
    if (process.platform === "win32") {
      const killer = childProcess("taskkill", ["/pid", String(child.pid), "/t", "/f"], {});
      await killer.exited;
    } else {
      const alive = () => { try { process.kill(-child.pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
      if (alive()) process.kill(-child.pid, "SIGTERM");
      const deadline = Date.now() + 3000;
      while (alive() && Date.now() < deadline) await delay(50);
      if (alive()) process.kill(-child.pid, "SIGKILL");
    }
    await exited;
    processInfo.stopped = true;
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  if (await Promise.race([exited.then(() => true), delay(1500).then(() => false)])) return;
  child.kill("SIGTERM");
  if (await Promise.race([exited.then(() => true), delay(3000).then(() => false)])) return;
  if (process.platform === "win32") {
    const killer = childProcess("taskkill", ["/pid", String(child.pid), "/t", "/f"], {});
    await killer.exited;
  } else child.kill("SIGKILL");
  await exited;
}

export async function run(command, args, options = {}, timeoutMs = 120_000) {
  const p = childProcess(command, args, options);
  let timer;
  try {
    const result = await Promise.race([p.exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Command timed out: ${args[0] ?? command}`)), timeoutMs);
    })]);
    assert.equal(result.code, 0, `Command failed (${result.code ?? result.signal}): ${p.stderr.slice(-3000)}\n${p.stdout.slice(-1000)}`);
    return p.stdout;
  } finally { clearTimeout(timer); await stopProcess(p); }
}

export function rpcConnection(command, args, options = {}) {
  const p = childProcess(command, args, options);
  const pending = new Map();
  let nextId = 0, buffer = "", protocolError;
  function rejectPending(error) {
    for (const handler of pending.values()) { clearTimeout(handler.timer); handler.reject(error); }
    pending.clear();
  }
  p.child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { protocolError = new Error("Executable wrote non-JSON text to MCP stdout"); rejectPending(protocolError); continue; }
      const handler = pending.get(message.id);
      if (!handler) continue;
      clearTimeout(handler.timer); pending.delete(message.id);
      if (message.error) handler.reject(new Error(`MCP ${handler.method} failed: ${JSON.stringify(message.error)}`));
      else handler.resolve(message.result);
    }
  });
  p.exited.then(() => rejectPending(new Error(`MCP executable exited: ${p.stderr.slice(-1500)}`)), rejectPending);
  const notify = (method, params = {}) => p.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return {
    process: p,
    notify,
    async request(method, params = {}, timeoutMs = 15_000) {
      if (protocolError) throw protocolError;
      if (p.child.exitCode !== null || p.child.signalCode !== null) throw new Error("MCP executable already exited");
      const id = ++nextId;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out: ${p.stderr.slice(-1000)}`)); }, timeoutMs);
        pending.set(id, { resolve, reject, timer, method });
      });
      p.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return response;
    },
    async initialize() {
      const info = await this.request("initialize", { protocolVersion: "2025-11-25", capabilities: {},
        clientInfo: { name: "opencode-mcp-release-check", version: "1.0.0" } });
      assert.equal(info.serverInfo.name, "opencode-mcp");
      notify("notifications/initialized");
      return info;
    },
    async call(name, args = {}, timeoutMs) {
      const result = await this.request("tools/call", { name, arguments: args }, timeoutMs);
      assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result)}`);
      return result;
    },
    async close() {
      p.child.stdin.end();
      let timer;
      try {
        const result = await Promise.race([p.exited, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("MCP executable failed to exit after stdin EOF")), 8000);
        })]);
        assert.equal(result.code, 0, "MCP executable must exit cleanly");
        assert.equal(protocolError, undefined);
        assert.equal(buffer.trim(), "", "MCP stdout ended with an incomplete frame");
      } finally { clearTimeout(timer); await stopProcess(p); }
    },
  };
}

export function packageOptions(argv) {
  if (argv.length === 0) return {};
  if (argv.length !== 2 || argv[0] !== "--archive") throw new Error("Usage: test-package.mjs [--archive /absolute/path.tgz]");
  if (!isAbsolute(argv[1]) || !argv[1].toLowerCase().endsWith(".tgz")) throw new Error("--archive must name an absolute .tgz file path");
  return { archive: argv[1] };
}

export async function packedInstall(root, env, suppliedArchive) {
  const [npm, ...prefix] = await npmCommand();
  const archiveDir = join(root, "archive"), consumer = join(root, "consumer");
  await mkdir(archiveDir, { recursive: true }); await mkdir(consumer, { recursive: true });
  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "opencode-mcp-release-consumer", private: true }));
  let archive, sourceArchive;
  if (suppliedArchive !== undefined) {
    packageOptions(["--archive", suppliedArchive]);
    sourceArchive = await realpath(suppliedArchive);
    assert.ok((await stat(sourceArchive)).isFile(), "--archive must be a regular file");
    // Capture the exact bytes once; npm reads this isolated immutable candidate.
    archive = join(archiveDir, "candidate.tgz");
    await writeFile(archive, await readFile(sourceArchive), { flag: "wx", mode: 0o600 });
  } else {
    const packed = JSON.parse(await run(npm, [...prefix, "pack", "--ignore-scripts", "--json", "--pack-destination", archiveDir], { cwd: repository, env }));
    assert.equal(packed.length, 1);
    archive = join(archiveDir, packed[0].filename);
  }
  const integrity = "sha512-" + createHash("sha512").update(await readFile(archive)).digest("base64");
  await run(npm, [...prefix, "install", "--omit=dev", "--no-audit", "--no-fund", archive], { cwd: consumer, env }, 180_000);
  const manifest = JSON.parse(await readFile(join(consumer, "node_modules/opencode-mcp/package.json"), "utf8"));
  assert.equal(manifest.name, "opencode-mcp", "Archive must contain the opencode-mcp package");
  const executable = join(consumer, "node_modules/opencode-mcp", manifest.bin["opencode-mcp"]);
  await access(executable);
  await access(join(consumer, "node_modules/.bin", process.platform === "win32" ? "opencode-mcp.cmd" : "opencode-mcp"));
  // Assert dev-only packages are not installed at the consumer root.
  for (const dependency of ["vitest", "typescript"]) {
    await assert.rejects(access(join(consumer, "node_modules", dependency)));
  }
  return { manifest, archive, sourceArchive, integrity, consumer, executable, npm, prefix };
}

export async function packageCheck(options = {}) {
  if (options.archive !== undefined) packageOptions(["--archive", options.archive]);
  const root = await mkdtemp(join(tmpdir(), "opencode-package-"));
  let fixture, connection;
  try {
    const env = await isolatedEnvironment(root);
    const [npm, ...prefix] = await npmCommand();
    if (!options.archive) await run(npm, [...prefix, "run", "build"], { cwd: repository, env });
    const installed = await packedInstall(root, env, options.archive);
    const execArgs = [...prefix, "exec", "--offline", "--", "opencode-mcp"];
    const help = await run(npm, [...execArgs, "--help"], { cwd: installed.consumer, env }, 10_000);
    assert.match(help, /opencode-mcp/i);
    const version = await run(npm, [...execArgs, "--version"], { cwd: installed.consumer, env }, 10_000);
    assert.ok(version.includes(installed.manifest.version), "--version must match archive package.json");
    const seen = [];
    fixture = createServer((req, res) => {
      const path = new URL(req.url, "http://fixture").pathname;
      seen.push(`${req.method} ${path}`);
      res.setHeader("content-type", "application/json");
      if (path === "/global/health") res.end(JSON.stringify({ healthy: true, version: "1.18.31" }));
      else if (path === "/session" && req.method === "POST") res.end(JSON.stringify({ id: "ses_archive_fixture", title: "Archive fixture" }));
      else if (path === "/session/ses_archive_fixture" && req.method === "DELETE") res.end("true");
      else { res.statusCode = 404; res.end('{"error":"unknown fixture route"}'); }
    });
    await new Promise((done) => fixture.listen(0, "127.0.0.1", done));
    const baseUrl = `http://127.0.0.1:${fixture.address().port}`;
    connection = rpcConnection(npm, execArgs, { cwd: installed.consumer, env: { ...env,
      OPENCODE_BASE_URL: baseUrl, OPENCODE_BACKEND: "auto", OPENCODE_TOOL_PROFILE: "full" } });
    const initialized = await connection.initialize();
    assert.equal(initialized.serverInfo.version, installed.manifest.version);
    const catalog = await connection.request("tools/list");
    assert.ok(catalog.tools.some((tool) => tool.name === "opencode_health"));
    assert.ok(catalog.tools.some((tool) => tool.name === "opencode_session_create"));
    const health = await connection.call("opencode_health");
    assert.match(JSON.stringify(health), /1\.18\.31/);
    const created = await connection.call("opencode_session_create", { title: "Archive fixture" });
    assert.equal(created.structuredContent.sessionId, "ses_archive_fixture");
    await connection.call("opencode_session_delete", { id: "ses_archive_fixture" });
    await connection.close(); connection = undefined;
    assert.ok(seen.includes("POST /session")); assert.ok(seen.includes("DELETE /session/ses_archive_fixture"));
    assert.equal((await fetch(`${baseUrl}/global/health`)).ok, true, "MCP shutdown must leave externally owned backends alive");
    console.log(JSON.stringify({ check: "package", evidence: "actual archive; production install; fixture backend", status: "passed",
      packageVersion: installed.manifest.version, archive: installed.sourceArchive, integrity: installed.integrity, node: process.version, platform: process.platform,
      toolCount: catalog.tools.length, checks: ["npm executable help/version", "initialize", "tools/list", "fixture health/create/delete", "stdin EOF shutdown"] }, null, 2));
  } finally {
    if (connection) await stopProcess(connection.process);
    if (fixture) { fixture.closeAllConnections(); await new Promise((done) => fixture.close(done)); }
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  Promise.resolve().then(() => packageCheck(packageOptions(process.argv.slice(2)))).catch((error) => { console.error(`Package verification FAILED: ${error.message}`); process.exitCode = 1; });
}
