import { packageVersion } from "./version.js";
import { McpServer, type ToolProfile } from "./mcp-server.js";
import { OpenCodeClient } from "./client.js";
import { JobService } from "./jobs.js";
import { registerInputTools } from "./tools/input.js";
import { TASKS_EXTENSION } from "./task-transport.js";
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

/** Build registrations without connecting or performing network/filesystem I/O. */
export function createServer(client: OpenCodeClient, jobs: JobService, profile: ToolProfile = "full") {
  const server = new McpServer({ name: "opencode-mcp", version: packageVersion,
    description: "Delegate coding work to OpenCode with durable jobs, explicit input, and project-scoped tools." }, {
    capabilities: { extensions: { [TASKS_EXTENSION]: {} } },
    cacheHints: { "tools/list": { ttlMs: 60000, cacheScope: "private" }, "prompts/list": { ttlMs: 60000, cacheScope: "private" },
      "resources/list": { ttlMs: 60000, cacheScope: "private" }, "resources/templates/list": { ttlMs: 60000, cacheScope: "private" },
      "resources/read": { ttlMs: 0, cacheScope: "private" } },
    instructions: [
      "Start with opencode_setup. Discover configured providers/models using opencode_provider_list and opencode_provider_models; pass their IDs or configure OPENCODE_DEFAULT_PROVIDER/MODEL.",
      "Use opencode_ask for a short task and opencode_reply to continue a session. V1 model output may be constrained with format: {type: 'json_schema', schema: {...}}. V2 rejects schema formats, nonempty system overrides, and noReply. Existing V2 sessions preserve their model and agent; defaults apply only to new sessions.",
      "Use opencode_run for long work. July 2026 clients advertising the Tasks extension receive a native task handle; poll tasks/get, supply explicit input via tasks/update, and abort via tasks/cancel.",
      "Other clients receive an observed result from opencode_run. opencode_fire returns immediately. Keep jobId, sessionId, and messageId to resume observation with opencode_job_get, opencode_check, or opencode_wait.",
      "Observation timeouts and disconnects do not cancel OpenCode work. An unknown submission outcome must be checked before any retry. Local job records expire after 24 hours; they do not keep a stopped OpenCode process alive.",
      "If status is input_required, use opencode_job_input for forms/manual responses, or question_list/question_reply/question_reject and permission_list/session_permission. Approve only the operations the user authorized.",
      "opencode_job_cancel explicitly aborts a job's session. Review changes with opencode_review_changes and messages with opencode_conversation.",
      "directory is an absolute path on the OpenCode host; omitted directory uses that server's project. Project resource templates require an encoded absolute directory.",
      "Tool annotations describe effects conservatively; mutating tools can change files, sessions, configuration, or credentials. The essential profile exposes common workflows; full adds low-level APIs and TUI controls.",
      "Catalog cache hints do not imply live resource subscriptions or task progress notifications. Poll jobs/tasks for updates.",
    ].join("\n"),
  });
  server.profile = profile;
  server.backendIdentity = client.getBackendIdentity?.();
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
registerWorkflowTools(server, client, jobs);

// ── TUI control ─────────────────────────────────────────────────────
registerTuiTools(server, client);

// ── Event streaming ─────────────────────────────────────────────────
registerEventTools(server, client);

// ── Resources ───────────────────────────────────────────────────────
registerResources(server, client);

// ── Prompts ─────────────────────────────────────────────────────────
registerPrompts(server);

  registerInputTools(server, client, jobs);
  return server;
}
