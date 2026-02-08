#!/usr/bin/env node

/**
 * OpenCode MCP Server
 *
 * An MCP (Model Context Protocol) server that wraps the OpenCode AI headless
 * server HTTP API. This allows any MCP client to interact with a running
 * OpenCode instance — manage sessions, send prompts, search files, configure
 * providers, and more.
 *
 * Features:
 *  - 60+ tools covering the entire OpenCode API surface
 *  - High-level workflow tools (opencode_ask, opencode_reply, etc.)
 *  - Smart response formatting for LLM-friendly output
 *  - MCP Resources for browseable project data
 *  - MCP Prompts for guided workflows
 *  - SSE event polling
 *  - TUI control tools
 *  - Retry logic with exponential backoff
 *
 * Environment variables:
 *   OPENCODE_BASE_URL        - Base URL of the OpenCode server (default: http://127.0.0.1:4096)
 *   OPENCODE_SERVER_USERNAME  - Username for HTTP basic auth (default: opencode)
 *   OPENCODE_SERVER_PASSWORD  - Password for HTTP basic auth (optional)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OpenCodeClient } from "./client.js";

// Tool groups
import { registerGlobalTools } from "./tools/global.js";
import { registerConfigTools } from "./tools/config.js";
import { registerProjectTools } from "./tools/project.js";
import { registerSessionTools } from "./tools/session.js";
import { registerMessageTools } from "./tools/message.js";
import { registerFileTools } from "./tools/file.js";
import { registerProviderTools } from "./tools/provider.js";
import { registerMiscTools } from "./tools/misc.js";
import { registerWorkflowTools } from "./tools/workflow.js";
import { registerTuiTools } from "./tools/tui.js";
import { registerEventTools } from "./tools/events.js";

// Resources and prompts
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";

const baseUrl =
  process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096";
const username = process.env.OPENCODE_SERVER_USERNAME;
const password = process.env.OPENCODE_SERVER_PASSWORD;

const client = new OpenCodeClient({ baseUrl, username, password });

const server = new McpServer({
  name: "opencode-mcp",
  version: "1.2.0",
  description:
    "Full-featured MCP server wrapping the OpenCode AI headless HTTP server. " +
    "Provides 70+ tools, resources, and prompts to manage sessions, send " +
    "prompts, search files, configure providers, control the TUI, monitor " +
    "events, and interact with the full OpenCode API. " +
    "All tools support a directory parameter for multi-project workflows. " +
    "Start with opencode_setup for onboarding, opencode_ask for one-shot " +
    "questions, or opencode_context to understand the current project.",
});

// ── Low-level API tools ─────────────────────────────────────────────
registerGlobalTools(server, client);
registerConfigTools(server, client);
registerProjectTools(server, client);
registerSessionTools(server, client);
registerMessageTools(server, client);
registerFileTools(server, client);
registerProviderTools(server, client);
registerMiscTools(server, client);

// ── High-level workflow tools ───────────────────────────────────────
registerWorkflowTools(server, client);

// ── TUI control ─────────────────────────────────────────────────────
registerTuiTools(server, client);

// ── Event streaming ─────────────────────────────────────────────────
registerEventTools(server, client);

// ── Resources ───────────────────────────────────────────────────────
registerResources(server, client);

// ── Prompts ─────────────────────────────────────────────────────────
registerPrompts(server);

// ── Start ───────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `opencode-mcp v1.2.0 started (connecting to OpenCode at ${baseUrl})`,
  );
}

main().catch((err) => {
  console.error("Fatal error starting opencode-mcp:", err);
  process.exit(1);
});
