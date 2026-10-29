#!/usr/bin/env node
import { createHash } from "node:crypto";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { OpenCodeClient } from "./client.js";
import { JobService } from "./jobs.js";
import { TaskTransport } from "./task-transport.js";
import { createServer } from "./app.js";
import { registerShutdownHandlers } from "./server-manager.js";
import { setModelDefaults } from "./helpers.js";

async function main() {
  const baseUrl = process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096";
  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const token = process.env.OPENCODE_SERVER_TOKEN || undefined;
  const openchamberPassword = process.env.OPENCODE_OPENCHAMBER_PASSWORD || undefined;
  const openchamberUrl = process.env.OPENCODE_OPENCHAMBER_URL || undefined;
  const clientId = process.env.OPENCODE_OPENCHAMBER_CLIENT_ID || undefined;
  const autoServe = process.env.OPENCODE_AUTO_SERVE === "true";
  const profile = process.env.OPENCODE_TOOL_PROFILE ?? "full";
  if (profile !== "full" && profile !== "essential") throw new Error("OPENCODE_TOOL_PROFILE must be full or essential");
  setModelDefaults(process.env.OPENCODE_DEFAULT_PROVIDER, process.env.OPENCODE_DEFAULT_MODEL);
  registerShutdownHandlers();
  const client = new OpenCodeClient({ baseUrl, username, password, token, openchamberPassword, openchamberUrl, clientId, autoServe });
  // Resolve the server (and, for auto-serve, its generated password) before
  // serving so the first request is already authenticated.
  let effectiveUrl = baseUrl;
  try {
    const status = await client.connect();
    // Only a server we started moves the URL; otherwise keep OPENCODE_BASE_URL as typed so the job scope is unchanged.
    if (status.managedByUs && status.url) effectiveUrl = status.url;
  } catch (error) { console.error(`Warning: ${error instanceof Error ? error.message : String(error)}`); }
  // Hash the configured credentials, not a generated auto-serve password, so durable jobs stay visible across restarts.
  const identity: unknown[] = [effectiveUrl, username, password ?? ""];
  if (token || openchamberPassword) identity.push(token ?? "", openchamberPassword ?? "", openchamberUrl ?? "");
  const scope = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const jobs = new JobService(client, { storeRoot: process.env.OPENCODE_TASK_STORE, scope });
  serveStdio(() => createServer(client, jobs, profile), {
    legacy: "serve", transport: new TaskTransport(new StdioServerTransport(), jobs),
    onerror: error => console.error("MCP transport error:", error.message),
  });
  console.error(`opencode-mcp v4.0.0 started (profile: ${profile})`);
}
main().catch(error => { console.error("Fatal error starting opencode-mcp:", error); process.exitCode = 1; });
