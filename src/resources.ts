/**
 * MCP Resources — expose OpenCode data as browseable resources.
 *
 * Resources let MCP clients (and LLMs) discover and read structured data
 * without needing to know the exact tool calls. They're perfect for
 * things like "show me the current project" or "list available sessions".
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "./client.js";
import { safeStringify } from "./helpers.js";

export function registerResources(server: McpServer, client: OpenCodeClient) {
  // ─── Current Project ──────────────────────────────────────────────
  server.resource(
    "project-current",
    "opencode://project/current",
    {
      description: "The currently active OpenCode project",
      mimeType: "application/json",
    },
    async () => {
      try {
        const project = await client.get("/project/current");
        return {
          contents: [
            {
              uri: "opencode://project/current",
              mimeType: "application/json",
              text: safeStringify(project),
            },
          ],
        };
      } catch {
        return {
          contents: [
            {
              uri: "opencode://project/current",
              mimeType: "text/plain",
              text: "No project currently active.",
            },
          ],
        };
      }
    },
  );

  // ─── Config ───────────────────────────────────────────────────────
  server.resource(
    "config",
    "opencode://config",
    {
      description: "Current OpenCode configuration",
      mimeType: "application/json",
    },
    async () => {
      const config = await client.get("/config");
      return {
        contents: [
          {
            uri: "opencode://config",
            mimeType: "application/json",
            text: safeStringify(config),
          },
        ],
      };
    },
  );

  // ─── Providers ────────────────────────────────────────────────────
  server.resource(
    "providers",
    "opencode://providers",
    {
      description:
        "All available LLM providers, their models, and connection status",
      mimeType: "application/json",
    },
    async () => {
      const providers = await client.get("/provider");
      return {
        contents: [
          {
            uri: "opencode://providers",
            mimeType: "application/json",
            text: safeStringify(providers),
          },
        ],
      };
    },
  );

  // ─── Agents ───────────────────────────────────────────────────────
  server.resource(
    "agents",
    "opencode://agents",
    {
      description: "All available agents and their configurations",
      mimeType: "application/json",
    },
    async () => {
      const agents = await client.get("/agent");
      return {
        contents: [
          {
            uri: "opencode://agents",
            mimeType: "application/json",
            text: safeStringify(agents),
          },
        ],
      };
    },
  );

  // ─── Commands ─────────────────────────────────────────────────────
  server.resource(
    "commands",
    "opencode://commands",
    {
      description: "All available commands (built-in and custom)",
      mimeType: "application/json",
    },
    async () => {
      const commands = await client.get("/command");
      return {
        contents: [
          {
            uri: "opencode://commands",
            mimeType: "application/json",
            text: safeStringify(commands),
          },
        ],
      };
    },
  );

  // ─── Server Health ────────────────────────────────────────────────
  server.resource(
    "health",
    "opencode://health",
    {
      description: "OpenCode server health and version",
      mimeType: "application/json",
    },
    async () => {
      const health = await client.get("/global/health");
      return {
        contents: [
          {
            uri: "opencode://health",
            mimeType: "application/json",
            text: safeStringify(health),
          },
        ],
      };
    },
  );

  // ─── VCS Info ─────────────────────────────────────────────────────
  server.resource(
    "vcs",
    "opencode://vcs",
    {
      description: "Version control system info for the current project",
      mimeType: "application/json",
    },
    async () => {
      try {
        const vcs = await client.get("/vcs");
        return {
          contents: [
            {
              uri: "opencode://vcs",
              mimeType: "application/json",
              text: safeStringify(vcs),
            },
          ],
        };
      } catch {
        return {
          contents: [
            {
              uri: "opencode://vcs",
              mimeType: "text/plain",
              text: "No VCS information available.",
            },
          ],
        };
      }
    },
  );

  // ─── Session list (resource template) ─────────────────────────────
  server.resource(
    "sessions",
    "opencode://sessions",
    {
      description: "All sessions",
      mimeType: "application/json",
    },
    async () => {
      const sessions = await client.get("/session");
      return {
        contents: [
          {
            uri: "opencode://sessions",
            mimeType: "application/json",
            text: safeStringify(sessions),
          },
        ],
      };
    },
  );

  // ─── MCP Servers ──────────────────────────────────────────────────
  server.resource(
    "mcp-servers",
    "opencode://mcp-servers",
    {
      description: "Status of all configured MCP servers in OpenCode",
      mimeType: "application/json",
    },
    async () => {
      const mcp = await client.get("/mcp");
      return {
        contents: [
          {
            uri: "opencode://mcp-servers",
            mimeType: "application/json",
            text: safeStringify(mcp),
          },
        ],
      };
    },
  );

  // ─── File Status ──────────────────────────────────────────────────
  server.resource(
    "file-status",
    "opencode://file-status",
    {
      description: "VCS status of all tracked files",
      mimeType: "application/json",
    },
    async () => {
      const status = await client.get("/file/status");
      return {
        contents: [
          {
            uri: "opencode://file-status",
            mimeType: "application/json",
            text: safeStringify(status),
          },
        ],
      };
    },
  );
}
