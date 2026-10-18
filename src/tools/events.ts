import { events as backendEvents } from "../backends/adapter.js";
/**
 * Event streaming tools — subscribe to real-time events from OpenCode.
 */

import { z } from "zod";
import { McpServer } from "../mcp-server.js";
import { OpenCodeClient } from "../client.js";
import { createRequestContext } from "../async.js";
import { toolResult, toolError, directoryParam, readOnly } from "../helpers.js";

export function registerEventTools(
  server: McpServer,
  client: OpenCodeClient,
) {
  server.tool(
    "opencode_events_poll",
    "Poll project events from OpenCode, or explicitly select global scope. Collects up to maxEvents within the duration. Connection failures are reported with any partial events; stopping observation does not abort remote work.",
    {
      durationMs: z
        .number().int().min(1).max(30000)
        .optional()
        .describe(
          "How long to collect events in milliseconds (default: 3000, max: 30000)",
        ),
      maxEvents: z
        .number().int().min(1).max(1000)
        .optional()
        .describe("Maximum number of events to collect (default: 50, max: 1000)"),
      directory: directoryParam,
      scope: z.enum(["project", "global"]).optional().describe("Event scope (default: project). Global events include all projects and cannot be combined with directory."),
    },
    readOnly,
    async ({ durationMs, maxEvents, directory, scope }, extra) => {
      const events: Array<{ event: string; data: string }> = [];
      try {
        if (scope === "global" && directory) throw new Error("Global event scope cannot be combined with directory");
        const context = createRequestContext({ signal: extra?.signal, timeout: durationMs ?? 3000 });
        let streamError: unknown;
        try {
          for await (const evt of backendEvents(client, scope ?? "project", {
            signal: context.signal, deadline: context.deadline, directory,
          })) {
            events.push(evt);
            if (events.length >= (maxEvents ?? 50)) break;
          }
        } catch (error) {
          // Only the polling window expiring normally is a successful empty
          // observation. Caller cancellation and connection errors stay visible.
          const timeout = error instanceof Error && error.name === "TimeoutError";
          const localDeadline = context.signal.aborted && context.signal.reason?.name === "TimeoutError" || timeout && Date.now() >= context.deadline;
          if (!localDeadline || extra?.signal?.aborted) streamError = error;
        } finally {
          context.dispose();
        }
        const formatted = events.map((e) => {
          try { return `[${e.event}] ${JSON.stringify(JSON.parse(e.data), null, 2)}`; }
          catch { return `[${e.event}] ${e.data}`; }
        }).join("\n\n");
        if (streamError) {
          const failure = toolError(streamError);
          return {
            ...failure,
            content: [...failure.content, ...(events.length ? [{ type: "text" as const, text: `Collected ${events.length} partial event(s) before the stream stopped:\n\n${formatted}` }] : [])],
            structuredContent: { events, partial: true, scope: scope ?? "project" },
          };
        }
        return {
          ...toolResult(events.length ? `Collected ${events.length} event(s):\n\n${formatted}` : "No events received during the polling period."),
          structuredContent: { events, partial: false, scope: scope ?? "project" },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
