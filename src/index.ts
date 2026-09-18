#!/usr/bin/env node
import { packageVersion } from "./version.js";
import { createHash } from "node:crypto";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { OpenCodeClient } from "./client.js";
import { JobService } from "./jobs.js";
import { TaskTransport } from "./task-transport.js";
import { createServer } from "./app.js";
import { registerShutdownHandlers } from "./server-manager.js";
import { setModelDefaults } from "./helpers.js";
import { CLI_HELP, CliUsageError, parseCliArgs } from "./cli.js";
import { runDoctor, formatDoctor } from "./doctor.js";
import { BackendDetectionError, DEFAULT_BASE_URL, detectBackend, readBackendConfig, type DetectedBackend } from "./backend-detection.js";

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.command === "help") { console.log(CLI_HELP); return; }
  if (args.command === "version") { console.log(packageVersion); return; }
  if (args.command === "doctor") {
    const report = await runDoctor({ directory: args.directory });
    console.log(args.json ? JSON.stringify(report, null, 2) : formatDoctor(report));
    process.exitCode = report.ready ? 0 : 1;
    return;
  }
  const config = readBackendConfig();
  const profile = config.profile;
  setModelDefaults(config.defaultProvider, config.defaultModel);
  registerShutdownHandlers();
  let connection: DetectedBackend;
  let unavailableReason: string | undefined;
  try { connection = await detectBackend(config, { allowStartup: true }); }
  catch (error) {
    if (!(error instanceof BackendDetectionError) || error.code === "authentication" || error.code === "config" || config.backend !== "auto") throw error;
    unavailableReason = "Backend is unresolved. Run opencode-mcp doctor, then restart this MCP connection after OpenCode is ready.";
    console.error(`Warning: ${unavailableReason}`);
    connection = { baseUrl: config.baseUrl ?? DEFAULT_BASE_URL, username: config.username, password: config.password,
      identity: { kind: "v1", connectionSource: config.baseUrl ? "explicit" : "loopback", processOwnership: "external", survivesDisconnect: true, resolved: false } };
  }
  const { baseUrl, username, password, identity } = connection;
  // Detection is the only startup decision. Ordinary client calls never start
  // an alternate server after a failed request or stop a discovered service.
  const client = new OpenCodeClient({ baseUrl, username, password, backend: identity.kind, identity, autoServe: false, unavailableReason });
  const scope = createHash("sha256").update(JSON.stringify([baseUrl, username ?? "opencode", password ?? ""])).digest("hex");
  const jobs = new JobService(client, { storeRoot: config.taskStore, scope });
  serveStdio(() => createServer(client, jobs, profile), {
    legacy: "serve", transport: new TaskTransport(new StdioServerTransport(), jobs),
    onerror: error => console.error("MCP transport error:", error.message),
  });
  console.error(`opencode-mcp v${packageVersion} started (profile: ${profile})`);
}
main().catch(error => {
  console.error(error instanceof CliUsageError ? `${error.message}\nUse opencode-mcp --help.` : error instanceof BackendDetectionError ? error.message : "Failed to start opencode-mcp. Run opencode-mcp doctor for redacted diagnostics.");
  process.exitCode = error instanceof CliUsageError ? 2 : 1;
});
