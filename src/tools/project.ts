import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../client.js";
import { toolJson, toolError, toolResult, directoryParam } from "../helpers.js";
import { z } from "zod";
import { mkdir, realpath, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import pathUtil from "node:path";

/**
 * Directories the MCP refuses to create or open as a project root.
 * Compared against both the lexical resolved path AND the realpath result,
 * so symlinks like `/tmp/safe -> /etc` cannot bypass the deny-list.
 *
 * `/var` is deliberately NOT on this list: macOS's user temp directory
 * lives at `/var/folders/...`, and many cache/state paths under `/var`
 * are legitimately user-writable. The truly dangerous targets are the
 * binary, configuration, kernel, and device trees below.
 *
 * On macOS several of these are themselves symlinks into `/private`
 * (e.g. `/etc -> /private/etc`), so we expand each entry to its realpath
 * once at module load and check against both forms. A symlink pointing
 * at `/etc` therefore resolves to `/private/etc` and is still blocked.
 */
const FORBIDDEN_ROOT_INPUT = [
  "/",
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/sys",
  "/proc",
  "/dev",
];

const FORBIDDEN_ROOTS: readonly string[] = (() => {
  const set = new Set<string>(FORBIDDEN_ROOT_INPUT);
  for (const root of FORBIDDEN_ROOT_INPUT) {
    try {
      set.add(realpathSync(root));
    } catch {
      // Root may not exist on this platform (e.g. /proc on macOS,
      // /sys on Windows). Skip — the lexical form is still blocked.
    }
  }
  return [...set];
})();

function isForbiddenRoot(p: string): boolean {
  return FORBIDDEN_ROOTS.some(
    (root) => p === root || p.startsWith(root + pathUtil.sep),
  );
}

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
        // ── Input validation ────────────────────────────────────────
        if (/[\0\r\n]/.test(path)) {
          throw new Error(
            "path must not contain NUL or CR/LF characters",
          );
        }
        if (!pathUtil.isAbsolute(path)) {
          throw new Error(`path must be an absolute path: ${path}`);
        }

        // ── First pass: reject obvious system roots before any I/O ──
        const resolvedPath = pathUtil.resolve(path);
        if (isForbiddenRoot(resolvedPath)) {
          throw new Error(
            `System directories are not allowed: ${resolvedPath}`,
          );
        }

        // ── Create-or-verify the directory ──────────────────────────
        // `mkdir -p` is idempotent on existing directories. If the
        // path is an existing FILE (not a dir), this throws EEXIST or
        // ENOTDIR, which we surface to the caller. This collapses the
        // previous stat()→mkdir() TOCTOU window into a single syscall.
        try {
          await mkdir(resolvedPath, { recursive: true });
        } catch (err: any) {
          if (err.code === "EEXIST" || err.code === "ENOTDIR") {
            throw new Error(
              `Target exists but is not a directory: ${resolvedPath}`,
            );
          }
          throw err;
        }

        // ── Second pass: re-check after symlink resolution ─────────
        // `path.resolve` only canonicalizes lexically. A symlink at
        // `/tmp/safe -> /etc` would pass the first forbidden-roots
        // check but realpath unmasks it. Re-running the deny-list on
        // the canonical path closes that gap.
        const realPath = await realpath(resolvedPath);
        if (isForbiddenRoot(realPath)) {
          throw new Error(
            `System directories are not allowed (resolved via symlink to: ${realPath})`,
          );
        }

        // Post-condition: the realpath target must still be a directory
        // (paranoia — `mkdir -p` above should guarantee this, but a
        // race with a concurrent unlink+symlink could in principle
        // change it).
        const stats = await stat(realPath);
        if (!stats.isDirectory()) {
          throw new Error(
            `Target exists but is not a directory: ${realPath}`,
          );
        }

        // ── Register with OpenCode server (best-effort) ─────────────
        try {
          await client.get("/project/current", undefined, realPath);
        } catch (e) {
          console.error(
            `opencode_project_init: project ping failed for ${realPath}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }

        return toolResult(
          `Successfully initialized project directory at: ${realPath}\n\nYou can now use this path as the \`directory\` parameter in \`opencode_ask\`, \`opencode_run\`, or \`opencode_session_create\` to spawn an isolated agent workload.`,
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
