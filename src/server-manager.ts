import { createOpencodeServer, OpencodeClient } from "@opencode-ai/sdk";

export interface ServerManagerOptions {
  baseUrl: string;
  autoServe?: boolean;
}

export interface ServerStatus {
  running: boolean;
  version?: string;
  managedByUs: boolean;
  url?: string;
}

let managedServer: { url: string; close(): void } | null = null;
let shutdownRegistered = false;

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
): Promise<{ healthy: boolean; version?: string }> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/global/health`, {
      method: "GET",
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
  
  managedServer = await createOpencodeServer({
    hostname,
    port,
    timeout: timeoutMs,
    // Add any OPENCODE_SERVE_ARGS to config if needed in the future
    // Currently the SDK handles this via config objects
  });

  registerShutdownHandlers();

  const status = await isServerRunning(managedServer.url);
  return { url: managedServer.url, version: status.version };
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

  const existing = await isServerRunning(baseUrl);
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
  const result = await startServer(baseUrl);
  console.error(`OpenCode server started successfully on ${result.url}`);

  return {
    running: true,
    version: result.version,
    managedByUs: true,
    url: result.url,
  };
}
