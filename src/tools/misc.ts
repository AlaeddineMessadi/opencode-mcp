import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import { toolJson, toolError, toolResult } from "../helpers.js";

export function registerMiscTools(server: McpServer, client: OpenCodeClient) {
  // --- Path & VCS ---

  server.tool(
    "opencode_path_get",
    "Get the current working path of the opencode server",
    {},
    async () => {
      try {
        return toolJson(await client.get("/path"));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_vcs_info",
    "Get VCS (version control) info for the current project (branch, remote, status)",
    {},
    async () => {
      try {
        return toolJson(await client.get("/vcs"));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- Instance ---

  server.tool(
    "opencode_instance_dispose",
    "Dispose the current opencode instance (shuts it down)",
    {},
    async () => {
      try {
        await client.post("/instance/dispose");
        return toolResult("Instance disposed.");
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- Agents ---

  server.tool(
    "opencode_agent_list",
    "List all available agents with their names, descriptions, and modes (primary/subagent)",
    {},
    async () => {
      try {
        const agents = (await client.get("/agent")) as Array<Record<string, unknown>>;
        if (!agents || agents.length === 0) {
          return toolResult("No agents found.");
        }
        const formatted = agents.map((a) => {
          const name = a.name ?? a.id ?? "?";
          const mode = a.mode ?? "?";
          const desc = a.description ?? "(no description)";
          return `- ${name} [${mode}]: ${desc}`;
        }).join("\n");
        return toolResult(formatted);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- Commands ---

  server.tool(
    "opencode_command_list",
    "List all available commands (built-in and custom slash commands)",
    {},
    async () => {
      try {
        return toolJson(await client.get("/command"));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- LSP ---

  server.tool(
    "opencode_lsp_status",
    "Get the status of LSP (Language Server Protocol) servers",
    {},
    async () => {
      try {
        return toolJson(await client.get("/lsp"));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- Formatter ---

  server.tool(
    "opencode_formatter_status",
    "Get the status of configured formatters",
    {},
    async () => {
      try {
        return toolJson(await client.get("/formatter"));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- MCP servers ---

  server.tool(
    "opencode_mcp_status",
    "Get the status of all MCP servers configured in opencode",
    {},
    async () => {
      try {
        return toolJson(await client.get("/mcp"));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_mcp_add",
    "Add an MCP server dynamically to opencode",
    {
      name: z.string().describe("Name for the MCP server"),
      config: z
        .record(z.string(), z.unknown())
        .describe("MCP server configuration object"),
    },
    async ({ name, config }) => {
      try {
        return toolJson(await client.post("/mcp", { name, config }));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- Tools (Experimental) ---

  server.tool(
    "opencode_tool_ids",
    "List all available tool IDs that the LLM can use (experimental)",
    {},
    async () => {
      try {
        return toolJson(await client.get("/experimental/tool/ids"));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_tool_list",
    "List tools with JSON schemas for a given provider and model (experimental)",
    {
      provider: z.string().describe("Provider ID"),
      model: z.string().describe("Model ID"),
    },
    async ({ provider, model }) => {
      try {
        return toolJson(
          await client.get("/experimental/tool", { provider, model }),
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- Logging ---

  server.tool(
    "opencode_log",
    "Write a log entry to the opencode server",
    {
      service: z.string().describe("Service name for the log entry"),
      level: z
        .enum(["debug", "info", "warn", "error"])
        .describe("Log level"),
      message: z.string().describe("Log message"),
      extra: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Extra data to include in the log entry"),
    },
    async ({ service, level, message, extra }) => {
      try {
        const body: Record<string, unknown> = { service, level, message };
        if (extra) body.extra = extra;
        await client.post("/log", body);
        return toolResult(`Log entry written [${level}] ${service}: ${message}`);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
