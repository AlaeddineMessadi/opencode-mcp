import { operate } from "./backends/adapter.js";
/**
 * MCP Resources — expose OpenCode data as browseable resources.
 *
 * Resources let MCP clients (and LLMs) discover and read structured data
 * without needing to know the exact tool calls. They're perfect for
 * things like "show me the current project" or "list available sessions".
 */

import { McpServer, ResourceTemplate } from "./mcp-server.js";
import { OpenCodeClient } from "./client.js";
import { normalizeDirectory, redactSecrets, safeStringify } from "./helpers.js";

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
        const project = await operate(client, "projects.current", {  });
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
      const config = await operate(client, "configuration.get", {  });
      return {
        contents: [
          {
            uri: "opencode://config",
            mimeType: "application/json",
            text: safeStringify(redactSecrets(config)),
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
      const providers = await operate(client, "providers.list", {  });
      return {
        contents: [
          {
            uri: "opencode://providers",
            mimeType: "application/json",
            text: safeStringify(redactSecrets(providers)),
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
      const agents = await operate(client, "configuration.agents", {  });
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
      const commands = await operate(client, "configuration.commands", {  });
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
      const health = await operate(client, "lifecycle.health", {  });
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
        const vcs = await operate(client, "files.vcs", {  });
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

  // ─── Default-project session list ────────────────────────────────
  server.resource(
    "sessions",
    "opencode://sessions",
    {
      description: "All sessions",
      mimeType: "application/json",
    },
    async () => {
      const sessions = await operate(client, "sessions.list", {  });
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
      const mcp = await operate(client, "configuration.mcp", {  });
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
      const status = await operate(client, "files.status", {  });
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

  // URI path variables are percent-encoded components, including the complete
  // server-side directory. Never resolve these paths against the MCP host.
  const scalar = (value: string | string[] | undefined, name: string): string => {
    if (typeof value !== "string" || !value) throw new Error(`Missing resource ${name}`);
    return decodeURIComponent(value);
  };
  for (const [name, suffix, endpoint] of [
    ["project-scoped", "current", "projects.current"],
    ["sessions-scoped", "sessions", "sessions.list"],
  ] as const) {
    server.resource(name,
      new ResourceTemplate(`opencode://projects/{directory}/${suffix}`, { list: undefined }),
      { description: `Project-scoped ${suffix}; percent-encode the absolute server directory`, mimeType: "application/json" },
      async (uri, variables) => {
        const directory = normalizeDirectory(scalar(variables.directory, "directory"));
        const data = await operate(client, endpoint, { directory });
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: safeStringify(data) }] };
      },
    );
  }
  for (const [name, suffix, endpointSuffix] of [
    ["session-scoped", "", ""],
    ["session-messages-scoped", "/messages", "/message"],
  ] as const) {
    server.resource(name,
      new ResourceTemplate(`opencode://projects/{directory}/sessions/{sessionId}${suffix}`, { list: undefined }),
      { description: `Session ${suffix ? "messages" : "details"} in an explicitly scoped project`, mimeType: "application/json" },
      async (uri, variables) => {
        const directory = normalizeDirectory(scalar(variables.directory, "directory"));
        const sessionId = scalar(variables.sessionId, "sessionId");
        const data = await operate(client, endpointSuffix ? "messages.list" : "sessions.get", { sessionId, directory });
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: safeStringify(data) }] };
      },
    );
  }
}
