#!/usr/bin/env node

// Live smoke checks. Import runSmoke for deterministic injected-client tests.
// The legacy client deliberately verifies interoperability with MCP v1 clients.
import process from "node:process";
import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const FIXTURE_MARKER = "opencode-mcp-smoke-fixture";
const textOf = (result) => (result?.content ?? [])
  .filter((part) => part.type === "text").map((part) => part.text).join("\n");

export function smokeOptions(argv = [], env = process.env) {
  const options = {
    baseUrl: env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096",
    inference: env.OPENCODE_TEST_INFERENCE === "true",
    providerID: env.OPENCODE_TEST_PROVIDER,
    modelID: env.OPENCODE_TEST_MODEL,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--inference") options.inference = true;
    else if (["--provider", "--model", "--base-url"].includes(argv[i])) {
      const key = { "--provider": "providerID", "--model": "modelID", "--base-url": "baseUrl" }[argv[i]];
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("Missing smoke option value");
      options[key] = argv[++i];
    } else throw new Error("Unknown smoke option");
  }
  if (options.inference && (!options.providerID?.trim() || !options.modelID?.trim())) {
    throw new Error("Inference requires --provider and --model (or OPENCODE_TEST_PROVIDER and OPENCODE_TEST_MODEL)");
  }
  const url = new URL(options.baseUrl);
  if (url.username || url.password) throw new Error("Use OPENCODE_SERVER_USERNAME/PASSWORD instead of URL credentials");
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Smoke checks require a local OpenCode server so a disposable project can be isolated on the same filesystem");
  }
  return options;
}

export function smokeEnvironment(options, env = process.env) {
  const childEnv = { OPENCODE_BASE_URL: options.baseUrl, OPENCODE_AUTO_SERVE: "false" };
  for (const key of ["OPENCODE_SERVER_USERNAME", "OPENCODE_SERVER_PASSWORD"]) {
    if (env[key] !== undefined) childEnv[key] = env[key];
  }
  return childEnv;
}

export async function createFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "opencode-mcp-smoke-")));
  try {
    await writeFile(join(directory, "README.md"), `${FIXTURE_MARKER}\n`);
    // Deny model tool use: inference checks only need a text response.
    await writeFile(join(directory, "opencode.json"), JSON.stringify({ permission: "deny" }));
    execFileSync("git", ["-c", "init.templateDir=", "init", "--quiet", directory], { stdio: "pipe" });
    execFileSync("git", ["-C", directory, "add", "README.md", "opencode.json"], { stdio: "pipe" });
    return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new Error("Could not create disposable smoke project (Git must be installed)");
  }
}

function createdSessionId(result) {
  if (result?.isError) return undefined;
  const structured = result?.structuredContent;
  const candidate = structured?.sessionId ?? structured?.data?.sessionId ?? structured?.data?.id ?? structured?.id;
  if (candidate !== undefined) return typeof candidate === "string" && /^ses_[A-Za-z0-9_-]+$/.test(candidate) ? candidate : undefined;
  // Legacy compatibility: ONLY the successful session_create response is parsed.
  const matches = [...textOf(result).matchAll(/^ID: (ses_[A-Za-z0-9_-]+)$/gm)];
  return matches.length === 1 ? matches[0][1] : undefined;
}

function completed(result) {
  const data = result?.structuredContent;
  const status = data?.status ?? data?.state ?? data?.data?.status;
  if (status !== undefined) return status === "completed";
  return /^Status: completed\b/m.test(textOf(result)) || /Session .* (?:is idle|completed)/i.test(textOf(result));
}

