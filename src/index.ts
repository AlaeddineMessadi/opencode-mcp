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
 *  - 78 tools covering the entire OpenCode API surface
 *  - High-level workflow tools (opencode_ask, opencode_reply, etc.)
 *  - Smart response formatting for LLM-friendly output
 *  - MCP Resources for browseable project data
 *  - MCP Prompts for guided workflows
 *  - SSE event polling
 *  - TUI control tools
 *  - Retry logic with exponential backoff
 *  - Auto-detection and auto-start of the OpenCode server
 *
 * Environment variables:
 *   OPENCODE_BASE_URL        - Base URL of the OpenCode server (default: http://127.0.0.1:4096)
 *   OPENCODE_SERVER_USERNAME  - Username for HTTP basic auth (default: opencode)
 *   OPENCODE_SERVER_PASSWORD  - Password for HTTP basic auth (optional)
 *   OPENCODE_AUTO_SERVE       - Set to "false" to disable auto-start (default: true)
 *   OPENCODE_DEFAULT_PROVIDER - Default provider ID when not specified per-tool (optional)
 *   OPENCODE_DEFAULT_MODEL    - Default model ID when not specified per-tool (optional)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OpenCodeClient } from "./client.js";
import { ensureServer } from "./server-manager.js";
import { setModelDefaults } from "./helpers.js";

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
const autoServe = process.env.OPENCODE_AUTO_SERVE !== "false";
const defaultProvider = process.env.OPENCODE_DEFAULT_PROVIDER;
const defaultModel = process.env.OPENCODE_DEFAULT_MODEL;

// Set global model defaults from env vars (used by applyModelDefaults() in tools)
setModelDefaults(defaultProvider, defaultModel);

const client = new OpenCodeClient({ baseUrl, username, password, autoServe });

