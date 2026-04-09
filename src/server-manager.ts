/**
 * Auto-detection and auto-start of the OpenCode headless server.
 *
 * This module handles:
 *  1. Checking if `opencode serve` is already running (health check)
 *  2. Finding the `opencode` binary on the system
 *  3. Spawning `opencode serve` as a child process if needed
 *  4. Graceful shutdown of the child process on exit
 *
 * Controlled via environment variables:
 *   OPENCODE_AUTO_SERVE  - Set to "false" to disable auto-start (default: true)
 *   OPENCODE_BASE_URL    - Base URL of the server (default: http://127.0.0.1:4096)
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ServerManagerOptions {
  baseUrl: string;
  /** Disable auto-start entirely. */
  autoServe?: boolean;
  /** Max time (ms) to wait for the server to become healthy after spawning. */
  startupTimeoutMs?: number;
  /** Username for HTTP basic auth (optional) */
  username?: string;
  /** Password for HTTP basic auth (optional) */
  password?: string;
}

export interface ServerStatus {
  running: boolean;
  version?: string;
  managedByUs: boolean;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 500;

/** Singleton child process reference so we can clean up on exit. */
let managedProcess: ChildProcess | null = null;
let shutdownRegistered = false;

/**
 * Check if the OpenCode server is already running by hitting the health endpoint.
 * Returns `{ healthy: true, version }` or `{ healthy: false }`.
 */
export async function isServerRunning(
  baseUrl: string,
  username?: string,
  password?: string,
): Promise<{ healthy: boolean; version?: string }> {
  try {
    const url = `${baseUrl.replace(/\/$/, "")}/global/health`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    
    const headers: Record<string, string> = {};
    if (password) {
      const user = username ?? "opencode";
      headers["Authorization"] = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
    }
    
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      const body = (await res.json()) as Record<string, unknown>;
      return {
        healthy: body.healthy === true,
        version: typeof body.version === "string" ? body.version : undefined,
      };
    }
    return { healthy: false };
  } catch {
    return { healthy: false };
  }
}

/**
 * Attempt to find the `opencode` binary on the system.
 * Returns the full path or null if not found.
 */
export async function findBinary(): Promise<string | null> {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(cmd, ["opencode"]);
    const path = stdout.trim().split("\n")[0]?.trim();
    return path || null;
  } catch {
    return null;
  }
}

/**
 * Get the installed OpenCode version. Returns null if not installed.
 */
