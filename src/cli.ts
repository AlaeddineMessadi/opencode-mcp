export type CliArgs = { command: "stdio" | "help" | "version" } | { command: "doctor"; json: boolean; directory?: string };
export class CliUsageError extends Error {}
export const CLI_HELP = `Usage: opencode-mcp [doctor | --check] [--json] [--directory PATH]

No arguments starts the MCP stdio server.
  doctor, --check    Read-only readiness checks; never starts a server or model
  --json             Print versioned diagnostic JSON (doctor only)
  --directory PATH   Check a project path on the OpenCode server (doctor only)
  --help             Show this help
  --version          Show the package version

Doctor exits 0 when ready, 1 when checks fail, and 2 for invalid arguments.
Configure OPENCODE_BACKEND=auto|v1|v2 and optional OPENCODE_BASE_URL.
`;
export function parseCliArgs(args: string[]): CliArgs {
  if (!args.length) return { command: "stdio" };
  if (args.length === 1 && args[0] === "--help") return { command: "help" };
  if (args.length === 1 && args[0] === "--version") return { command: "version" };
  if (args[0] !== "doctor" && args[0] !== "--check") throw new CliUsageError("Expected doctor, --check, --help, or --version.");
  let json = false;
  let directory: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--json" && !json) { json = true; continue; }
    if (args[i] === "--directory" && directory === undefined && args[i + 1] && !args[i + 1].startsWith("--")) { directory = args[++i]; continue; }
    throw new CliUsageError("Invalid or duplicate doctor option. Use --json and --directory PATH.");
  }
  try { directory = normalizeDirectory(directory); }
  catch { throw new CliUsageError("--directory must be an absolute path on the OpenCode server, without control characters."); }
  return { command: "doctor", json, directory };
}
import { normalizeDirectory } from "./helpers.js";