export async function runSmoke({ client, directory, inference = false, providerID, modelID }) {
  if (!directory) throw new Error("A disposable fixture directory is required");
  if (inference && (!providerID || !modelID)) throw new Error("Inference requires explicit provider and model");
  const results = [];
  const called = new Set();
  const owned = new Set();
  let listed = [];
  const record = (name, status, detail = "") => results.push({ name, status, detail });
  async function call(name, args = {}, validate) {
    called.add(name);
    try {
      const arguments_ = name === "opencode_project_init" ? args : { ...args, directory };
      const result = await client.callTool({ name, arguments: arguments_ }, undefined, { timeout: 180_000 });
      if (result?.isError) throw new Error("Tool returned isError");
      if (!textOf(result).trim() && !result?.structuredContent) throw new Error("Tool returned no content");
      if (validate && !validate(result)) throw new Error("Response did not satisfy the fixture assertion");
      record(name, "PASS");
      return result;
    } catch {
      // Do not echo responses/exceptions: they can contain server credentials/config.
      record(name, "FAIL", "Tool failed or its response did not satisfy the fixture assertion");
      return undefined;
    }
  }
  try {
    let cursor;
    const seen = new Set();
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      listed.push(...(page.tools ?? []));
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error("Repeated tools cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
    record("tools/list", listed.length ? "PASS" : "FAIL", `${listed.length} tools`);
    const healthy = await call("opencode_health", {}, (r) => /\bStatus: healthy\b/.test(textOf(r)) || r.structuredContent?.healthy === true || r.structuredContent?.data?.healthy === true);
    if (healthy) {
      await call("opencode_project_init", { path: directory });
      for (const name of ["opencode_project_current", "opencode_path_get", "opencode_vcs_info", "opencode_agent_list", "opencode_command_list", "opencode_provider_list", "opencode_provider_auth_methods", "opencode_config_providers", "opencode_file_status", "opencode_session_status"]) {
        await call(name);
      }
      await call("opencode_file_list", { path: "." }, (r) => textOf(r).includes("README.md"));
      await call("opencode_file_read", { path: "README.md" }, (r) => textOf(r).includes(FIXTURE_MARKER));
      await call("opencode_find_file", { query: "README.md" }, (r) => textOf(r).includes("README.md"));
      await call("opencode_find_text", { pattern: FIXTURE_MARKER }, (r) => textOf(r).includes(FIXTURE_MARKER) && !textOf(r).startsWith("No matches"));
      const created = await call("opencode_session_create", { title: "[mcp-smoke] disposable fixture" }, (r) => Boolean(createdSessionId(r)));
      const sessionId = createdSessionId(created);
      if (sessionId) {
        owned.add(sessionId);
        await call("opencode_session_get", { id: sessionId });
        await call("opencode_session_todo", { id: sessionId });
        await call("opencode_message_list", { sessionId });
        await call("opencode_conversation", { sessionId });
        await call("opencode_check", { sessionId });
        if (inference) {
          const args = { sessionId, prompt: "Reply with exactly SMOKE_OK. Do not use tools.", providerID, modelID };
          const fired = await call("opencode_fire", args);
          await call("opencode_check", { sessionId });
          const waited = fired && await call("opencode_wait", { sessionId, timeoutSeconds: 120 }, completed);
          // Never enqueue a second prompt while the first may still be running.
          if (waited) await call("opencode_run", { ...args, maxDurationSeconds: 120 }, completed);
        }
      }
    }
  } catch {
    record("smoke", "FAIL", "MCP discovery or smoke execution failed");
  } finally {
    for (const sessionId of owned) {
      // Abort before deleting: timeout/cancellation must not leave inference running.
      if (inference) await call("opencode_session_abort", { id: sessionId });
      await call("opencode_session_delete", { id: sessionId });
    }
    for (const tool of listed) {
      if (!called.has(tool.name)) {
        const reason = ["opencode_run", "opencode_fire", "opencode_wait"].includes(tool.name)
          ? (inference ? "Prerequisite failed; inference was not dispatched" : "Inference is disabled; use --inference with an explicit provider and model")
          : "Outside the disposable fixture checks; requires separate capability-specific validation";
        record(tool.name, "SKIP", reason);
      }
    }
    try { await client.close(); } catch { record("client/close", "FAIL", "Could not close the MCP connection"); }
  }
  return { results, exitCode: results.some((r) => r.status === "FAIL") ? 1 : 0 };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = smokeOptions(argv, env);
  const fixture = await createFixture();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/index.js")],
    cwd: process.cwd(), stderr: "pipe",
    env: { ...smokeEnvironment(options, env), OPENCODE_TASK_STORE: join(fixture.directory, ".mcp-jobs") },
  });
  // Drain diagnostics without printing potentially sensitive server messages.
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "opencode-mcp-smoke", version: "1.0.0" });
  try {
    await client.connect(transport);
    const report = await runSmoke({ client, directory: fixture.directory, ...options });
    for (const item of report.results) console.log(`${item.status} ${item.name}${item.detail ? `: ${item.detail}` : ""}`);
    return report.exitCode;
  } finally {
    await client.close().catch(() => {});
    await fixture.cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    console.error("Smoke checks could not start. Check the local server, credentials, Git, CLI options, and build output.");
    process.exitCode = 1;
  });
}
