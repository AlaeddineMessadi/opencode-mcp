/**
 * TUI control tools — drive the OpenCode TUI remotely.
 * Useful for IDE integrations and automation.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import { toolResult, toolError } from "../helpers.js";

export function registerTuiTools(server: McpServer, client: OpenCodeClient) {
  server.tool(
    "opencode_tui_append_prompt",
    "Append text to the TUI's prompt input field",
    {
      text: z.string().describe("Text to append to the prompt"),
    },
    async ({ text }) => {
      try {
        await client.post("/tui/append-prompt", { text });
        return toolResult("Text appended to prompt.");
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_tui_submit_prompt",
    "Submit the current prompt in the TUI (equivalent to pressing Enter)",
    {},
    async () => {
      try {
        await client.post("/tui/submit-prompt");
        return toolResult("Prompt submitted.");
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_tui_clear_prompt",
    "Clear the current prompt text in the TUI",
    {},
    async () => {
      try {
        await client.post("/tui/clear-prompt");
        return toolResult("Prompt cleared.");
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_tui_execute_command",
    "Execute a slash command through the TUI (e.g. '/init', '/undo')",
    {
      command: z.string().describe("Command to execute (e.g. '/init')"),
    },
    async ({ command }) => {
      try {
        await client.post("/tui/execute-command", { command });
        return toolResult(`Command '${command}' executed.`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_tui_show_toast",
    "Show a toast notification in the TUI",
    {
      message: z.string().describe("Toast message text"),
      title: z.string().optional().describe("Optional toast title"),
      variant: z
        .enum(["info", "success", "warning", "error"])
        .optional()
        .describe("Toast variant (default: info)"),
    },
    async ({ message, title, variant }) => {
      try {
        const body: Record<string, string> = { message };
        if (title) body.title = title;
        if (variant) body.variant = variant;
        await client.post("/tui/show-toast", body);
        return toolResult("Toast shown.");
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_tui_open_help",
    "Open the help dialog in the TUI",
    {},
    async () => {
      try {
        await client.post("/tui/open-help");
        return toolResult("Help dialog opened.");
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_tui_open_sessions",
    "Open the session selector in the TUI",
    {},
    async () => {
      try {
        await client.post("/tui/open-sessions");
        return toolResult("Session selector opened.");
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_tui_open_models",
    "Open the model selector in the TUI",
    {},
    async () => {
      try {
        await client.post("/tui/open-models");
        return toolResult("Model selector opened.");
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_tui_open_themes",
    "Open the theme selector in the TUI",
    {},
    async () => {
      try {
        await client.post("/tui/open-themes");
        return toolResult("Theme selector opened.");
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
