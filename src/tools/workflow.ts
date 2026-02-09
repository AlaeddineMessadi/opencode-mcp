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
  toolResult,
  toolError,
  directoryParam,
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

        // 2. Providers — which are connected?
        try {
          const providers = (await client.get("/provider", undefined, directory)) as Array<Record<string, unknown>>;
          if (providers && providers.length > 0) {
            // Also fetch auth methods for richer status info
            let authMethods: Record<string, unknown> | null = null;
            try {
              authMethods = (await client.get("/provider/auth", undefined, directory)) as Record<string, unknown>;
            } catch { /* non-critical */ }

            const lines = await Promise.all(
              providers.map(async (p) => {
                const id = (p.id ?? p.name ?? "?") as string;
                const models = p.models as Array<Record<string, unknown>> | undefined;
                const defaultModel = models && models.length > 0
                  ? (models[0].id ?? models[0].name ?? "?")
                  : "no models";
                // Check if provider has auth configured
                const connected = p.connected ?? p.authenticated ?? p.status === "connected";

                if (!connected) {
                  // Determine available auth methods
                  let authHint = "use opencode_auth_set to add API key";
                  if (authMethods && Array.isArray(authMethods[id])) {
                    const methods = (authMethods[id] as Array<Record<string, unknown>>)
                      .map((m) => m.type ?? m.id ?? "?")
                      .join(", ");
                    authHint = `available auth: ${methods}`;
                  }
                  return `- ${id}: NOT CONFIGURED — ${authHint}`;
                }

                // Provider says connected — verify with a lightweight probe
                let verified = "connected";
                try {
                  // Create a throwaway session, send a trivial prompt, check for content
                  const session = (await client.post("/session", {
                    title: `_probe_${id}`,
                  }, { directory })) as Record<string, unknown>;
                  const sessionId = session.id as string;

                  const probeBody: Record<string, unknown> = {
                    parts: [{ type: "text", text: "Reply with OK" }],
                  };
                  if (models && models.length > 0) {
                    probeBody.model = {
                      providerID: id,
                      modelID: (models[0].id ?? models[0].name) as string,
                    };
                  }

                  const probeResponse = await client.post(
                    `/session/${sessionId}/message`,
                    probeBody,
                    { directory },
                  );

                  const analysis = analyzeMessageResponse(probeResponse);
                  if (analysis.isEmpty || analysis.hasError) {
                    verified = "CONNECTED BUT NOT RESPONDING — API key may be invalid or expired";
                  } else {
                    verified = "WORKING";
                  }

                  // Clean up probe session
                  try {
                    await client.delete(`/session/${sessionId}`, undefined, directory);
                  } catch { /* best effort */ }
                } catch {
                  // If the probe throws (e.g. network error), just report connected
                  verified = "connected (could not verify)";
                }

                return `- ${id}: ${verified} (${defaultModel})`;
              }),
            );
            sections.push(`## Providers\n${lines.join("\n")}`);
          } else {
            sections.push("## Providers\nNo providers found.");
          }
        } catch {
          sections.push("## Providers\nCould not fetch provider list.");
        }

        // 3. Project info (if directory given or from default)
        try {
          const project = (await client.get("/project/current", undefined, directory)) as Record<string, unknown>;
          const name = project.name ?? project.id ?? "unknown";
          const worktree = project.worktree ?? "unknown";
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

        // 4. Next steps guidance
        const tips: string[] = [];
        tips.push("- Use `opencode_ask` with a `directory` parameter to start working on a project");
        tips.push("- Use `opencode_auth_set` to configure API keys for providers");
        tips.push("- Use `opencode_context` to get full project context (config, VCS, agents)");
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
        if (providerID && modelID) {
          body.model = { providerID, modelID };
        }
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
        const parts = [`Session: ${sessionId}`];
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
        if (providerID && modelID) {
          body.model = { providerID, modelID };
        }
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
    async ({ directory }) => {
      try {
        const [sessions, statuses] = await Promise.all([
          client.get("/session", undefined, directory) as Promise<Array<Record<string, unknown>>>,
          client.get("/session/status", undefined, directory) as Promise<Record<string, unknown>>,
        ]);

        // Merge status into session info
        const enriched = sessions.map((s) => ({
          ...s,
          status: statuses[s.id as string] ?? "unknown",
        }));

        const formatted = formatSessionList(enriched);
        return toolResult(formatted);
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
    async ({ directory }) => {
      try {
        const [project, path, vcs, config, agents] = await Promise.all([
          client.get("/project/current", undefined, directory).catch(() => null),
          client.get("/path", undefined, directory).catch(() => null),
          client.get("/vcs", undefined, directory).catch(() => null),
          client.get("/config", undefined, directory).catch(() => null),
          client.get("/agent", undefined, directory).catch(() => null),
        ]);

        const sections: string[] = [];

        if (project) {
          sections.push(
            `## Project\n${JSON.stringify(project, null, 2)}`,
          );
        }
        if (path) {
          sections.push(`## Path\n${JSON.stringify(path, null, 2)}`);
        }
        if (vcs) {
          sections.push(
            `## VCS (Git)\n${JSON.stringify(vcs, null, 2)}`,
          );
        }
        if (config) {
          sections.push(
            `## Config\n${JSON.stringify(config, null, 2)}`,
          );
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
    "Poll a session until it finishes processing. Use this after opencode_message_send_async to wait for the AI to complete its response.",
    {
      sessionId: z.string().describe("Session ID to wait on"),
      timeoutSeconds: z
        .number()
        .optional()
        .describe("Max seconds to wait (default: 120)"),
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
          const status = statuses[sessionId] as string | undefined;

          if (!status || status === "idle" || status === "completed") {
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
          `Timeout: session still processing after ${timeoutSeconds ?? 120}s`,
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
}
