import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import { toolJson, toolError, toolResult, directoryParam } from "../helpers.js";

export function registerMiscTools(server: McpServer, client: OpenCodeClient) {
  // --- Path & VCS ---

  server.tool(
    "opencode_path_get",
    "Get the current working path of the opencode server",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        return toolJson(await client.get("/path", undefined, directory));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_vcs_info",
    "Get VCS (version control) info for the current project (branch, remote, status)",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        return toolJson(await client.get("/vcs", undefined, directory));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- Instance ---

  server.tool(
    "opencode_instance_dispose",
    "Dispose the current opencode instance (shuts it down)",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        await client.post("/instance/dispose", undefined, { directory });
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
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        const agents = (await client.get("/agent", undefined, directory)) as Array<Record<string, unknown>>;
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
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        return toolJson(await client.get("/command", undefined, directory));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- LSP ---

  server.tool(
    "opencode_lsp_status",
    "Get the status of LSP (Language Server Protocol) servers",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        return toolJson(await client.get("/lsp", undefined, directory));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- Formatter ---

  server.tool(
    "opencode_formatter_status",
    "Get the status of configured formatters",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        return toolJson(await client.get("/formatter", undefined, directory));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- MCP servers ---

  server.tool(
    "opencode_mcp_status",
    "Get the status of all MCP servers configured in opencode",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        return toolJson(await client.get("/mcp", undefined, directory));
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
      directory: directoryParam,
    },
    async ({ name, config, directory }) => {
      try {
        return toolJson(await client.post("/mcp", { name, config }, { directory }));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- Tools (Experimental) ---

  server.tool(
    "opencode_tool_ids",
    "List all available tool IDs that the LLM can use (experimental)",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        return toolJson(await client.get("/experimental/tool/ids", undefined, directory));
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
      directory: directoryParam,
    },
    async ({ provider, model, directory }) => {
      try {
        return toolJson(
          await client.get("/experimental/tool", { provider, model }, directory),
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
      directory: directoryParam,
    },
    async ({ service, level, message, extra, directory }) => {
      try {
        const body: Record<string, unknown> = { service, level, message };
        if (extra) body.extra = extra;
        await client.post("/log", body, { directory });
        return toolResult(`Log entry written [${level}] ${service}: ${message}`);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
