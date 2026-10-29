import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

export interface ServerManagerOptions {
  baseUrl: string;
  autoServe?: boolean;
  /**
   * HTTP Basic auth credentials forwarded to the `/api/info` probe.
   * OpenCode 2.x servers enforce authentication; when the server was started
   * without `OPENCODE_SERVER_PASSWORD` it generates one and prints it to
   * stdout, which is only recoverable by the process that started it.
   */
  username?: string;
  password?: string;
  /** Full `Authorization` header value; takes precedence over Basic credentials. */
  authorization?: string;
}

export interface ServerStatus {
  running: boolean;
  version?: string;
  managedByUs: boolean;
  url?: string;
  /** Password generated for a server started by this process. */
  password?: string;
  /** The endpoint exists but rejected the supplied credentials. */
  authFailed?: boolean;
  /** A legacy OpenCode 1.x server is running at the URL. */
  legacy?: boolean;
}

/**
 * Build an `Authorization: Basic ...` header value, or undefined when no
 * password is configured. Mirrors the helper in `src/client.ts` to keep the
 * two HTTP entry points consistent.
 */
function buildBasicAuthHeader(
  username?: string,
  password?: string,
): string | undefined {
  if (!password) return undefined;
  const user = username ?? "opencode";
  return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
}

let managedServer: { proc: ChildProcess; url: string } | null = null;
let shutdownRegistered = false;

export function resetShutdownRegisteredForTests(): void {
  shutdownRegistered = false;
  managedServer = null;
}

/**
 * In-flight startup promises, keyed by normalized `baseUrl`. Serializes
 * concurrent `ensureServer` callers so only one of them spawns a server per
 * target URL — others awaiting the same key receive the same result.
 * Prevents EADDRINUSE / leaked server handles when two requests hit the MCP
 * simultaneously and both observe the initial health probe as unhealthy.
 */
const startServerInFlight = new Map<
  string,
  Promise<{ url: string; version?: string; password?: string }>
>();

export function registerShutdownHandlers(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  const cleanup = () => {
    if (managedServer) {
      killManagedServer();
    }
  };

  const shutdown = () => {
    cleanup();
    process.exit(0);
  };

  process.on("exit", cleanup);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);

  if (process.stdin) {
    process.stdin.on("end", shutdown);
    process.stdin.on("close", shutdown);
  }
}

function killManagedServer(): void {
  if (!managedServer) return;
  const { proc } = managedServer;
  managedServer = null;
  try { proc.kill(); } catch { /* already gone */ }
}

function parseBaseUrl(baseUrl: string): { hostname: string; port: number } {
  const url = new URL(baseUrl);
  return {
    hostname: url.hostname,
    port: url.port ? parseInt(url.port, 10) : 4096,
  };
}

/**
 * Probe an OpenCode 2.x server via `GET /api/info`.
 *
 * The response also identifies legacy 1.x servers (which serve `/global/health`
 * but not `/api/info`) and authentication failures, so callers can produce a
 * precise error instead of a generic "not running".
 */
export async function isServerRunning(
  baseUrl: string,
  username?: string,
  password?: string,
  authorization?: string,
): Promise<{ healthy: boolean; version?: string; authFailed?: boolean; legacy?: boolean }> {
  const base = baseUrl.replace(/\/$/, "");
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    const authHeader = authorization ?? buildBasicAuthHeader(username, password);
    if (authHeader) {
      headers["Authorization"] = authHeader;
    }
    const response = await fetch(`${base}/api/info`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000),
    });
    if (response.status === 401) {
      // The server is alive but rejected our (possibly absent) password.
      return { healthy: false, authFailed: true };
    }
    if (response.ok) {
      const info = await response.json() as any;
      return {
        healthy: true,
        version: typeof info?.version === "string" ? info.version : undefined,
      };
    }
    if (response.status === 404) {
      return await probeLegacy(base);
    }
    return { healthy: false };
  } catch {
    // Connection-level failure: fall back to the legacy probe before declaring
    // the endpoint dead, in case a 1.x server is running.
    return await probeLegacy(base);
  }
}

/** Detect an OpenCode 1.x server, which has no `/api/info` route. */
async function probeLegacy(base: string): Promise<{ healthy: boolean; legacy?: boolean }> {
  try {
    const response = await fetch(`${base}/global/health`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(2000),
    });
    const type = response.headers.get("content-type") ?? "";
    if (response.ok && type.includes("application/json")) {
      const body = await response.json() as any;
      if (body && typeof body === "object" && "healthy" in body) return { healthy: false, legacy: true };
    }
  } catch { /* unreachable or SPA fallback */ }
  return { healthy: false };
}

