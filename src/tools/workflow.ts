/**
 * High-level workflow tools — composite operations that make it easy
 * for an LLM to accomplish common tasks in a single call.
 */

import { z } from "zod";
import { McpServer, type ToolContext } from "../mcp-server.js";
import { OpenCodeClient } from "../client.js";
import { JobService, observeSession, type JobSnapshot } from "../jobs.js";
import { createRequestContext, abortableSleep, withAbort } from "../async.js";
import { dispatchShape, runShape } from "../job-contract.js";
import { switchSessionModel } from "./message.js";
import {
  formatMessageResponse,
  formatMessageList,
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

function jobResult(snapshot: JobSnapshot, note = "", extra: Record<string, unknown> = {}) {
  const lines = [snapshot.directory ? `Directory: ${snapshot.directory}` : "", snapshot.sessionId ? `Session: ${snapshot.sessionId}` : "",
    snapshot.jobId ? `Job: ${snapshot.jobId}` : "", `Status: ${snapshot.status}`].filter(Boolean);
  if (snapshot.status === "completed") lines.push("Session completed.");
  if (snapshot.status === "input_required") lines.push("Input required. Inspect pending permissions and questions before continuing.");
  if (snapshot.error) lines.push(`Error: ${typeof snapshot.error === "string" ? snapshot.error : JSON.stringify(snapshot.error)}`);
  if (note) lines.push(note);
  if (snapshot.text) lines.push(snapshot.text);
  return toolResult(lines.join("\n\n"), snapshot.status === "failed", { ...snapshot, ...extra });
}

/** A wait observes a remote job; cancelling observation must not abort that job. */
async function waitForSnapshot(
  read: (options: { signal: AbortSignal; deadline: number }) => Promise<JobSnapshot>,
  initial: JobSnapshot, seconds: number, interval: number, extra?: ToolContext,
) {
  let snapshot = initial;
  const timeoutNote = "Timeout: session still running or its outcome is unknown. Use opencode_check or opencode_conversation to check progress, opencode_wait to wait longer, or opencode_session_abort to stop it.";
  if (seconds === 0) return jobResult(snapshot, timeoutNote, { timedOut: true });
  const context = createRequestContext({ signal: extra?.signal, timeout: seconds * 1000 });
  try {
    while (true) {
      snapshot = await withAbort(read(context), context.signal);
      if (["completed", "failed", "cancelled", "input_required"].includes(snapshot.status)) return jobResult(snapshot);
      await abortableSleep(Math.min(interval, Math.max(0, context.deadline - Date.now())), context.signal);
    }
  } catch (error) {
    if (context.signal.aborted) {
      if (extra?.signal?.aborted) return jobResult(snapshot, "Observation cancelled. The remote session may still be running.", { observationCancelled: true });
      return jobResult(snapshot, timeoutNote, { timedOut: true });
    }
    return jobResult({ ...snapshot, status: "unknown", error: error instanceof Error ? error.message : String(error) });
  } finally {
    context.dispose();
  }
}

/**
 * Send a prompt and wait for its turn to finish. OpenCode 2.x prompts are
 * queued in the session inbox and return immediately; the experimental wait
 * endpoint long-polls until the session is idle. Resolves with the final
 * assistant message of that turn, or the partial state when the deadline
 * elapses.
 */
async function promptAndWait(
  client: OpenCodeClient,
  sessionId: string,
  text: string,
  opts: { agent?: string; directory?: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<{ user: Record<string, unknown>; assistant?: Record<string, unknown>; idle?: Record<string, unknown> }> {
  const directory = normalizeDirectory(opts.directory);
  const user = await client.post<Record<string, unknown>>(
    `/api/session/${encodeURIComponent(sessionId)}/prompt`,
    { text, ...(opts.agent ? { agent: opts.agent } : {}) },
    { ...(opts.signal ? { signal: opts.signal } : {}), directory },
  );
  const messageId = typeof user?.id === "string" ? user.id : undefined;

  const waitContext = createRequestContext({ signal: opts.signal, timeout: opts.timeoutMs ?? 600_000 });
  try {
    await client.post(`/api/experimental/session/${encodeURIComponent(sessionId)}/wait`, undefined, {
      signal: waitContext.signal, deadline: waitContext.deadline, directory,
    });
  } catch (error) {
    // A timeout leaves the turn running; fall through and read partial state.
    // A caller cancellation must propagate instead.
    if (opts.signal?.aborted) throw error;
  } finally {
    waitContext.dispose();
  }

  const response = await client.get<unknown>(
    `/api/session/${encodeURIComponent(sessionId)}/message`,
    { limit: "100" },
    directory,
    { ...(opts.signal ? { signal: opts.signal } : {}) },
  );
  if (!Array.isArray(response)) throw new Error("Invalid session message response");
  // Messages arrive newest-first; normalize to ascending creation order.
  const messages = [...response].sort((a: any, b: any) =>
    (a?.time?.created ?? 0) - (b?.time?.created ?? 0) || String(a?.id ?? "").localeCompare(String(b?.id ?? "")));
  const targetIndex = messageId ? messages.findIndex((message: any) => message?.id === messageId) : -1;
  // The turn is everything after our user message: assistant* then idle.
  const turn = targetIndex >= 0 ? messages.slice(targetIndex + 1) : [];
  return {
    user,
    assistant: turn.filter((message: any) => message?.type === "assistant").at(-1),
    idle: turn.find((message: any) => message?.type === "idle"),
  };
}

export function registerWorkflowTools(
  server: McpServer,
  client: OpenCodeClient,
  jobs?: JobService,
) {
  // Standalone registration (including unit clients) never writes the user's store.
  const service = jobs ?? new JobService(client, { storeRoot: null });
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

        // 1. Server info — OpenCode 2.x /api/info responds when healthy.
        try {
          const info = (await client.get("/api/info", undefined, directory)) as Record<string, unknown>;
          sections.push(
            `## Server\nStatus: healthy\nVersion: ${info.version ?? "unknown"}`,
          );
        } catch (e) {
          sections.push(
            `## Server\nStatus: UNREACHABLE — is \`opencode serve\` running?\nError: ${e instanceof Error ? e.message : String(e)}`,
          );
          return toolResult(sections.join("\n\n"));
        }

        // 2. Providers — v2 splits providers, credentials, integrations and models.
        try {
          const [providers, credentials, integrations, models] = await Promise.all([
            client.get("/api/provider", undefined, directory).catch(() => null),
            client.get("/api/credential", undefined, directory).catch(() => null),
            client.get("/api/integration", undefined, directory).catch(() => null),
            client.get("/api/model", undefined, directory).catch(() => null),
          ]);
          const providerList = Array.isArray(providers) ? (providers as Array<Record<string, unknown>>) : [];
          const credentialList = Array.isArray(credentials) ? (credentials as Array<Record<string, unknown>>) : [];
          const integrationList = Array.isArray(integrations) ? (integrations as Array<Record<string, unknown>>) : [];
          const modelList = Array.isArray(models) ? (models as Array<Record<string, unknown>>) : [];

          if (providerList.length > 0) {
            const countModels = (providerId: string) =>
              modelList.filter((m) => m?.providerID === providerId && m.enabled !== false).length;

            const ready = providerList.filter((p) => isProviderConfigured(p, credentialList));
            const readyIds = new Set(ready.map((p) => String(p.id)));

            const providerLines: string[] = [];
            if (ready.length > 0) {
              providerLines.push("**Ready to use:**");
              for (const p of ready) {
                providerLines.push(`- ${p.id} (${p.name ?? p.id}): ${countModels(String(p.id))} models`);
              }
            } else {
              providerLines.push("**No providers configured yet.** You need at least one to start using OpenCode.");
            }

            // Setup hints from integrations: OAuth, API key or env var methods.
            const setupHints: string[] = [];
            for (const integration of integrationList) {
              const integrationID = String(integration.id ?? "");
              const provider = providerList.find((p) => (p.integrationID ?? p.id) === integrationID);
              if (!provider || readyIds.has(String(provider.id))) continue;
              const methods = Array.isArray(integration.methods) ? (integration.methods as Array<Record<string, unknown>>) : [];
              const oauth = methods.find((m) => m?.type === "oauth");
              const key = methods.find((m) => m?.type === "key");
              const env = methods.find((m) => m?.type === "env");
              const options: string[] = [];
              if (oauth) options.push(`OAuth (${oauth.label ?? "browser flow"})`);
              if (key) options.push("`opencode_auth_set` (API key)");
              if (env) {
                const names = Array.isArray(env.names) ? env.names.map(String) : [];
                if (names.length > 0) options.push(`env var \`${names[0]}\``);
              }
              if (options.length > 0) setupHints.push(`- ${provider.id}: ${options.join(" or ")}`);
            }
            if (setupHints.length > 0) {
              providerLines.push("", "**Quick setup options:**", ...setupHints);
            }

            const hinted = new Set(setupHints.map((line) => line.replace(/^- ([^:]+):.*$/, "$1")));
            const otherCount = providerList.filter(
              (p) => !readyIds.has(String(p.id)) && !hinted.has(String(p.id)),
            ).length;
            if (otherCount > 0) {
              providerLines.push(`\n+${otherCount} more providers available. Use \`opencode_provider_list\` to see all.`);
            }

            sections.push(`## Providers (${providerList.length} available)\n${providerLines.join("\n")}`);
          } else {
            sections.push("## Providers\nNo providers found. Is the server running correctly?");
          }
        } catch {
          sections.push("## Providers\nCould not fetch provider list.");
        }

        // 3. Project info — v2 /api/location returns directory + project ref.
        try {
          const location = (await client.get("/api/location", undefined, directory)) as Record<string, unknown>;
          const project = (location.project ?? {}) as Record<string, unknown>;
          const dir = location.directory ?? project.directory ?? "unknown";
          const name = project.id
            ?? (typeof dir === "string" && dir !== "unknown" ? dir.split("/").filter(Boolean).pop() : null)
            ?? "unknown";
          sections.push(`## Project\nName: ${name}\nPath: ${dir}`);
        } catch {
          if (directory) {
            sections.push(
              `## Project\nDirectory: ${directory}\nNote: Could not load project info. Make sure the directory exists.`,
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
          tips.push("3. Use `opencode_provider_models` to inspect available models and choose one supported by your configured provider.");
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
    "Ask OpenCode a question in one step. Creates a new session, sends your prompt, waits for the turn to finish, and returns the AI response. This is the easiest way to interact with OpenCode.",
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
      variant: z.string().optional().describe("Model variant (e.g. 'fast', 'smart')"),
      agent: z
        .string()
        .optional()
        .describe("Agent to use (e.g. 'build', 'plan')"),
      directory: directoryParam,
    },
    async ({ prompt, title, providerID, modelID, variant, agent, directory }, extra) => {
      let sessionId: string | undefined;
      try {
        directory = normalizeDirectory(directory);
        // 1. Create session — v2 takes the model and location in the body.
        const model = applyModelDefaults(providerID, modelID);
        const session = (await client.post("/api/session", {
          title: title ?? prompt.slice(0, 80),
          ...(model ? { model: { id: model.modelID, providerID: model.providerID, ...(variant ? { variant } : {}) } } : {}),
          ...(directory ? { location: { directory } } : {}),
        }, { ...(extra?.signal ? { signal: extra.signal } : {}) })) as Record<string, unknown>;
        sessionId = session.id as string;
        if (!sessionId) throw new Error("OpenCode returned a session without an ID");

        // 2. Prompt and wait for the turn to finish
        const { assistant, idle } = await promptAndWait(client, sessionId, prompt, { agent, directory, signal: extra?.signal });
        const response = assistant ?? idle;

        // 3. Analyze for auth / empty response issues
        const analysis = analyzeMessageResponse(response);

        // 4. Format and return
        const formatted = formatMessageResponse(response);
        const dirLabel = directory ? `Directory: ${directory}` : "Directory: (server default)";
        const parts = [`${dirLabel}\nSession: ${sessionId}`];
        if (formatted) parts.push(formatted);
        if (idle?.outcome === "failed" && !analysis.hasError) {
          parts.push(`\n--- WARNING ---\nThe run failed${idle.error ? `: ${JSON.stringify(idle.error)}` : ""}.`);
        } else if (analysis.warning) {
          parts.push(`\n--- WARNING ---\n${analysis.warning}`);
        }
        return toolResult(parts.join("\n\n"), analysis.hasError || idle?.outcome === "failed", { sessionId, directory, data: response });
      } catch (e) {
        const result = toolError(e);
        return { ...result, content: [{ type: "text" as const, text: `${sessionId ? `Session: ${sessionId}\n` : ""}${result.content[0].text}` }], structuredContent: { sessionId, directory } };
      }
    },
  );

  // ─── Continue a conversation ────────────────────────────────────────
  server.tool(
    "opencode_reply",
    "Send a follow-up message to an existing session and wait for the answer. Use this to continue a conversation started with opencode_ask or opencode_session_create.",
    {
      sessionId: z.string().describe("Session ID to reply in"),
      prompt: z.string().describe("The follow-up message"),
      providerID: z.string().optional().describe("Provider ID"),
      modelID: z.string().optional().describe("Model ID"),
      variant: z.string().optional().describe("Model variant"),
      agent: z.string().optional().describe("Agent to use"),
      directory: directoryParam,
    },
    async ({ sessionId, prompt, providerID, modelID, variant, agent, directory }, extra) => {
      try {
        directory = normalizeDirectory(directory);
        const model = applyModelDefaults(providerID, modelID);
        if (model) {
          await switchSessionModel(client, sessionId, model.providerID, model.modelID, variant, directory);
        } else if (variant) {
          // No explicit model: read the session's current model and switch variant.
          const session = await client.get(`/api/session/${encodeURIComponent(sessionId)}`, undefined, directory).catch(() => null);
          const current = (session as Record<string, unknown> | null)?.model as Record<string, string> | undefined;
          if (current?.id && current?.providerID) {
            await switchSessionModel(client, sessionId, current.providerID, current.id, variant, directory);
          }
        }

        const { assistant, idle } = await promptAndWait(client, sessionId, prompt, { agent, directory, signal: extra?.signal });
        const response = assistant ?? idle;
        const analysis = analyzeMessageResponse(response);
        const formatted = formatMessageResponse(response);
        const parts: string[] = [];
        if (formatted) parts.push(formatted);
        if (idle?.outcome === "failed" && !analysis.hasError) {
          parts.push(`\n--- WARNING ---\nThe run failed${idle.error ? `: ${JSON.stringify(idle.error)}` : ""}.`);
        } else if (analysis.warning) {
          parts.push(`\n--- WARNING ---\n${analysis.warning}`);
        }
        // Session-directory consistency note
        if (sessionId && directory) {
          parts.push(`\n_Note: Using session ${sessionId} in directory ${directory}. Ensure this session belongs to this project._`);
        }
        return toolResult(
          parts.join("\n\n") || "Empty response.",
          analysis.hasError || idle?.outcome === "failed",
          { sessionId, directory, data: response },
        );
      } catch (e) {
        const result = toolError(e);
        return { ...result, content: [{ type: "text" as const, text: `Session: ${sessionId}\n${result.content[0].text}` }], structuredContent: { sessionId, directory } };
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
          `/api/session/${encodeURIComponent(sessionId)}/message`,
          query,
          directory,
        );
        const formatted = formatMessageList(
          messages as unknown[],
        );
        return toolResult(formatted, false, { sessionId, data: messages });
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
        const [sessions, active] = await Promise.all([
          client.get("/api/session", undefined, directory) as Promise<Array<Record<string, unknown>>>,
          client.get("/api/session/active", undefined, directory).catch(() => null) as Promise<Record<string, unknown> | null>,
        ]);

        if (!sessions || sessions.length === 0) {
          return toolResult("No sessions found.");
        }

        // Merge running-state and show enriched overview
        const lines = sessions.map((s) => {
          const id = s.id ?? "?";
          const title = s.title ?? "(untitled)";
          const status = active ? resolveSessionStatus(active[id as string]) : "idle";
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
    "Get full project context in one call: current location and project, VCS info, config, and available agents. Useful to understand the current state before starting work.",
    {
      directory: directoryParam,
    },
    readOnly,
    async ({ directory }) => {
      try {
        // Validate directory early — before Promise.all with .catch(() => null)
        // swallows the validation error.
        directory = normalizeDirectory(directory) as typeof directory;

        const [location, vcs, config, agents] = await Promise.all([
          client.get("/api/location", undefined, directory).catch(() => null),
          client.get("/api/vcs", undefined, directory).catch(() => null),
          client.get("/api/config", undefined, directory).catch(() => null),
          client.get("/api/agent", undefined, directory).catch(() => null),
        ]);

        const sections: string[] = [];

        if (location) {
          const l = location as Record<string, unknown>;
          const project = (l.project ?? {}) as Record<string, unknown>;
          const workDir = l.directory ?? project.directory ?? "unknown";
          const name = project.id
            ?? (workDir !== "unknown" ? String(workDir).split("/").filter(Boolean).pop() : null)
            ?? "unknown";
          const lines = [`Name: ${name}`, `Path: ${workDir}`];
          if (project.canonical && project.canonical !== workDir) lines.push(`Canonical: ${project.canonical}`);
          sections.push(`## Project\n${lines.join("\n")}`);
        }
        if (vcs) {
          const v = vcs as Record<string, unknown>;
          const branch = (v.branch ?? {}) as Record<string, unknown>;
          const lines: string[] = [];
          if (branch.current) lines.push(`Branch: ${branch.current}`);
          if (branch.default && branch.default !== branch.current) lines.push(`Default branch: ${branch.default}`);
          if (v.provider) lines.push(`Provider: ${v.provider}`);
          sections.push(`## VCS\n${lines.length > 0 ? lines.join("\n") : "No VCS branch info available."}`);
        }
        if (config) {
          // v2 config is a list of active sources (documents and directories).
          const entries = Array.isArray(config) ? (config as Array<Record<string, unknown>>) : [];
          const lines = entries.map((entry) => {
            const path = typeof entry.path === "string" ? entry.path : "(dynamic)";
            return `- ${entry.type ?? "source"}: ${path}`;
          });
          const redacted = redactSecrets(entries) as unknown[];
          sections.push(`## Config (${entries.length} source(s))\n${lines.length > 0 ? lines.join("\n") : "No config sources."}\n${JSON.stringify(redacted).length > 2000 ? "(details truncated)" : JSON.stringify(redacted)}`);
        }
        if (agents) {
          const agentList = (agents as Array<Record<string, unknown>>).filter((a) => a.hidden !== true);
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

  // ─── Wait for an observed session or durable job ───────────────────
  server.tool(
    "opencode_wait",
    "Wait for a session or durable job. Returns completed, failed, input_required, or a resumable timeout. Cancelling this wait stops observation; use job_cancel or session_abort to stop OpenCode.",
    {
      sessionId: z.string().optional().describe("Session ID (required unless jobId is supplied)"),
      jobId: z.string().optional().describe("Durable job ID returned by opencode_fire or opencode_run"),
      messageId: z.string().optional().describe("Submitted user message ID to correlate the exact response"),
      timeoutSeconds: z.number().nonnegative().max(86400).optional().describe("Maximum seconds to wait (default 120); timeout is resumable"),
      pollIntervalMs: z.number().int().min(10).max(60000).optional().describe("Polling interval in milliseconds (default 2000)"),
      directory: directoryParam,
    },
    readOnly,
    async ({ sessionId, jobId, messageId, timeoutSeconds, pollIntervalMs, directory }, extra) => {
      try {
        directory = normalizeDirectory(directory);
        if (!sessionId && !jobId) throw new Error("Provide sessionId or jobId to wait for a task.");
        const initial: JobSnapshot = { sessionId: sessionId ?? "", jobId, messageId, directory, status: "unknown" };
        return await waitForSnapshot(
          options => jobId ? service.get(jobId, options) : observeSession(client, sessionId!, directory, messageId, options),
          initial, timeoutSeconds ?? 120, pollIntervalMs ?? 2000, extra,
        );
      } catch (error) {
        const result = toolError(error);
        return { ...result, structuredContent: { sessionId, jobId, messageId, directory, status: "unknown" } };
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
        .describe("User message whose turn to diff (defaults to the newest turn)"),
      directory: directoryParam,
    },
    readOnly,
    async ({ sessionId, messageID, directory }) => {
      try {
        const query: Record<string, string> = {};
        if (messageID) query.from = messageID;
        const diffs = await client.get(`/api/session/${encodeURIComponent(sessionId)}/diff`, query, directory);
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
      modelID: z.string().optional().describe("Specific model ID to test. If omitted, discovers the provider default or first available model."),
      variant: z.string().optional().describe("Model variant"),
      directory: directoryParam,
    },
    async ({ providerId, modelID, variant, directory }, extra) => {
      let sessionId: string | null = null;
      try {
        directory = normalizeDirectory(directory);
        if (!modelID) {
          // v2: models are listed globally, tagged with providerID.
          const [models, defaultModel] = await Promise.all([
            client.get("/api/model", undefined, directory).catch(() => null),
            client.get("/api/model/default", undefined, directory).catch(() => null),
          ]);
          const choices = (Array.isArray(models) ? (models as Array<Record<string, unknown>>) : [])
            .filter((m) => m?.providerID === providerId && m.enabled !== false)
            .map((m) => String(m.modelID ?? m.id));
          const fallbackDefault = (defaultModel as Record<string, unknown> | null) ?? null;
          const preferred = fallbackDefault?.providerID === providerId ? String(fallbackDefault.modelID ?? fallbackDefault.id) : undefined;
          modelID = preferred && choices.includes(preferred) ? preferred : choices[0];
          if (!modelID) throw new Error(`No model discovered for provider "${providerId}". Specify modelID from opencode_provider_models.`);
        }
        // 1. Create a temporary test session with the model under test
        const session = (await client.post("/api/session", {
          title: `[test] ${providerId}`,
          model: { id: modelID, providerID: providerId, ...(variant ? { variant } : {}) },
          ...(directory ? { location: { directory } } : {}),
        }, { ...(extra?.signal ? { signal: extra.signal } : {}) })) as Record<string, unknown>;
        sessionId = session.id as string;

        // 2. Send a trivial prompt and wait for the turn to finish
        const { assistant, idle } = await promptAndWait(client, sessionId, "Say hello in one word.", {
          directory, signal: extra?.signal, timeoutMs: 120_000,
        });
        const response = assistant ?? idle;

        // 3. Analyze the response
        const analysis = analyzeMessageResponse(response);
        const formatted = formatMessageResponse(response);

        // 4. Cleanup — delete test session
        try {
          await client.delete(`/api/session/${encodeURIComponent(sessionId)}`, undefined, directory);
        } catch { /* best-effort cleanup */ }

        if (analysis.hasError || analysis.isEmpty || idle?.outcome === "failed") {
          const reason = idle?.outcome === "failed"
            ? `The run failed${idle.error ? `: ${JSON.stringify(idle.error)}` : ""}.`
            : analysis.warning ?? "Unknown error — no response received.";
          return toolResult(
            `Provider "${providerId}" FAILED.\n\n${reason}`,
            true,
            { sessionId, directory, providerId, modelID, data: response },
          );
        }

        const preview = formatted.length > 200 ? formatted.slice(0, 200) + "..." : formatted;
        return toolResult(
          `Provider "${providerId}" is working.\n\nResponse: ${preview}`,
          false,
          { sessionId, directory, providerId, modelID, data: response },
        );
      } catch (e) {
        // Cleanup on error
        if (sessionId) {
          try {
            await client.delete(`/api/session/${encodeURIComponent(sessionId)}`, undefined, directory);
          } catch { /* best-effort cleanup */ }
        }
        return { ...toolError(e), structuredContent: { sessionId, directory, providerId, modelID } };
      }
    },
  );

  // ─── Durable dispatch and observation ─────────────────────────────
  server.tool(
    "opencode_run",
    "Send a task and wait for its correlated response. Returns a durable job ID; an observation timeout leaves the remote job running and can be resumed with opencode_wait.",
    runShape,
    async ({ prompt, sessionId, title, providerID, modelID, variant, agent, maxDurationSeconds, directory }, extra) => {
      let snapshot: JobSnapshot = { sessionId: sessionId ?? "", directory, status: "unknown" };
      const seconds = maxDurationSeconds ?? 600;
      const context = createRequestContext({ signal: extra?.signal, timeout: seconds > 0 ? seconds * 1000 : 120000 });
      try {
        snapshot = await service.start({ prompt, sessionId, title, directory,
          model: applyModelDefaults(providerID, modelID), variant, agent }, context);
        if (["failed", "unknown", "cancelled", "input_required"].includes(snapshot.status)) return jobResult(snapshot);
        const remaining = seconds === 0 ? 0 : Math.max(0, (context.deadline - Date.now()) / 1000);
        return await waitForSnapshot(options => service.get(snapshot.jobId!, options), snapshot, remaining, 1000, extra);
      } catch (error) {
        if (context.signal.aborted) return jobResult(snapshot, "Observation ended before dispatch could be confirmed. Check the session before retrying.", { timedOut: !extra?.signal?.aborted, observationCancelled: extra?.signal?.aborted === true });
        return jobResult({ ...snapshot, status: "failed", error: error instanceof Error ? error.message : String(error) });
      } finally {
        context.dispose();
      }
    },
  );

  server.tool(
    "opencode_fire",
    "Dispatch a durable background task and return its job, session and message IDs immediately. Use opencode_check or opencode_wait to observe; job_cancel stops the task.",
    dispatchShape,
    async ({ prompt, sessionId, title, providerID, modelID, variant, agent, directory }, extra) => {
      try {
        const snapshot = await service.start({ prompt, sessionId, title, directory,
          model: applyModelDefaults(providerID, modelID), variant, agent }, { signal: extra?.signal });
        return jobResult(snapshot, snapshot.status === "accepted"
          ? `Task dispatched. Use opencode_check({jobId: "${snapshot.jobId}"}) or opencode_wait({jobId: "${snapshot.jobId}"}) to monitor it.` : "");
      } catch (error) {
        return jobResult({ sessionId: sessionId ?? "", directory, status: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  // ─── Check: summary metadata, never full patches ────────────────────
  server.tool(
    "opencode_check",
    "Get current task status, pending input and file counts. Uses session metadata instead of fetching patches. Pass jobId for exact durable turn correlation; detailed includes response text.",
    {
      sessionId: z.string().optional().describe("Session ID (required unless jobId is supplied)"),
      jobId: z.string().optional().describe("Durable job ID"),
      messageId: z.string().optional().describe("Submitted user message ID to correlate"),
      detailed: z.boolean().optional().describe("Include response text (default false)"),
      directory: directoryParam,
    },
    readOnly,
    async ({ sessionId, jobId, messageId, detailed, directory }, extra) => {
      try {
        directory = normalizeDirectory(directory);
        if (!sessionId && !jobId) throw new Error("Provide sessionId or jobId to check a task.");
        const options = { signal: extra?.signal };
        const snapshot = jobId ? await service.get(jobId, options) : await observeSession(client, sessionId!, directory, messageId, options);
        const sid = snapshot.sessionId;
        if (!sid) return jobResult(snapshot, "Session creation could not be confirmed. Inspect this job before retrying.");
        const session = snapshot.session as { title?: string } | undefined;
        const lines: string[] = [];
        if (session?.title) lines.push(`Title: ${session.title}`);
        // v2: the assistant message's snapshot.files lists files touched by the turn.
        const result = snapshot.result as { snapshot?: { files?: unknown[] } } | undefined;
        const files = Array.isArray(result?.snapshot?.files) ? result!.snapshot!.files : [];
        if (files.length > 0) lines.push(`Files changed: ${files.length}`);
        if (snapshot.status === "completed") lines.push("Done! Use opencode_review_changes to see changes.");
        if (detailed && snapshot.text) lines.push(`### Last message\n${snapshot.text.slice(0, 500)}`);
        // Avoid duplicating a potentially long final response in compact monitoring.
        return jobResult({ ...snapshot, text: undefined, result: detailed ? snapshot.result : undefined }, lines.join("\n"), {});
      } catch (error) {
        const result = toolError(error);
        return { ...result, structuredContent: { sessionId, jobId, messageId, directory, status: "unknown" } };
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

        const [info, providers, credentials, sessions, vcs] = await Promise.all([
          client.get("/api/info", undefined, directory).catch(() => null),
          client.get("/api/provider", undefined, directory).catch(() => null),
          client.get("/api/credential", undefined, directory).catch(() => null),
          client.get("/api/session", undefined, directory).catch(() => null),
          client.get("/api/vcs", undefined, directory).catch(() => null),
        ]);

        const lines: string[] = [];

        // Server
        if (info) {
          const i = info as Record<string, unknown>;
          lines.push(`Server: healthy (v${i.version ?? "?"})`);
        } else {
          lines.push("Server: UNREACHABLE");
        }

        // Providers
        if (Array.isArray(providers)) {
          const credentialList = Array.isArray(credentials) ? (credentials as Array<Record<string, unknown>>) : [];
          const configured = (providers as Array<Record<string, unknown>>).filter((p) => isProviderConfigured(p, credentialList)).length;
          lines.push(`Providers: ${configured} configured / ${providers.length} total`);
        }

        // Sessions
        if (sessions && Array.isArray(sessions)) {
          lines.push(`Sessions: ${(sessions as unknown[]).length}`);
        }

        // VCS
        if (vcs) {
          const v = vcs as Record<string, unknown>;
          const branch = (v.branch ?? {}) as Record<string, unknown>;
          if (branch.current) lines.push(`Branch: ${branch.current}`);
        }

        return toolResult(`## Status\n${lines.join("\n")}`);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
