import { z } from "zod";
import { McpServer } from "../mcp-server.js";
import { OpenCodeClient } from "../client.js";
import { toolJson, toolError, toolResult, directoryParam, destructive, readOnly } from "../helpers.js";

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
        const raw = await client.get("/path", undefined, directory);
        const p = raw as Record<string, unknown>;
        if (p && typeof p === "object" && !Array.isArray(p)) {
          const labels: Record<string, string> = {
            worktree: "Working directory",
            directory: "Project directory",
            config: "Config",
            state: "State",
            home: "Home",
          };
          const lines: string[] = [];
          for (const [key, label] of Object.entries(labels)) {
            if (p[key]) lines.push(`${label}: ${p[key]}`);
          }
          // Any extra keys not in our map
          for (const [k, v] of Object.entries(p)) {
            if (!labels[k]) lines.push(`${k}: ${v}`);
          }
          return toolResult(lines.length > 0 ? lines.join("\n") : JSON.stringify(p, null, 2));
        }
        return toolJson(raw);
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
        const raw = await client.get("/vcs", undefined, directory);
        const v = raw as Record<string, unknown>;
        if (!v || typeof v !== "object") {
          return toolResult("No VCS info available.");
        }
        const lines: string[] = [];
        if (v.branch) lines.push(`Branch: ${v.branch}`);
        if (v.remote) lines.push(`Remote: ${v.remote}`);
        if (v.sha) lines.push(`HEAD: ${v.sha}`);
        if (v.dirty !== undefined) lines.push(`Dirty: ${v.dirty}`);
        if (v.ahead !== undefined) lines.push(`Ahead: ${v.ahead}`);
        if (v.behind !== undefined) lines.push(`Behind: ${v.behind}`);
        if (v.type) lines.push(`Type: ${v.type}`);
        if (lines.length === 0) {
          // Fallback: show all keys
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

  // --- Instance ---

  server.tool(
    "opencode_instance_dispose",
    "Dispose the current opencode instance (shuts it down). WARNING: This is destructive and will terminate the server.",
    {
      directory: directoryParam,
    },
    destructive,
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
        const raw = await client.get("/command", undefined, directory);
        const commands = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
        if (commands.length === 0) {
          return toolResult("No commands available.");
        }
        const lines = commands.map((c) => {
          const name = c.name ?? c.id ?? "?";
          const rawDesc = (c.description ?? c.desc ?? "") as string;
          // Truncate to first line, cap at 120 chars to avoid multi-line descriptions leaking
          const desc = rawDesc.split("\n")[0].slice(0, 120);
          return `- /${name}${desc ? `: ${desc}` : ""}`;
        });
        return toolResult(`## Commands (${commands.length})\n${lines.join("\n")}`);
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
        const raw = await client.get("/lsp", undefined, directory);
        const servers = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
        if (servers.length === 0) {
          return toolResult("No LSP servers running.");
        }
        const lines = servers.map((s) => {
          const name = s.name ?? s.id ?? s.language ?? "?";
          const status = s.status ?? s.state ?? "unknown";
          const lang = s.language ? ` (${s.language})` : "";
          return `- ${name}${lang}: ${status}`;
        });
        return toolResult(`## LSP Servers (${servers.length})\n${lines.join("\n")}`);
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
        const raw = await client.get("/formatter", undefined, directory);
        const formatters = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
        if (formatters.length === 0) {
          return toolResult("No formatters configured.");
        }
        const enabled = formatters.filter((f) => f.enabled || f.status === "enabled" || f.active);
        const disabled = formatters.filter((f) => !enabled.includes(f));
        const lines: string[] = [];
        if (enabled.length > 0) {
          lines.push("**Enabled:**");
          for (const f of enabled) {
            const name = f.name ?? f.id ?? "?";
            const globs = f.globs ?? f.patterns ?? "";
            const globStr = Array.isArray(globs) ? ` (${globs.join(", ")})` : globs ? ` (${globs})` : "";
            lines.push(`- ${name}${globStr}`);
          }
        }
        if (disabled.length > 0) {
          lines.push(`\n+${disabled.length} more formatters available but not enabled.`);
        }
        return toolResult(
          `## Formatters (${enabled.length} enabled / ${formatters.length} total)\n${lines.join("\n")}`,
        );
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
        const raw = await client.get("/mcp", undefined, directory);
        // MCP status may be an object keyed by server name or an array
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          const entries = Object.entries(raw as Record<string, unknown>);
          if (entries.length === 0) {
            return toolResult("No MCP servers configured.");
          }
          const lines = entries.map(([name, value]) => {
            const s = value as Record<string, unknown>;
            const status = s.status ?? s.state ?? "unknown";
            const tools = s.tools;
            const toolCount = Array.isArray(tools) ? tools.length : typeof tools === "number" ? tools : "";
            const toolStr = toolCount !== "" ? ` | ${toolCount} tools` : "";
            return `- ${name}: ${status}${toolStr}`;
          });
          return toolResult(`## MCP Servers (${entries.length})\n${lines.join("\n")}`);
        }
        const servers = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
        if (servers.length === 0) {
          return toolResult("No MCP servers configured.");
        }
        const lines = servers.map((s) => {
          const name = s.name ?? s.id ?? "?";
          const status = s.status ?? s.state ?? "unknown";
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
        const raw = await client.get("/experimental/tool/ids", undefined, directory);
        const ids = Array.isArray(raw) ? raw as string[] : [];
        if (ids.length === 0) {
          return toolResult("No tools available.");
        }
        return toolResult(`## Tools (${ids.length})\n${ids.map((id) => `- ${id}`).join("\n")}`);
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
        const raw = await client.get("/experimental/tool", { provider, model }, directory);
        const tools = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
        if (tools.length === 0) {
          return toolResult("No tools available for this provider/model.");
        }
        const lines = tools.map((t) => {
          const id = t.id ?? t.name ?? "?";
          const desc = t.description as string | undefined;
          // Show first line of description only (many are multi-paragraph)
          const shortDesc = desc ? desc.split("\n")[0].slice(0, 120) : "";
          return `- ${id}${shortDesc ? `: ${shortDesc}` : ""}`;
        });
        return toolResult(
          `## Tools for ${provider}/${model} (${tools.length})\n${lines.join("\n")}`,
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
