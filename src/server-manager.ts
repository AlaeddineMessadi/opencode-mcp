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

function registerShutdownHandlers(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  const cleanup = () => {
    if (managedServer) {
      managedServer.close();
      managedServer = null;
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
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return { healthy: false };
    const res = await response.json() as any;
    if (res && typeof res === 'object' && 'healthy' in res) {
        return {
            healthy: res.healthy === true,
            version: typeof res.version === "string" ? res.version : undefined,
        };
    }
    return { healthy: false };
  } catch {
    return { healthy: false };
  }
}

export async function startServer(
  baseUrl: string,
  timeoutMs: number = 30000,
): Promise<{ url: string; version?: string }> {
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

  // Note: managed (in-process) SDK servers do not enforce auth, so this probe
  // is unauthenticated by design. External servers, when present, are probed
  // with credentials from `ensureServer`.
  const status = await isServerRunning(created.url);
  return { url: created.url, version: status.version };
}

export function stopServer(): void {
  if (managedServer) {
    managedServer.close();
    managedServer = null;
  }
}

export async function ensureServer(
  opts: ServerManagerOptions,
): Promise<ServerStatus> {
  const baseUrl = opts.baseUrl;
  const autoServe = opts.autoServe !== false;

  const existing = await isServerRunning(baseUrl, opts.username, opts.password);
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
        `Start it manually: opencode serve`,
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
  };
}
