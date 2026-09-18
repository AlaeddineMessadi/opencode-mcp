import { createOpencodeServer, OpencodeClient } from "@opencode-ai/sdk";

export interface ServerManagerOptions {
  baseUrl: string;
  autoServe?: boolean;
  /**
   * HTTP Basic auth credentials forwarded to the `/global/health` probe.
   * Required when the OpenCode server is configured with
   * `OPENCODE_SERVER_PASSWORD` — without these, the probe would receive 401
   * and `ensureServer` would falsely treat a healthy server as down.
   */
  username?: string;
  password?: string;
  /** Bound the complete startup to the caller's remaining budget. */
  timeoutMs?: number;
}

export interface ServerStatus {
  running: boolean;
  version?: string;
  managedByUs: boolean;
  url?: string;
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

let managedServer: { url: string; close(): void } | null = null;
let shutdownRegistered = false;

export function resetShutdownRegisteredForTests(): void {
  shutdownRegistered = false;
}

/**
 * In-flight startup promises, keyed by normalized `baseUrl`. Serializes
 * concurrent `ensureServer` callers so only one of them invokes
 * `createOpencodeServer` per target URL — others awaiting the same key
 * receive the same result. Prevents EADDRINUSE / leaked server handles
 * when two requests hit the MCP simultaneously and both observe the
 * initial health probe as unhealthy.
 *
 * Keying by `baseUrl` matters because two callers targeting different
 * URLs must NOT share each other's result (the second caller would
 * receive the first server's URL and bind to the wrong endpoint).
 */
const startServerInFlight = new Map<
  string,
  Promise<{ url: string; version?: string }>
>();

export function registerShutdownHandlers(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  const cleanup = () => {
    if (managedServer) {
      managedServer.close();
      managedServer = null;
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

function parseBaseUrl(baseUrl: string): { hostname: string; port: number } {
  const url = new URL(baseUrl);
  return {
    hostname: url.hostname,
    port: url.port ? parseInt(url.port, 10) : 4096,
  };
}

export async function isServerRunning(
  baseUrl: string,
  username?: string,
  password?: string,
  timeoutMs = 3000,
): Promise<{ healthy: boolean; version?: string }> {
  try {
    const headers: Record<string, string> = {};
    const authHeader = buildBasicAuthHeader(username, password);
    if (authHeader) {
      headers["Authorization"] = authHeader;
    }
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/global/health`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) {
      throw new ServerAuthenticationError(response.status);
    }
    if (!response.ok) return { healthy: false };
    const res = await response.json() as any;
    if (res && typeof res === 'object' && 'healthy' in res) {
        return {
            healthy: res.healthy === true,
            version: typeof res.version === "string" ? res.version : undefined,
        };
    }
    return { healthy: false };
  } catch (error) {
    if (error instanceof ServerAuthenticationError) throw error;
    return { healthy: false };
  }
}

export class ServerAuthenticationError extends Error {
  constructor(readonly status: number) {
    super("OpenCode server authentication failed; no alternate server will be started.");
    this.name = "ServerAuthenticationError";
  }
}

export async function startServer(
  baseUrl: string,
  timeoutMs: number = 30000,
  username?: string,
  password?: string,
): Promise<{ url: string; version?: string }> {
  const deadline = Date.now() + timeoutMs;
  const target = new URL(baseUrl);
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.pathname !== "/") {
    throw new Error("Auto-start requires a local loopback HTTP URL without a path prefix. Start remote servers manually and set OPENCODE_BASE_URL.");
  }
  const { hostname, port } = parseBaseUrl(baseUrl);

  console.error(`Starting OpenCode SDK server on ${hostname}:${port}`);

  // Capture into a local so concurrent `startServer` calls (against
  // different baseUrls) don't clobber each other's return values via the
  // module-level `managedServer` singleton. The singleton is still
  // updated (for shutdown handler reach) but the URL we return is the
  // one this specific call produced.
  const created = await createOpencodeServer({
    hostname,
    port,
    timeout: timeoutMs,
  });
  managedServer = created;

  registerShutdownHandlers();

  // SDK children inherit environment authentication. Use the same identity
  // and never retry without credentials.
  try {
    if (Date.now() >= deadline) throw new Error("OpenCode startup exceeded its time budget.");
    const status = await isServerRunning(created.url, username, password, Math.min(3000, Math.max(1, deadline - Date.now())));
    if (!status.healthy) throw new Error("Started OpenCode server does not expose a healthy V1 contract.");
    return { url: created.url, version: status.version };
  } catch (error) {
    created.close();
    if (managedServer === created) managedServer = null;
    throw error;
  }
}

export function stopServer(ownedUrl?: string): void {
  if (managedServer && (ownedUrl === undefined || managedServer.url === ownedUrl)) {
    managedServer.close();
    managedServer = null;
  }
}

export async function ensureServer(
  opts: ServerManagerOptions,
): Promise<ServerStatus> {
  const baseUrl = opts.baseUrl;
  const autoServe = opts.autoServe === true;

  const startedAt = Date.now();
  const existing = await isServerRunning(baseUrl, opts.username, opts.password, Math.min(3000, opts.timeoutMs ?? 3000));
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

  if (!autoServe) {
    throw new Error(
      `OpenCode server is not running at ${baseUrl} and OPENCODE_AUTO_SERVE=false.\n` +
        `Start it manually: opencode serve --hostname 127.0.0.1 --port 4096\n` +
        `Or reuse a TUI started with opencode --port 4096. Set OPENCODE_BASE_URL to its URL.\n` +
        `Set OPENCODE_AUTO_SERVE=true only to explicitly allow a separate local server.`,
    );
  }

  console.error("OpenCode server not detected, attempting auto-start...");
  // Coalesce concurrent startups per-baseUrl — see the
  // `startServerInFlight` declaration for rationale.
  const startupKey = baseUrl.replace(/\/$/, "");
  let inFlight = startServerInFlight.get(startupKey);
  if (!inFlight) {
    inFlight = startServer(startupKey, Math.max(1, (opts.timeoutMs ?? 30000) - (Date.now() - startedAt)), opts.username, opts.password).finally(() => {
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
  };
}
