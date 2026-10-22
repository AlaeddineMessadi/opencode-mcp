import { z } from "zod";
import { McpServer } from "../mcp-server.js";
import { OpenCodeClient } from "../client.js";
import { toolJson, toolError, toolResult, directoryParam, readOnly } from "../helpers.js";

export function registerMiscTools(server: McpServer, client: OpenCodeClient) {
  // --- Path & VCS ---

  server.tool(
    "opencode_path_get",
    "Get the active directory and project of the OpenCode server",
    {
      directory: directoryParam,
    },
    readOnly,
    async ({ directory }) => {
      try {
        const raw = await client.get("/api/location", undefined, directory);
        const location = raw as Record<string, unknown>;
        const lines: string[] = [];
        if (typeof location?.directory === "string") lines.push(`Directory: ${location.directory}`);
        const project = location?.project as Record<string, unknown> | undefined;
        if (project) {
          if (typeof project.id === "string") lines.push(`Project ID: ${project.id}`);
          if (typeof project.directory === "string") lines.push(`Project directory: ${project.directory}`);
        }
        return toolResult(lines.length > 0 ? lines.join("\n") : JSON.stringify(location, null, 2), false, { data: location });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_vcs_info",
    "Get VCS (version control) info for the current project (provider, branches)",
    {
      directory: directoryParam,
    },
    readOnly,
    async ({ directory }) => {
      try {
        const raw = await client.get("/api/vcs", undefined, directory);
        const v = raw as Record<string, unknown>;
        if (!v || typeof v !== "object") {
          return toolResult("No VCS info available.");
        }
        const lines: string[] = [];
        if (v.provider) lines.push(`Provider: ${v.provider}`);
        const branch = v.branch as Record<string, unknown> | undefined;
        if (branch) {
          if (branch.current) lines.push(`Branch: ${branch.current}`);
          if (branch.default) lines.push(`Default branch: ${branch.default}`);
        }
        if (lines.length === 0) {
          for (const [k, val] of Object.entries(v)) {
            lines.push(`${k}: ${typeof val === "object" ? JSON.stringify(val) : val}`);
          }
        }
        return toolResult(`## VCS Info\n${lines.join("\n")}`);
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
    readOnly,
    async ({ directory }) => {
      try {
        const agents = (await client.get("/api/agent", undefined, directory)) as Array<Record<string, unknown>>;
        if (!agents || agents.length === 0) {
          return toolResult("No agents found.");
        }
        const formatted = agents.map((a) => {
          const name = a.name ?? a.id ?? "?";
          const mode = a.mode ?? "?";
          const desc = a.description ?? "(no description)";
          const hidden = a.hidden === true ? " (hidden)" : "";
          return `- ${name} [${mode}]${hidden}: ${desc}`;
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
    readOnly,
    async ({ directory }) => {
      try {
        const raw = await client.get("/api/command", undefined, directory);
        const commands = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
        if (commands.length === 0) {
          return toolResult("No commands available.");
        }
        const lines = commands.map((c) => {
          const name = c.name ?? c.id ?? "?";
          const rawDesc = (c.description ?? c.desc ?? "") as string;
          const desc = rawDesc.split("\n")[0].slice(0, 120);
          return `- /${name}${desc ? `: ${desc}` : ""}`;
        });
        return toolResult(`## Commands (${commands.length})\n${lines.join("\n")}`);
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
    readOnly,
    async ({ directory }) => {
      try {
        const raw = await client.get("/api/mcp", undefined, directory);
        const servers = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
        if (servers.length === 0) {
          return toolResult("No MCP servers configured.");
        }
        const lines = servers.map((s) => {
          const name = s.name ?? s.id ?? "?";
          const status = (s.status as Record<string, unknown> | undefined)?.status ?? s.status ?? "unknown";
          return `- ${name}: ${status}`;
        });
        return toolResult(`## MCP Servers (${servers.length})\n${lines.join("\n")}`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_mcp_add",
    "Add or update an MCP server configuration in opencode",
    {
      name: z.string().describe("Name for the MCP server"),
      config: z
        .record(z.string(), z.unknown())
        .describe("MCP server configuration object (e.g. {type: 'local', command: [...]} or {type: 'remote', url: '...'})"),
      directory: directoryParam,
    },
    async ({ name, config, directory }) => {
      try {
        return toolJson(await client.put(`/api/experimental/mcp/${encodeURIComponent(name)}`, { config }, directory));
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