export async function startServer(
  baseUrl: string,
  timeoutMs: number = 30000,
): Promise<{ url: string; version?: string; password?: string }> {
  const target = new URL(baseUrl);
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.pathname !== "/") {
    throw new Error("Auto-start requires a local loopback HTTP URL without a path prefix. Start remote servers manually and set OPENCODE_BASE_URL.");
  }
  const { hostname, port } = parseBaseUrl(baseUrl);

  console.error(`Starting OpenCode server on ${hostname}:${port}`);

  // OpenCode 2.x enforces HTTP Basic auth. Generate a private password for the
  // child process so this MCP can authenticate without depending on stdout
  // parsing, then probe the server with the same credentials.
  const password = randomBytes(24).toString("base64url");
  const proc = spawn("opencode", ["serve", `--hostname=${hostname}`, `--port=${port}`], {
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let settled = false;
  const url = await new Promise<string>((resolve, reject) => {
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killSpawned();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error(`Timeout waiting for the OpenCode server to start after ${timeoutMs}ms`));
    }, timeoutMs);
    const killSpawned = () => {
      try { proc.kill(); } catch { /* already gone */ }
    };
    let output = "";
    const onLine = (line: string) => {
      if (settled) return;
      output += line + "\n";
      // OpenCode 2.x prints `server listening on http://host:port`.
      const match = line.match(/server listening on (https?:\/\/\S+)/);
      if (match) {
        settled = true;
        clearTimeout(timer);
        resolve(match[1]);
        return;
      }
      if (/error|EADDRINUSE/i.test(line) && /listen|bind|server/i.test(line)) {
        fail(new Error(`OpenCode server failed to start: ${line.trim()}`));
      }
    };
    // Buffer per stream so a line split across two reads is still matched.
    const lineReader = () => {
      let pending = "";
      return (chunk: Buffer) => {
        pending += chunk.toString("utf8");
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        lines.forEach(onLine);
      };
    };
    proc.stdout?.on("data", lineReader());
    proc.stderr?.on("data", lineReader());
    proc.on("exit", (code) => {
      if (!settled) fail(new Error(`OpenCode server exited before listening (code ${code})${output ? `\n${output.trim()}` : ""}`));
    });
    proc.on("error", (error) => {
      if (!settled) fail(error instanceof Error ? error : new Error(String(error)));
    });
  });

  managedServer = { proc, url };
  registerShutdownHandlers();

  // Wait until the server answers /api/info with our credentials.
  const deadline = Date.now() + Math.min(timeoutMs, 15000);
  let status = await isServerRunning(url, "opencode", password);
  while (!status.healthy && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    status = await isServerRunning(url, "opencode", password);
  }
  if (!status.healthy) {
    killManagedServer();
    throw new Error(`OpenCode server started at ${url} but did not become healthy`);
  }
  return { url, version: status.version, password };
}

export function stopServer(): void {
  killManagedServer();
}

export async function ensureServer(
  opts: ServerManagerOptions,
): Promise<ServerStatus> {
  const baseUrl = opts.baseUrl;
  const autoServe = opts.autoServe === true;

  const existing = await isServerRunning(baseUrl, opts.username, opts.password, opts.authorization);
  if (existing.healthy) {
    console.error(
      `OpenCode server already running at ${baseUrl} (v${existing.version ?? "unknown"})`,
    );
    return {
      running: true,
      version: existing.version,
      managedByUs: false,
      url: baseUrl,
    };
  }
  if (existing.legacy) {
    throw new Error(
      `OpenCode 1.x server detected at ${baseUrl}; opencode-mcp 4.x requires OpenCode 2.x or newer.\n` +
        `Upgrade OpenCode (https://opencode.ai/docs/) and restart its server.`,
    );
  }
  if (existing.authFailed) {
    throw new Error(
      `OpenCode server at ${baseUrl} rejected the configured credentials (HTTP 401).\n` +
        `Set OPENCODE_SERVER_PASSWORD to the server's password. OpenCode 2.x prints a generated\n` +
        `password at startup when none is configured.`,
    );
  }

  if (!autoServe) {
    throw new Error(
      `OpenCode server is not running at ${baseUrl} and OPENCODE_AUTO_SERVE=false.\n` +
        `Start it manually: opencode serve --hostname 127.0.0.1 --port 4096\n` +
        `Or reuse a TUI started with opencode --port 4096. Set OPENCODE_BASE_URL to its URL and\n` +
        `OPENCODE_SERVER_PASSWORD to its password (printed on startup).\n` +
        `Set OPENCODE_AUTO_SERVE=true only to explicitly allow a separate local server.`,
    );
  }

  console.error("OpenCode server not detected, attempting auto-start...");
  // Coalesce concurrent startups per-baseUrl — see the
  // `startServerInFlight` declaration for rationale.
  const startupKey = baseUrl.replace(/\/$/, "");
  let inFlight = startServerInFlight.get(startupKey);
  if (!inFlight) {
    inFlight = startServer(startupKey).finally(() => {
      startServerInFlight.delete(startupKey);
    });
    startServerInFlight.set(startupKey, inFlight);
  }
  const result = await inFlight;
  console.error(`OpenCode server started successfully on ${result.url}`);

  return {
    running: true,
    version: result.version,
    managedByUs: true,
    url: result.url,
    password: result.password,
  };
}
