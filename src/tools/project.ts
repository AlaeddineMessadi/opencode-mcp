import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import { toolJson, toolError, toolResult, directoryParam } from "../helpers.js";
import { z } from "zod";
import { mkdir, stat } from "node:fs/promises";
import pathUtil from "node:path";

/** Format a project object into a compact summary. */
function formatProject(p: Record<string, unknown>): string {
  const worktree = (p.worktree ?? "unknown") as string;
  const name = (worktree !== "unknown" ? worktree.split("/").filter(Boolean).pop() : undefined)
    ?? p.name ?? p.id ?? "unknown";
  const lines: string[] = [];
  lines.push(`Name: ${name}`);
  lines.push(`Path: ${worktree}`);
  if (p.vcs) lines.push(`VCS: ${p.vcs}`);
  if (p.id) lines.push(`ID: ${p.id}`);
  const time = p.time as Record<string, unknown> | undefined;
  if (time?.created) {
    lines.push(`Created: ${new Date(time.created as number).toISOString()}`);
  }
  if (time?.updated) {
    lines.push(`Updated: ${new Date(time.updated as number).toISOString()}`);
  }
  return lines.join("\n");
}

export function registerProjectTools(
  server: McpServer,
  client: OpenCodeClient,
) {
  server.tool(
    "opencode_project_list",
    "List all projects known to the opencode server",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        const raw = await client.get("/project", undefined, directory);
        const projects = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
        if (projects.length === 0) {
          return toolResult("No projects found.");
        }
        const lines = projects.map((p) => {
          const worktree = (p.worktree ?? "?") as string;
          const name = (worktree !== "?" ? worktree.split("/").filter(Boolean).pop() : undefined)
            ?? p.name ?? p.id ?? "(root)";
          const vcs = p.vcs ? ` [${p.vcs}]` : "";
          return `- ${name}: ${worktree}${vcs}`;
        });
        return toolResult(`## Projects (${projects.length})\n${lines.join("\n")}`);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_project_init",
    "Initialize or open a project directory to host an independent OpenCode session. Use this to create new empty folders, or to explicitly open preexisting projects on the host machine for parallel code generation workloads.",
    {
      path: z
        .string()
        .describe("The absolute file path where the project directory is located or should be created."),
    },
    async ({ path }) => {
      try {
        if (path.includes("\0")) {
          throw new Error("path contains NUL bytes");
        }
        if (!pathUtil.isAbsolute(path)) {
          throw new Error(`path must be an absolute path: ${path}`);
        }
        const resolvedPath = pathUtil.resolve(path);

        const forbiddenRoots = ["/", "/etc", "/usr", "/var", "/bin", "/sbin", "/sys", "/proc", "/dev"];
        if (forbiddenRoots.some(root => resolvedPath === root || resolvedPath.startsWith(root + pathUtil.sep))) {
          throw new Error(`System directories are not allowed: ${resolvedPath}`);
        }

        try {
          const stats = await stat(resolvedPath);
          if (!stats.isDirectory()) {
            throw new Error(`Target exists but is not a directory: ${resolvedPath}`);
          }
        } catch (err: any) {
          if (err.code === "ENOENT") {
            await mkdir(resolvedPath, { recursive: true });
          } else {
            throw err;
          }
        }
        
        // Ping OpenCode server in this new directory so it registers as a project
        try {
          await client.get("/project/current", undefined, resolvedPath);
        } catch (e) {
          // Best-effort: the directory is already created.
          console.error(
            `opencode_project_init: project ping failed for ${resolvedPath}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        
        return toolResult(
          `Successfully initialized project directory at: ${resolvedPath}\n\nYou can now use this path as the \`directory\` parameter in \`opencode_ask\`, \`opencode_run\`, or \`opencode_session_create\` to spawn an isolated agent workload.`
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "opencode_project_current",
    "Get the current active project",
    {
      directory: directoryParam,
    },
    async ({ directory }) => {
      try {
        const raw = await client.get("/project/current", undefined, directory);
        const p = raw as Record<string, unknown>;
        if (p && typeof p === "object") {
          return toolResult(formatProject(p));
        }
        return toolJson(raw);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
