/**
 * Event streaming tools — subscribe to real-time events from OpenCode.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import { toolResult, toolError, directoryParam } from "../helpers.js";

export function registerEventTools(
  server: McpServer,
  client: OpenCodeClient,
) {
  server.tool(
    "opencode_events_poll",
    "Poll for recent events from the OpenCode server. Collects events for the specified duration and returns them. Useful for monitoring session activity, deployments, and system changes.",
    {
      durationMs: z
        .number()
        .optional()
        .describe(
          "How long to collect events in milliseconds (default: 3000, max: 30000)",
        ),
      maxEvents: z
        .number()
        .optional()
        .describe("Maximum number of events to collect (default: 50)"),
      directory: directoryParam,
    },
    async ({ durationMs, maxEvents, directory: _directory }) => {
      try {
        const duration = Math.min(durationMs ?? 3000, 30000);
        const max = maxEvents ?? 50;
        const events: Array<{ event: string; data: string }> = [];

        // Note: SSE subscribeSSE does not currently support the directory
        // header. The event stream is server-wide. The directory param is
        // accepted for API consistency but not forwarded to SSE.

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), duration);

        try {
          for await (const evt of client.subscribeSSE("/event")) {
            events.push(evt);
            if (events.length >= max) break;
            if (controller.signal.aborted) break;
          }
        } catch {
          // SSE connection will error when aborted — that's expected
        } finally {
          clearTimeout(timeout);
        }

        if (events.length === 0) {
          return toolResult("No events received during the polling period.");
        }

        const formatted = events
          .map((e) => {
            try {
              const parsed = JSON.parse(e.data);
              return `[${e.event}] ${JSON.stringify(parsed, null, 2)}`;
            } catch {
              return `[${e.event}] ${e.data}`;
            }
          })
          .join("\n\n");

        return toolResult(
          `Collected ${events.length} event(s):\n\n${formatted}`,
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