export async function getInstalledVersion(
  binaryPath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binaryPath, ["--version"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Build installation instructions for when the binary is not found.
 */
export function getInstallInstructions(): string {
  return [
    "OpenCode is not installed on this system.",
    "",
    "Install it using one of these methods:",
    "  curl -fsSL https://opencode.ai/install | bash",
    "  npm i -g opencode-ai",
    "  brew install sst/tap/opencode",
    "",
    "For more options: https://opencode.ai",
    "",
    "After installing, restart the MCP server.",
    "To disable auto-start: set OPENCODE_AUTO_SERVE=false",
  ].join("\n");
}

/**
 * Parse host and port from a base URL.
 */
function parseBaseUrl(baseUrl: string): { hostname: string; port: number } {
  const url = new URL(baseUrl);
  return {
    hostname: url.hostname,
    port: url.port ? parseInt(url.port, 10) : 4096,
  };
}

/**
 * Poll the health endpoint until the server responds or timeout elapses.
 */
async function waitForHealthy(
  baseUrl: string,
  timeoutMs: number,
  username?: string,
  password?: string,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { healthy } = await isServerRunning(baseUrl, username, password);
    if (healthy) return true;
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * Register process-exit handlers to kill the managed child process.
 * Only registers once even if called multiple times.
 */
function registerShutdownHandlers(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  const cleanup = () => {
    if (managedProcess && !managedProcess.killed) {
      managedProcess.kill("SIGTERM");
      managedProcess = null;
    }
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}

/**
 * Spawn `opencode serve` as a background child process.
 * Waits until the health endpoint responds or the timeout elapses.
 *
 * @throws Error if the binary is not found or the server fails to start.
 */
export async function startServer(
  binaryPath: string,
  baseUrl: string,
  timeoutMs: number = DEFAULT_STARTUP_TIMEOUT_MS,
  username?: string,
  password?: string,
): Promise<{ version?: string }> {
  const { hostname, port } = parseBaseUrl(baseUrl);

  const args = ["serve", "--port", String(port)];
  if (hostname !== "127.0.0.1" && hostname !== "localhost") {
    args.push("--hostname", hostname);
  }

  const child = spawn(binaryPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  managedProcess = child;
  registerShutdownHandlers();

  // Collect stderr for diagnostics if the process exits early.
  let stderrOutput = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrOutput += chunk.toString();
  });

  // Also watch stdout for the "listening" line (informational).
  let stdoutOutput = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutOutput += chunk.toString();
  });

  // Reject early if the child process exits before becoming healthy.
  const earlyExit = new Promise<never>((_, reject) => {
    child.on("error", (err) => {
      reject(
        new Error(`Failed to start opencode serve: ${err.message}`),
      );
    });
    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        reject(
          new Error(
            `opencode serve exited with code ${code}.\n${stderrOutput || stdoutOutput}`,
          ),
        );
      }
    });
  });

  // Race: either the server becomes healthy or the child crashes.
  const healthy = await Promise.race([
    waitForHealthy(baseUrl, timeoutMs, username, password),
    earlyExit.catch(() => false as const),
  ]);

  if (!healthy) {
    // Kill the child if it's still around.
    if (!child.killed) child.kill("SIGTERM");
    managedProcess = null;
    throw new Error(
      `opencode serve did not become healthy within ${timeoutMs / 1000}s.\n` +
        `stderr: ${stderrOutput}\nstdout: ${stdoutOutput}`,
    );
  }

  // Grab the version from the now-running server.
  const status = await isServerRunning(baseUrl, username, password);
  return { version: status.version };
}

/**
 * Stop the managed child process (if we started one).
 */
export function stopServer(): void {
  if (managedProcess && !managedProcess.killed) {
    managedProcess.kill("SIGTERM");
    managedProcess = null;
  }
}

/**
 * Main entry point: ensure the OpenCode server is available.
 *
 * Returns a status object describing the result.
 * Logs progress to stderr (MCP servers use stdout for the transport).
 *
 * @throws Error if the server cannot be reached and auto-start fails.
 */
export async function ensureServer(
  opts: ServerManagerOptions,
): Promise<ServerStatus> {
  const baseUrl = opts.baseUrl;
  const autoServe = opts.autoServe !== false;
  const timeoutMs = opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

  // Step 1: Check if server is already running.
  const existing = await isServerRunning(baseUrl, opts.username, opts.password);
  if (existing.healthy) {
    console.error(
      `OpenCode server already running at ${baseUrl} (v${existing.version ?? "unknown"})`,
    );
    return {
      running: true,
      version: existing.version,
      managedByUs: false,
    };
  }

  // If auto-serve is disabled, just report that the server isn't running.
  if (!autoServe) {
    throw new Error(
      `OpenCode server is not running at ${baseUrl} and OPENCODE_AUTO_SERVE=false.\n` +
        `Start it manually: opencode serve`,
    );
  }

  // Step 2: Find the opencode binary.
  console.error("OpenCode server not detected, attempting auto-start...");
  const binaryPath = await findBinary();
  if (!binaryPath) {
    throw new Error(getInstallInstructions());
  }

  const version = await getInstalledVersion(binaryPath);
  console.error(
    `Found opencode binary at ${binaryPath}${version ? ` (${version})` : ""}`,
  );

  // Step 3: Start the server.
  console.error(`Starting: opencode serve --port ${parseBaseUrl(baseUrl).port}`);
  const result = await startServer(
    binaryPath,
    baseUrl,
    timeoutMs,
    opts.username,
    opts.password,
  );
  console.error(
    `OpenCode server started successfully (v${result.version ?? "unknown"})`,
  );

  return {
    running: true,
    version: result.version,
    managedByUs: true,
  };
}
