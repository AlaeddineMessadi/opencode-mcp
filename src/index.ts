#!/usr/bin/env node
import { createHash } from "node:crypto";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { OpenCodeClient } from "./client.js";
import { JobService } from "./jobs.js";
import { TaskTransport } from "./task-transport.js";
import { createServer } from "./app.js";
import { ensureServer, registerShutdownHandlers } from "./server-manager.js";
import { setModelDefaults } from "./helpers.js";

async function main() {
  const baseUrl = process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096";
  const username = process.env.OPENCODE_SERVER_USERNAME;
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const autoServe = process.env.OPENCODE_AUTO_SERVE === "true";
  const profile = process.env.OPENCODE_TOOL_PROFILE ?? "full";
  if (profile !== "full" && profile !== "essential") throw new Error("OPENCODE_TOOL_PROFILE must be full or essential");
  setModelDefaults(process.env.OPENCODE_DEFAULT_PROVIDER, process.env.OPENCODE_DEFAULT_MODEL);
  registerShutdownHandlers();
  const client = new OpenCodeClient({ baseUrl, username, password, autoServe });
  const scope = createHash("sha256").update(JSON.stringify([baseUrl, username ?? "opencode", password ?? ""])).digest("hex");
  const jobs = new JobService(client, { storeRoot: process.env.OPENCODE_TASK_STORE, scope });
  try { await ensureServer({ baseUrl, autoServe, username, password }); }
  catch (error) { console.error(`Warning: ${error instanceof Error ? error.message : String(error)}`); }
  serveStdio(() => createServer(client, jobs, profile), {
    legacy: "serve", transport: new TaskTransport(new StdioServerTransport(), jobs),
    onerror: error => console.error("MCP transport error:", error.message),
  });
  console.error(`opencode-mcp v2.0.1 started (profile: ${profile})`);
}
main().catch(error => { console.error("Fatal error starting opencode-mcp:", error); process.exitCode = 1; });
