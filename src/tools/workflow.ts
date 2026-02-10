/**
 * High-level workflow tools — composite operations that make it easy
 * for an LLM to accomplish common tasks in a single call.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import {
  formatMessageResponse,
  formatMessageList,
  formatSessionList,
  analyzeMessageResponse,
  isProviderConfigured,
  redactSecrets,
  resolveSessionStatus,
  applyModelDefaults,
  normalizeDirectory,
  toolResult,
  toolError,
  directoryParam,
  readOnly,
} from "../helpers.js";

export function registerWorkflowTools(
  server: McpServer,
  client: OpenCodeClient,
) {
  // ─── Setup / onboarding ───────────────────────────────────────────
  server.tool(
    "opencode_setup",
    "Check OpenCode status, provider configuration, and optionally initialize a project directory. Use this as the first step when starting work — it tells you what is ready and what still needs configuration.",
    {
      directory: directoryParam,
    },
    readOnly,
    async ({ directory }) => {
      try {
        const sections: string[] = [];

        // 1. Health check
        let healthy = false;
        try {
          const health = (await client.get("/global/health", undefined, directory)) as Record<string, unknown>;
          healthy = true;
          sections.push(
            `## Server\nStatus: healthy\nVersion: ${health.version ?? "unknown"}`,
          );
        } catch (e) {
          sections.push(
            `## Server\nStatus: UNREACHABLE — is \`opencode serve\` running?\nError: ${e instanceof Error ? e.message : String(e)}`,
          );
        }

        if (!healthy) {
          return toolResult(sections.join("\n\n"));
        }

        // 2. Providers — categorize by readiness
        try {
          const raw = await client.get("/provider", undefined, directory);
          const providers = (
            raw && typeof raw === "object" && "all" in (raw as Record<string, unknown>)
              ? (raw as Record<string, unknown>).all
              : raw
          ) as Array<Record<string, unknown>>;

          if (Array.isArray(providers) && providers.length > 0) {
            // Fetch auth methods for richer guidance
            let authMethods: Record<string, unknown> | null = null;
            try {
              authMethods = (await client.get("/provider/auth", undefined, directory)) as Record<string, unknown>;
            } catch { /* non-critical */ }

            // Helper to count models
            const countModels = (p: Record<string, unknown>) => {
              const m = p.models;
              return Array.isArray(m) ? m.length : m && typeof m === "object" ? Object.keys(m).length : 0;
            };

            const ready = providers.filter(isProviderConfigured);
            const withOAuth = providers.filter(
              (p) => !ready.includes(p) && authMethods && Array.isArray(authMethods[p.id as string]),
            );

            // Popular providers worth highlighting (have free tiers or are well-known)
            const popularIds = new Set([
              "anthropic", "openai", "google", "firmware", "openrouter",
              "groq", "deepseek", "huggingface", "github-copilot", "mistral",
            ]);
            const popular = providers.filter(
              (p) => !ready.includes(p) && popularIds.has(p.id as string),
            );
            const otherCount = providers.length - ready.length - popular.length;

            const providerLines: string[] = [];

            // Section: Ready to use
            if (ready.length > 0) {
              providerLines.push("**Ready to use:**");
              for (const p of ready) {
                const id = p.id as string;
                const name = p.name as string;
                const mc = countModels(p);
                const envVars = (p.env as string[])?.join(", ") ?? "";
                providerLines.push(`- ${id} (${name}): detected via ${envVars} — ${mc} models`);
              }
            } else {
              providerLines.push("**No providers configured yet.** You need at least one to start using OpenCode.");
            }

            // Section: Quick setup options
            providerLines.push("");
            providerLines.push("**Quick setup options:**");
            for (const p of popular) {
              const id = p.id as string;
              const name = p.name as string;
              const mc = countModels(p);
              const envVars = (p.env as string[]) ?? [];
              const envHint = envVars.length > 0 ? `set ${envVars[0]}` : "";

              // Check for OAuth
              const oauthAvailable = authMethods && Array.isArray(authMethods[id]);
              const methods: string[] = [];
              if (oauthAvailable) {
                const labels = (authMethods![id] as Array<Record<string, unknown>>)
                  .filter((m) => m.type === "oauth")
                  .map((m) => m.label as string);
                if (labels.length > 0) methods.push(`OAuth (${labels[0]})`);
              }
              if (envHint) methods.push(`\`opencode_auth_set\` or env var \`${envVars[0]}\``);

              // Check for free models
              const rawModels = p.models;
              const modelValues = rawModels && typeof rawModels === "object" && !Array.isArray(rawModels)
                ? Object.values(rawModels as Record<string, unknown>)
                : Array.isArray(rawModels) ? rawModels : [];
              const hasFree = modelValues.some(
                (m) => {
                  const cost = (m as Record<string, unknown>).cost as Record<string, unknown> | undefined;
                  return cost && cost.input === 0 && cost.output === 0;
                },
              );
              const freeTag = hasFree ? " [has free models]" : "";

              providerLines.push(`- ${id} (${name}): ${mc} models${freeTag} — ${methods.join(" or ")}`);
            }

            // Mention OAuth-only providers not already listed
            const oauthOnly = withOAuth.filter((p) => !popular.includes(p) && !ready.includes(p));
            if (oauthOnly.length > 0) {
              const names = oauthOnly.map((p) => `${p.id}`).join(", ");
              providerLines.push(`- Also available via OAuth: ${names}`);
            }

            if (otherCount > 0) {
              providerLines.push(`\n+${otherCount} more providers available. Use \`opencode_provider_list\` to see all.`);
            }

            sections.push(`## Providers (${providers.length} available)\n${providerLines.join("\n")}`);
          } else {
            sections.push("## Providers\nNo providers found. Is the server running correctly?");
          }
        } catch {
          sections.push("## Providers\nCould not fetch provider list.");
        }

        // 3. Project info (if directory given or from default)
        try {
          const project = (await client.get("/project/current", undefined, directory)) as Record<string, unknown>;
          const worktree = (project.worktree ?? "unknown") as string;
          // Derive a readable name: prefer project.name, then last dir component from worktree, then id
          const name = project.name
            ?? (worktree !== "unknown" ? worktree.split("/").filter(Boolean).pop() : null)
            ?? project.id
            ?? "unknown";
          const vcs = project.vcs ?? "none";
          sections.push(
            `## Project\nName: ${name}\nPath: ${worktree}\nVCS: ${vcs}`,
          );
        } catch {
          if (directory) {
            sections.push(
              `## Project\nDirectory: ${directory}\nNote: Could not load project info. Make sure the directory exists and contains a git repository.`,
            );
          } else {
            sections.push(
              "## Project\nNo project context available (no directory specified and server has no default project).",
            );
          }
        }

        // 4. Context-dependent next steps
        const tips: string[] = [];
        const hasReady = sections.some((s) => s.includes("**Ready to use:**"));
        const hasProject = sections.some((s) => s.startsWith("## Project\nName:"));

        if (!hasReady) {
          // No providers configured — guide them to set one up
          tips.push("**You need to configure a provider first.** Options:");
          tips.push("1. Set an API key: `opencode_auth_set` with providerId (e.g. 'anthropic', 'openai', 'google')");
          tips.push("2. Set an env var (e.g. `OPENROUTER_API_KEY`, `HF_TOKEN`, `ANTHROPIC_API_KEY`) and restart opencode");
          tips.push("3. Try **firmware** — it has 23 free models, no API key needed. Use `opencode_ask` with `providerID: 'firmware'`");
        } else {
          // Providers ready — guide to first task
          tips.push("**You're ready to go!** Try:");
          tips.push("- `opencode_ask` — ask a question or give an instruction (easiest way to start)");
          if (!hasProject) {
            tips.push("- Pass a `directory` parameter to target a specific project");
          }
          tips.push("- `opencode_context` — get full project context (config, VCS, agents)");
          tips.push("- `opencode_provider_models` — explore available models for your configured providers");
        }
        sections.push(`## Next Steps\n${tips.join("\n")}`);

        return toolResult(sections.join("\n\n"));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── One-shot: create session + send prompt + return answer ─────────
  server.tool(
    "opencode_ask",
    "Ask OpenCode a question in one step. Creates a new session, sends your prompt, and returns the AI response. This is the easiest way to interact with OpenCode.",
    {
      prompt: z.string().describe("The question or instruction to send"),
      title: z
        .string()
        .optional()
        .describe("Optional title for the session"),
      providerID: z
        .string()
        .optional()
        .describe("Provider ID (e.g. 'anthropic')"),
      modelID: z
        .string()
        .optional()
        .describe("Model ID (e.g. 'claude-3-5-sonnet-20241022')"),
      agent: z
        .string()
        .optional()
        .describe("Agent to use (e.g. 'build', 'plan')"),
      system: z
        .string()
        .optional()
        .describe("Optional system prompt override"),
      directory: directoryParam,
    },
    async ({ prompt, title, providerID, modelID, agent, system, directory }) => {
      try {
        // 1. Create session
        const session = (await client.post("/session", {
          title: title ?? prompt.slice(0, 80),
        }, { directory })) as Record<string, unknown>;
        const sessionId = session.id as string;

        // 2. Send prompt
        const body: Record<string, unknown> = {
          parts: [{ type: "text", text: prompt }],
        };
        const model = applyModelDefaults(providerID, modelID);
        if (model) body.model = model;
        if (agent) body.agent = agent;
        if (system) body.system = system;

        const response = await client.post(
          `/session/${sessionId}/message`,
          body,
          { directory },
        );

        // 3. Analyze for auth / empty response issues
        const analysis = analyzeMessageResponse(response);

        // 4. Format and return
        const formatted = formatMessageResponse(response);
        const dirLabel = directory ? `Directory: ${directory}` : "Directory: (server default)";
        const parts = [`${dirLabel}\nSession: ${sessionId}`];
        if (formatted) parts.push(formatted);
        if (analysis.warning) {
          parts.push(`\n--- WARNING ---\n${analysis.warning}`);
        }
        return toolResult(parts.join("\n\n"), analysis.hasError);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Continue a conversation ────────────────────────────────────────
  server.tool(
    "opencode_reply",
    "Send a follow-up message to an existing session. Use this to continue a conversation started with opencode_ask or opencode_session_create.",
    {
      sessionId: z.string().describe("Session ID to reply in"),
      prompt: z.string().describe("The follow-up message"),
      providerID: z.string().optional().describe("Provider ID"),
      modelID: z.string().optional().describe("Model ID"),
      agent: z.string().optional().describe("Agent to use"),
      directory: directoryParam,
    },
    async ({ sessionId, prompt, providerID, modelID, agent, directory }) => {
      try {
        const body: Record<string, unknown> = {
          parts: [{ type: "text", text: prompt }],
        };
        const model = applyModelDefaults(providerID, modelID);
        if (model) body.model = model;
        if (agent) body.agent = agent;

        const response = await client.post(
          `/session/${sessionId}/message`,
          body,
          { directory },
        );

        const analysis = analyzeMessageResponse(response);
        const formatted = formatMessageResponse(response);
        const parts: string[] = [];
        if (formatted) parts.push(formatted);
        if (analysis.warning) {
          parts.push(`\n--- WARNING ---\n${analysis.warning}`);
        }
        // Session-directory consistency note
        if (sessionId && directory) {
          parts.push(`\n_Note: Using session ${sessionId} in directory ${directory}. Ensure this session belongs to this project._`);
        }
        return toolResult(
          parts.join("\n\n") || "Empty response.",
          analysis.hasError,
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Get conversation history (formatted) ──────────────────────────
  server.tool(
    "opencode_conversation",
    "Get the full conversation history of a session, formatted for easy reading. Shows all messages with their roles and content.",
    {
      sessionId: z.string().describe("Session ID"),
      limit: z
        .number()
        .optional()
        .describe("Max messages to return (default: all)"),
      directory: directoryParam,
    },
    readOnly,
    async ({ sessionId, limit, directory }) => {
      try {
        const query: Record<string, string> = {};
        if (limit !== undefined) query.limit = String(limit);
        const messages = await client.get(
          `/session/${sessionId}/message`,
          query,
          directory,
        );
        const formatted = formatMessageList(
          messages as unknown[],
        );
        return toolResult(formatted);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Quick session overview ────────────────────────────────────────
  server.tool(
    "opencode_sessions_overview",
    "Get a quick overview of all sessions with their titles and status. Useful to find which session to continue working in.",
    {
      directory: directoryParam,
    },
    readOnly,
    async ({ directory }) => {
      try {
        const [sessions, statuses] = await Promise.all([
          client.get("/session", undefined, directory) as Promise<Array<Record<string, unknown>>>,
          client.get("/session/status", undefined, directory) as Promise<Record<string, unknown>>,
        ]);

        if (!sessions || sessions.length === 0) {
          return toolResult("No sessions found.");
        }

        // Merge status and show enriched overview
        const lines = sessions.map((s) => {
          const id = s.id ?? "?";
          const title = s.title ?? "(untitled)";
          const status = resolveSessionStatus(statuses[id as string]);
          const parentTag = s.parentID ? ` (child of ${s.parentID})` : "";
          return `- [${status}] ${title} [${id}]${parentTag}`;
        });

        return toolResult(
          `## Sessions (${sessions.length})\n${lines.join("\n")}`,
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Project context ──────────────────────────────────────────────
  server.tool(
    "opencode_context",
    "Get full project context in one call: current project, path, VCS info, config, and available agents. Useful to understand the current state before starting work.",
    {
      directory: directoryParam,
    },
    readOnly,
    async ({ directory }) => {
      try {
        // Validate directory early — before Promise.all with .catch(() => null)
        // swallows the validation error.
        directory = normalizeDirectory(directory) as typeof directory;

        const [project, path, vcs, config, agents] = await Promise.all([
          client.get("/project/current", undefined, directory).catch(() => null),
          client.get("/path", undefined, directory).catch(() => null),
          client.get("/vcs", undefined, directory).catch(() => null),
          client.get("/config", undefined, directory).catch(() => null),
          client.get("/agent", undefined, directory).catch(() => null),
        ]);

        const sections: string[] = [];

        if (project) {
          const p = project as Record<string, unknown>;
          const worktree = (p.worktree ?? "unknown") as string;
          const name = p.name
            ?? (worktree !== "unknown" ? worktree.split("/").filter(Boolean).pop() : null)
            ?? p.id ?? "unknown";
          const lines = [`Name: ${name}`, `Path: ${worktree}`];
          if (p.vcs) lines.push(`VCS: ${p.vcs}`);
          if (p.id) lines.push(`ID: ${p.id}`);
          sections.push(`## Project\n${lines.join("\n")}`);
        }
        if (path) {
          const pp = path as Record<string, unknown>;
          const workDir = pp.worktree ?? pp.directory ?? pp.cwd ?? pp.path;
          const pathLines: string[] = [];
          if (workDir) pathLines.push(`Working directory: ${workDir}`);
          if (pp.config && pp.config !== workDir) pathLines.push(`Config: ${pp.config}`);
          if (pp.state && pp.state !== workDir) pathLines.push(`State: ${pp.state}`);
          if (pp.home && pp.home !== workDir) pathLines.push(`Home: ${pp.home}`);
          if (pathLines.length === 0) pathLines.push(`Working directory: ${JSON.stringify(pp)}`);
          sections.push(`## Path\n${pathLines.join("\n")}`);
        }
        if (vcs) {
          const v = vcs as Record<string, unknown>;
          const lines: string[] = [];
          if (v.branch) lines.push(`Branch: ${v.branch}`);
          if (v.remote) lines.push(`Remote: ${v.remote}`);
          if (v.sha) lines.push(`HEAD: ${v.sha}`);
          if (v.dirty !== undefined) lines.push(`Dirty: ${v.dirty}`);
          sections.push(`## VCS (Git)\n${lines.length > 0 ? lines.join("\n") : "No VCS info available."}`);
        }
        if (config) {
          // Show config summary with secrets redacted — skip overwhelming nested objects
          const c = redactSecrets(config) as Record<string, unknown>;
          const topLevel: string[] = [];
          for (const [k, v] of Object.entries(c)) {
            if (v && typeof v === "object" && !Array.isArray(v)) {
              const keys = Object.keys(v as Record<string, unknown>);
              topLevel.push(`${k}: {${keys.length} entries}`);
            } else if (Array.isArray(v)) {
              topLevel.push(`${k}: [${v.length} items]`);
            } else {
              topLevel.push(`${k}: ${v}`);
            }
          }
          sections.push(`## Config\n${topLevel.join("\n")}`);
        }
        if (agents) {
          const agentList = agents as Array<Record<string, unknown>>;
          sections.push(
            `## Agents (${agentList.length})\n${agentList.map((a) => `- ${a.name ?? a.id}: ${a.description ?? "(no description)"} [${a.mode ?? "?"}]`).join("\n")}`,
          );
        }

        return toolResult(sections.join("\n\n"));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Wait for async session to complete ───────────────────────────
  server.tool(
    "opencode_wait",
    "Poll a session until it finishes processing. Use after opencode_message_send_async to wait for the AI to complete its response. Sends progress notifications while waiting. If timeout is reached, returns a progress report (not an error). For long tasks, consider using opencode_session_todo to check progress instead of blocking.",
    {
      sessionId: z.string().describe("Session ID to wait on"),
      timeoutSeconds: z
        .number()
        .optional()
        .describe("Max seconds to wait (default: 120). Set higher (300-600) for complex tasks."),
      pollIntervalMs: z
        .number()
        .optional()
        .describe("Polling interval in ms (default: 2000)"),
      directory: directoryParam,
    },
    async ({ sessionId, timeoutSeconds, pollIntervalMs, directory }) => {
      try {
        const timeout = (timeoutSeconds ?? 120) * 1000;
        const interval = pollIntervalMs ?? 2000;
        const start = Date.now();

        while (Date.now() - start < timeout) {
          const statuses = (await client.get("/session/status", undefined, directory)) as Record<
            string,
            unknown
          >;
          const status = resolveSessionStatus(statuses[sessionId]);

          if (status === "idle" || status === "completed") {
            // Fetch latest messages
            const messages = await client.get(
              `/session/${sessionId}/message`,
              { limit: "1" },
              directory,
            );
            const arr = messages as unknown[];
            if (arr.length > 0) {
              return toolResult(
                `Session completed.\n\n${formatMessageResponse(arr[arr.length - 1])}`,
              );
            }
            return toolResult("Session completed (no messages).");
          }

          if (status === "error") {
            return toolResult(`Session ended with error status.`, true);
          }

          await new Promise((r) => setTimeout(r, interval));
        }

        return toolResult(
          `Timeout: session still processing after ${timeoutSeconds ?? 120}s. ` +
          `Use \`opencode_conversation\` to check progress, or \`opencode_session_abort\` to stop it.`,
          true,
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Review changes ────────────────────────────────────────────────
  server.tool(
    "opencode_review_changes",
    "Get a formatted summary of all file changes made in a session. Shows diffs in a readable format.",
    {
      sessionId: z.string().describe("Session ID"),
      messageID: z
        .string()
        .optional()
        .describe("Specific message ID to get diff for"),
      directory: directoryParam,
    },
    readOnly,
    async ({ sessionId, messageID, directory }) => {
      try {
        const query: Record<string, string> = {};
        if (messageID) query.messageID = messageID;
        const diffs = await client.get(`/session/${sessionId}/diff`, query, directory);
        const { formatDiffResponse } = await import("../helpers.js");
        return toolResult(formatDiffResponse(diffs as unknown[]));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Provider test ────────────────────────────────────────────────
  server.tool(
    "opencode_provider_test",
    "Quick-test whether a provider is working. Creates a temporary session, sends a trivial prompt, checks the response, and cleans up. Great for debugging auth issues.",
    {
      providerId: z.string().describe("Provider ID to test (e.g. 'anthropic', 'openrouter')"),
      modelID: z.string().optional().describe("Specific model ID to test. If omitted, uses provider default."),
      directory: directoryParam,
    },
    async ({ providerId, modelID, directory }) => {
      let sessionId: string | null = null;
      try {
        // 1. Create a temporary test session
        const session = (await client.post("/session", {
          title: `[test] ${providerId}`,
        }, { directory })) as Record<string, unknown>;
        sessionId = session.id as string;

        // 2. Send a trivial prompt
        const body: Record<string, unknown> = {
          parts: [{ type: "text", text: "Say hello in one word." }],
        };
        // Use the specified model, or let the provider pick its default
        if (modelID) {
          body.model = { providerID: providerId, modelID };
        } else {
          body.providerID = providerId;
        }

        const response = await client.post(
          `/session/${sessionId}/message`,
          body,
          { directory },
        );

        // 3. Analyze the response
        const analysis = analyzeMessageResponse(response);
        const formatted = formatMessageResponse(response);

        // 4. Cleanup — delete test session
        try {
          await client.delete(`/session/${sessionId}`, undefined, directory);
        } catch { /* best-effort cleanup */ }

        if (analysis.hasError || analysis.isEmpty) {
          const reason = analysis.warning ?? "Unknown error — no response received.";
          return toolResult(
            `Provider "${providerId}" FAILED.\n\n${reason}`,
            true,
          );
        }

        const preview = formatted.length > 200 ? formatted.slice(0, 200) + "..." : formatted;
        return toolResult(
          `Provider "${providerId}" is working.\n\nResponse: ${preview}`,
        );
      } catch (e) {
        // Cleanup on error
        if (sessionId) {
          try {
            await client.delete(`/session/${sessionId}`, undefined, directory);
          } catch { /* best-effort cleanup */ }
        }
        return toolError(e);
      }
    },
  );

  // ─── Run: create session + async send + poll until done ──────────
  server.tool(
    "opencode_run",
    "Send a task to OpenCode and wait for completion. Combines session creation, async prompt, and polling into a single tool call. Use this instead of the manual opencode_message_send_async + opencode_wait pattern.",
    {
      prompt: z.string().describe("The task or instruction to send"),
      sessionId: z
        .string()
        .optional()
        .describe("Existing session ID to continue (omit to create a new session)"),
      title: z.string().optional().describe("Session title (only for new sessions)"),
      providerID: z.string().optional().describe("Provider ID (e.g. 'anthropic')"),
      modelID: z.string().optional().describe("Model ID (e.g. 'claude-opus-4-6')"),
      agent: z.string().optional().describe("Agent to use"),
      maxDurationSeconds: z
        .number()
        .optional()
        .describe("Max seconds to wait for completion (default: 600 = 10 minutes)"),
      directory: directoryParam,
    },
    async ({ prompt, sessionId, title, providerID, modelID, agent, maxDurationSeconds, directory }) => {
      try {
        // 1. Create or reuse session
        let sid = sessionId;
        if (!sid) {
          const session = (await client.post("/session", {
            title: title ?? prompt.slice(0, 80),
          }, { directory })) as Record<string, unknown>;
          sid = session.id as string;
        }

        // 2. Send async (fire-and-forget)
        const body: Record<string, unknown> = {
          parts: [{ type: "text", text: prompt }],
          noReply: false,
        };
        const model = applyModelDefaults(providerID, modelID);
        if (model) body.model = model;
        if (agent) body.agent = agent;

        await client.post(`/session/${sid}/message`, body, { directory });

        // Session-directory consistency note
        const dirNote = sessionId && directory
          ? `\n_Note: Using session ${sid} in directory ${directory}. Ensure this session belongs to this project._`
          : "";

        // 3. Poll until done
        const timeout = (maxDurationSeconds ?? 600) * 1000;
        const interval = 3000;
        const start = Date.now();
        const dirLabel = directory ? `Directory: ${directory}\n` : "";

        while (Date.now() - start < timeout) {
          await new Promise((r) => setTimeout(r, interval));

          const statuses = (await client.get("/session/status", undefined, directory)) as Record<string, unknown>;
          const status = resolveSessionStatus(statuses[sid!]);

          if (status === "idle" || status === "completed") {
            // Get final response
            const messages = await client.get(
              `/session/${sid}/message`,
              { limit: "1" },
              directory,
            );
            const arr = messages as unknown[];
            const lastMsg = arr.length > 0 ? formatMessageResponse(arr[arr.length - 1]) : "";

            // Get todo summary
            let todoSummary = "";
            try {
              const todos = await client.get(`/session/${sid}/todo`, undefined, directory);
              if (Array.isArray(todos) && todos.length > 0) {
                const completed = todos.filter((t: any) => t.status === "completed").length;
                todoSummary = `\nTasks: ${completed}/${todos.length} completed`;
              }
            } catch { /* non-critical */ }

            return toolResult(
              `${dirLabel}Session: ${sid}\nStatus: completed${todoSummary}${dirNote}\n\n${lastMsg || "(no response text)"}`,
            );
          }

          if (status === "error") {
            return toolResult(
              `${dirLabel}Session: ${sid}\nStatus: error${dirNote}\n\nThe session ended with an error. Use \`opencode_conversation({sessionId: "${sid}"})\` to see what happened.`,
              true,
            );
          }
        }

        // Timeout — return progress report
        let todoProgress = "";
        try {
          const todos = await client.get(`/session/${sid}/todo`, undefined, directory);
          if (Array.isArray(todos) && todos.length > 0) {
            const completed = todos.filter((t: any) => t.status === "completed").length;
            const inProgress = todos.filter((t: any) => t.status === "in_progress").length;
            todoProgress = `\nTasks: ${completed}/${todos.length} completed, ${inProgress} in progress`;
          }
        } catch { /* non-critical */ }

        return toolResult(
          `${dirLabel}Session: ${sid}\nStatus: still running after ${maxDurationSeconds ?? 600}s${todoProgress}${dirNote}\n\n` +
          `The session is still working. Options:\n` +
          `- \`opencode_check({sessionId: "${sid}"})\` — quick progress check\n` +
          `- \`opencode_wait({sessionId: "${sid}", timeoutSeconds: 300})\` — wait longer\n` +
          `- \`opencode_session_abort({id: "${sid}"})\` — stop the session`,
          true,
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Fire: send task and return immediately ────────────────────────
  server.tool(
    "opencode_fire",
    "Fire-and-forget: send a task to OpenCode and return immediately. OpenCode works autonomously in the background. Use `opencode_check` to check progress anytime. Best for long-running tasks when you want to do other work in parallel.",
    {
      prompt: z.string().describe("The task or instruction to send"),
      sessionId: z
        .string()
        .optional()
        .describe("Existing session ID to continue (omit to create a new session)"),
      title: z.string().optional().describe("Session title (only for new sessions)"),
      providerID: z.string().optional().describe("Provider ID (e.g. 'anthropic')"),
      modelID: z.string().optional().describe("Model ID (e.g. 'claude-opus-4-6')"),
      agent: z.string().optional().describe("Agent to use"),
      directory: directoryParam,
    },
    async ({ prompt, sessionId, title, providerID, modelID, agent, directory }) => {
      try {
        // 1. Create or reuse session
        let sid = sessionId;
        if (!sid) {
          const session = (await client.post("/session", {
            title: title ?? prompt.slice(0, 80),
          }, { directory })) as Record<string, unknown>;
          sid = session.id as string;
        }

        // 2. Send async
        const body: Record<string, unknown> = {
          parts: [{ type: "text", text: prompt }],
          noReply: false,
        };
        const model = applyModelDefaults(providerID, modelID);
        if (model) body.model = model;
        if (agent) body.agent = agent;

        await client.post(`/session/${sid}/message`, body, { directory });

        const dirLabel = directory ? `Directory: ${directory}\n` : "";
        return toolResult(
          `${dirLabel}Task dispatched to session: ${sid}\n\n` +
          `OpenCode is now working autonomously. Use these tools to monitor:\n` +
          `- \`opencode_check({sessionId: "${sid}"})\` — quick progress check\n` +
          `- \`opencode_session_todo({id: "${sid}"})\` — see the agent's task list\n` +
          `- \`opencode_wait({sessionId: "${sid}"})\` — block until done\n` +
          `- \`opencode_review_changes({sessionId: "${sid}"})\` — see file changes after completion`,
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Check: cheap progress report for a session ────────────────────
  server.tool(
    "opencode_check",
    "Get a compact cached progress report for a session. Much cheaper than opencode_conversation or opencode_wait — returns status, todos, and file counts in a single call. Use this to monitor sessions launched with opencode_fire.",
    {
      sessionId: z.string().describe("Session ID to check"),
      detailed: z
        .boolean()
        .optional()
        .describe("If true, include the last message text (default: false)"),
      directory: directoryParam,
    },
    readOnly,
    async ({ sessionId, detailed, directory }) => {
      try {
        // Validate directory early — before .catch(() => null) swallows the error
        directory = normalizeDirectory(directory) as typeof directory;

        // Parallel fetch: status, todos, session info, optionally last message
        const promises: Promise<unknown>[] = [
          client.get("/session/status", undefined, directory),
          client.get(`/session/${sessionId}/todo`, undefined, directory).catch(() => null),
          client.get(`/session/${sessionId}`, undefined, directory).catch(() => null),
        ];
        if (detailed) {
          promises.push(
            client.get(`/session/${sessionId}/message`, { limit: "1" }, directory).catch(() => null),
          );
        }

        const [statuses, todos, sessionInfo, lastMessages] = await Promise.all(promises) as [
          Record<string, unknown>,
          Array<Record<string, unknown>> | null,
          Record<string, unknown> | null,
          unknown[] | null,
        ];

        const status = resolveSessionStatus(statuses[sessionId]);
        const lines: string[] = [];

        // Session title
        const title = sessionInfo?.title ?? "(untitled)";
        lines.push(`## ${title} [${sessionId}]`);
        lines.push(`Status: **${status}**`);

        // Todos
        if (Array.isArray(todos) && todos.length > 0) {
          const completed = todos.filter((t) => t.status === "completed").length;
          const inProgress = todos.filter((t) => t.status === "in_progress").length;
          const pending = todos.length - completed - inProgress;
          lines.push(`Tasks: ${completed}/${todos.length} completed` +
            (inProgress > 0 ? `, ${inProgress} in progress` : "") +
            (pending > 0 ? `, ${pending} pending` : ""));

          // Show current task
          const current = todos.find((t) => t.status === "in_progress");
          if (current) {
            lines.push(`Current: ${current.content ?? current.title ?? "(unknown)"}`);
          }
        }

        // File changes count (from diff endpoint)
        try {
          const diffs = await client.get(`/session/${sessionId}/diff`, undefined, directory) as unknown[];
          if (Array.isArray(diffs) && diffs.length > 0) {
            lines.push(`Files changed: ${diffs.length}`);
          }
        } catch { /* non-critical */ }

        // Last message (if detailed)
        if (detailed && Array.isArray(lastMessages) && lastMessages.length > 0) {
          const lastMsg = formatMessageResponse(lastMessages[lastMessages.length - 1]);
          if (lastMsg) {
            const truncated = lastMsg.length > 500 ? lastMsg.slice(0, 497) + "..." : lastMsg;
            lines.push(`\n### Last message\n${truncated}`);
          }
        }

        // Suggest next action based on status
        if (status === "idle" || status === "completed") {
          lines.push(`\nDone! Use \`opencode_review_changes({sessionId: "${sessionId}"})\` to see all changes.`);
        } else if (status === "error") {
          lines.push(`\nFailed. Use \`opencode_conversation({sessionId: "${sessionId}"})\` to see what went wrong.`);
        }

        return toolResult(lines.join("\n"));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ─── Quick status dashboard ───────────────────────────────────────
  server.tool(
    "opencode_status",
    "Get a quick status dashboard: server health, provider count, session count, and VCS info. Lighter than opencode_setup — good for at-a-glance checks.",
    {
      directory: directoryParam,
    },
    readOnly,
    async ({ directory }) => {
      try {
        // Validate directory early — before Promise.all with .catch(() => null)
        // swallows the validation error.
        directory = normalizeDirectory(directory) as typeof directory;

        const [health, providerRaw, sessions, vcs] = await Promise.all([
          client.get("/global/health", undefined, directory).catch(() => null),
          client.get("/provider", undefined, directory).catch(() => null),
          client.get("/session", undefined, directory).catch(() => null),
          client.get("/vcs", undefined, directory).catch(() => null),
        ]);

        const lines: string[] = [];

        // Health
        if (health) {
          const h = health as Record<string, unknown>;
          lines.push(`Server: healthy (v${h.version ?? "?"})`);
        } else {
          lines.push("Server: UNREACHABLE");
        }

        // Providers
        if (providerRaw) {
          const providers = (
            providerRaw && typeof providerRaw === "object" && "all" in (providerRaw as Record<string, unknown>)
              ? (providerRaw as Record<string, unknown>).all
              : providerRaw
          ) as Array<Record<string, unknown>>;
          if (Array.isArray(providers)) {
            const configured = providers.filter(isProviderConfigured).length;
            lines.push(`Providers: ${configured} configured / ${providers.length} total`);
          }
        }

        // Sessions
        if (sessions && Array.isArray(sessions)) {
          lines.push(`Sessions: ${(sessions as unknown[]).length}`);
        }

        // VCS
        if (vcs) {
          const v = vcs as Record<string, unknown>;
          const branch = v.branch ?? "unknown";
          const dirty = v.dirty === true ? " (dirty)" : v.dirty === false ? " (clean)" : "";
          lines.push(`Branch: ${branch}${dirty}`);
        }

        return toolResult(`## Status\n${lines.join("\n")}`);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