const server = new McpServer(
  {
    name: "opencode-mcp",
    version: "1.9.0",
    description:
      "MCP server wrapping the OpenCode AI coding agent. " +
      "Delegates complex coding tasks (build apps, refactor, debug) to an autonomous AI agent. " +
      "Start with opencode_setup, then use opencode_ask for simple tasks, opencode_run for complex tasks, or opencode_fire for long-running background work.",
  },
  {
    instructions: [
      "# OpenCode MCP — Guide for LLM Clients",
      "",
      "You are connected to OpenCode, an autonomous AI coding agent that can build, edit, and debug software projects.",
      "This server exposes ~78 tools organized into tiers. Use high-level tools first; drop to low-level only when needed.",
      "",
      "## Getting Started (First Time)",
      "1. Call `opencode_setup` — checks server health, shows configured providers, and suggests next steps.",
      "2. Call `opencode_provider_models({providerId: 'anthropic'})` — lists available models for a provider.",
      "3. Pick a provider and model. IMPORTANT: Always pass `providerID` and `modelID` when sending prompts, or you may get empty responses.",
      "",
      "## Tool Tiers (prefer higher tiers)",
      "",
      "### Tier 1 — Essential (use these first)",
      "- `opencode_setup` — first-time onboarding, health check (read-only)",
      "- `opencode_ask` — one-shot question/task, creates session + gets response in one call. Simplest way to use OpenCode.",
      "- `opencode_reply` — continue a conversation in an existing session",
      "- `opencode_context` — get project info (path, git branch, config, agents) (read-only)",
      "",
      "### Tier 2 — Async Tasks (for complex/long work)",
      "- `opencode_run` — RECOMMENDED: send a task and wait for completion in one call. Creates session, sends prompt, polls until done. Best for tasks under 10 minutes.",
      "- `opencode_fire` — fire-and-forget: send a task and return immediately. Use `opencode_check` to monitor progress. Best for long tasks (10+ min).",
      "- `opencode_check` — cheap progress report: status, todos, file counts. Use to monitor sessions from `opencode_fire`. (read-only)",
      "- `opencode_wait` — block until a session finishes processing. Use after `opencode_message_send_async`. Has timeout.",
      "- `opencode_session_todo` — see the agent's internal task list for a session (read-only)",
      "",
      "### Tier 3 — Monitoring & Review",
      "- `opencode_review_changes` — see all file diffs from a session (read-only)",
      "- `opencode_conversation` — get full message history (read-only)",
      "- `opencode_sessions_overview` — list all sessions with status (read-only)",
      "- `opencode_provider_models` — list models for a specific provider (read-only)",
      "- `opencode_status` — quick server health dashboard (read-only)",
      "",
      "### Tier 4 — Fine-Grained Control",
      "- `opencode_session_*` — create, delete, fork, abort, share sessions",
      "- `opencode_message_*` — send messages, list history, execute commands",
      "- `opencode_file_*` / `opencode_find_*` — search files, read content, check VCS status",
      "- `opencode_provider_*` — manage providers, auth, OAuth flows",
      "",
      "### Tier 5 — Specialist (rarely needed)",
      "- `opencode_tui_*` — control the terminal UI (only if a TUI is running)",
      "- `opencode_events_poll` — poll raw SSE events",
      "- `opencode_mcp_*` — manage MCP servers inside OpenCode",
      "- `opencode_instance_dispose` — shut down the server (DESTRUCTIVE!)",
      "",
      "## Recommended Workflows",
      "",
      "### Quick question or small task:",
      "```",
      'opencode_ask({prompt: "How does auth work in this project?", providerID: "anthropic", modelID: "claude-sonnet-4-5"})',
      "```",
      "",
      "### Complex multi-step task (build an app, refactor code, etc.):",
      "```",
      "// Option A: One-call (recommended for tasks under 10 min)",
      'opencode_run({prompt: "Build a React login form with validation...", providerID: "anthropic", modelID: "claude-opus-4-6", maxDurationSeconds: 600})',
      "",
      "// Option B: Fire-and-forget (for longer tasks)",
      'opencode_fire({prompt: "Build a full React app with auth, dashboard...", providerID: "anthropic", modelID: "claude-opus-4-6"})',
      "// ... do other work ...",
      'opencode_check({sessionId: "ses_xxx"})  // quick progress check',
      'opencode_review_changes({sessionId: "ses_xxx"})  // see changes after completion',
      "```",
      "",
      "### Continue working on an existing session:",
      "```",
      'opencode_reply({sessionId: "ses_xxx", prompt: "Now add form validation", providerID: "anthropic", modelID: "claude-sonnet-4-5"})',
      "```",
      "",
      "## Important Notes",
      "- ALWAYS specify `providerID` and `modelID` when using `opencode_ask`, `opencode_reply`, `opencode_message_send`, or `opencode_message_send_async`. Without these, the agent may return empty responses. If OPENCODE_DEFAULT_PROVIDER and OPENCODE_DEFAULT_MODEL env vars are set, they will be used as fallbacks when you don't specify them.",
      "- The `directory` parameter on every tool targets a specific project. Omit it to use the server's default project. Must be an absolute path to an existing directory — relative paths and non-existent paths are rejected with a helpful error.",
      "- Tools marked with `readOnlyHint: true` in their annotations are safe and don't modify state.",
      "- Tools marked with `destructiveHint: true` (`opencode_instance_dispose`, `opencode_session_delete`) permanently delete data — confirm with the user before calling.",
      "- `opencode_wait` sends `notifications/message` progress updates while blocking. If it times out, it returns a progress report instead of failing.",
      "- For tasks under 10 minutes, prefer `opencode_run` (one call, handles everything). For longer tasks, use `opencode_fire` + `opencode_check`.",
      "- For very long tasks, use `opencode_fire` + periodically call `opencode_check` or `opencode_session_todo` to monitor progress.",
    ].join("\n"),
  },
);

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
  // Step 1: Ensure OpenCode server is available (auto-start if needed).
  try {
    await ensureServer({ baseUrl, autoServe });
  } catch (err) {
    // Log the error but don't prevent MCP from starting — tools will
    // report connection errors individually, and the server may come
    // up later.
    console.error(
      `Warning: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Step 2: Connect the MCP transport.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const defaultsInfo = defaultProvider && defaultModel
    ? ` | defaults: ${defaultProvider}/${defaultModel}`
    : "";
  console.error(
    `opencode-mcp v1.9.0 started (OpenCode server at ${baseUrl}${defaultsInfo})`,
  );
}

main().catch((err) => {
  console.error("Fatal error starting opencode-mcp:", err);
  process.exit(1);
});
