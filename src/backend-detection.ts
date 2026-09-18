import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Service, type Endpoint } from "@opencode/client/service";
import { createRequestContext, throwIfAborted, withAbort, type RequestOptions } from "./async.js";
import { ensureServer, ServerAuthenticationError, stopServer } from "./server-manager.js";
import type { BackendIdentity, BackendKind } from "./backends/contracts.js";

export const DEFAULT_BASE_URL = "http://127.0.0.1:4096";
export interface BackendConfig {
  backend: "auto" | BackendKind;
  baseUrl?: string;
  username?: string;
  password?: string;
  autoServe: boolean;
  profile: "full" | "essential";
  defaultProvider?: string;
  defaultModel?: string;
  taskStore?: string;
}
export type DetectionCode = "config" | "authentication" | "unavailable" | "incompatible" | "timeout";
export class BackendDetectionError extends Error {
  constructor(readonly code: DetectionCode, message: string, readonly status?: number) {
    super(message); this.name = "BackendDetectionError";
  }
}
export function validateBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new BackendDetectionError("config", "OPENCODE_BASE_URL must be an absolute HTTP(S) URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new BackendDetectionError("config", "The server URL must use HTTP(S), without embedded credentials, query, or fragment. Use the server authentication environment variables.");
  }
  return url.toString().replace(/\/$/, "");
}
export function readBackendConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const backend = env.OPENCODE_BACKEND ?? "auto";
  if (backend !== "auto" && backend !== "v1" && backend !== "v2") throw new BackendDetectionError("config", "OPENCODE_BACKEND must be auto, v1, or v2.");
  const profile = env.OPENCODE_TOOL_PROFILE ?? "full";
  if (profile !== "full" && profile !== "essential") throw new BackendDetectionError("config", "OPENCODE_TOOL_PROFILE must be full or essential.");
  if (env.OPENCODE_AUTO_SERVE !== undefined && !["true", "false"].includes(env.OPENCODE_AUTO_SERVE)) throw new BackendDetectionError("config", "OPENCODE_AUTO_SERVE must be true or false.");
  if (Boolean(env.OPENCODE_DEFAULT_PROVIDER) !== Boolean(env.OPENCODE_DEFAULT_MODEL)) throw new BackendDetectionError("config", "Set OPENCODE_DEFAULT_PROVIDER and OPENCODE_DEFAULT_MODEL together.");
  return { backend, profile, autoServe: env.OPENCODE_AUTO_SERVE === "true",
    baseUrl: env.OPENCODE_BASE_URL === undefined ? undefined : validateBaseUrl(env.OPENCODE_BASE_URL),
    username: env.OPENCODE_SERVER_USERNAME, password: env.OPENCODE_SERVER_PASSWORD,
    defaultProvider: env.OPENCODE_DEFAULT_PROVIDER, defaultModel: env.OPENCODE_DEFAULT_MODEL, taskStore: env.OPENCODE_TASK_STORE };
}
export interface DetectedBackend {
  baseUrl: string;
  username?: string;
  password?: string;
  identity: BackendIdentity;
}
interface Registration { url: string; pid: number; password?: string; version?: string }
export interface DetectionDependencies {
  fetch?: typeof fetch;
  discover?: () => Promise<Endpoint | undefined>;
  registration?: () => Promise<Registration | undefined>;
  start?: typeof ensureServer;
}
/** The pinned 2.0.6 SDK documents service.json as the complete discovery contract.
 * Its discover() hides authentication failures, so preflight the registration
 * before discovery and never fall through a present/inconclusive registration. */
async function readRegistration(): Promise<Registration | undefined> {
  const path = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode", "service.json");
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new BackendDetectionError("unavailable", "Cannot read the local OpenCode service registration; configure an explicit server URL.");
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value.url !== "string" || !Number.isInteger(value.pid) || value.pid < 0 ||
        (value.password !== undefined && typeof value.password !== "string") || (value.version !== undefined && typeof value.version !== "string")) throw new Error();
    return { ...value, url: validateBaseUrl(value.url) };
  } catch { throw new BackendDetectionError("incompatible", "The local OpenCode service registration is invalid; inspect it or configure an explicit server URL."); }
}
function authHeaders(username?: string, password?: string): Record<string, string> {
  return password === undefined ? {} : { Authorization: `Basic ${Buffer.from(`${username ?? "opencode"}:${password}`).toString("base64")}` };
}
function v1Info(value: unknown): value is { healthy: true; version?: string } {
  return !!value && typeof value === "object" && (value as any).healthy === true &&
    ((value as any).version === undefined || typeof (value as any).version === "string");
}
function v2Info(value: unknown): value is { version: string; pid: number; urls: string[]; paths: { tmp: string } } {
  const info = value as any;
  return !!info && typeof info === "object" && typeof info.version === "string" && /^2\./.test(info.version) &&
    Number.isInteger(info.pid) && info.pid >= 0 && Array.isArray(info.urls) && info.urls.every((url: unknown) => typeof url === "string") && typeof info.paths?.tmp === "string";
}
export async function detectBackend(config: BackendConfig, options: RequestOptions & { allowStartup?: boolean } = {}, dependencies: DetectionDependencies = {}): Promise<DetectedBackend> {
  const context = createRequestContext(options, 15000);
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  let sawResponse = false;
  const probe = async (baseUrl: string, kind: BackendKind, username?: string, password?: string) => {
    throwIfAborted(context.signal);
    const probeContext = createRequestContext({ signal: context.signal, deadline: context.deadline, timeout: 2000 });
    try {
      const response = await withAbort(fetcher(`${baseUrl}${kind === "v1" ? "/global/health" : "/api/info"}`, {
        method: "GET", headers: authHeaders(username, password), redirect: "error", signal: probeContext.signal,
      }), probeContext.signal);
      sawResponse = true;
      if (response.status === 401 || response.status === 403) throw new BackendDetectionError("authentication", "Server authentication failed. Check OPENCODE_SERVER_USERNAME and OPENCODE_SERVER_PASSWORD.", response.status);
      if (!response.ok) return undefined;
      const value = await withAbort(response.json(), probeContext.signal);
      if (kind === "v1" ? v1Info(value) : v2Info(value)) return value as { version?: string; pid?: number };
      return undefined;
    } catch (error) {
      if (error instanceof BackendDetectionError) throw error;
      throwIfAborted(context.signal);
      return undefined;
    } finally { probeContext.dispose(); }
  };
  const find = async (url: string, source: BackendIdentity["connectionSource"], username?: string, password?: string): Promise<DetectedBackend | undefined> => {
    const kinds: BackendKind[] = config.backend === "auto" ? ["v1", "v2"] : [config.backend];
    for (const kind of kinds) {
      const info = await probe(url, kind, username, password);
      if (info) return { baseUrl: url, username, password, identity: { kind, version: info.version,
        connectionSource: source, processOwnership: source === "discovered" ? "shared" : "external", survivesDisconnect: true } };
    }
    return undefined;
  };
  try {
    const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    const selected = await find(baseUrl, config.baseUrl ? "explicit" : "loopback", config.username, config.password);
    if (selected) return selected;
    // A responding authoritative URL cannot be replaced by a different process.
    if (config.baseUrl && sawResponse) throw new BackendDetectionError("incompatible", "The configured endpoint does not satisfy the selected OpenCode backend contract.");
    if (!config.baseUrl) {
      const read = dependencies.registration ?? readRegistration;
      const registration = await withAbort(read(), context.signal);
      if (registration) {
        const info = await probe(registration.url, "v2", "opencode", registration.password);
        if (!info || info.pid !== registration.pid || (registration.version !== undefined && info.version !== registration.version)) {
          throw new BackendDetectionError("incompatible", "A local service registration exists but its server contract could not be verified. No alternate server was started.");
        }
        if (config.backend === "v1") throw new BackendDetectionError("incompatible", "The registered local service is V2 but OPENCODE_BACKEND=v1. Configure an explicit V1 URL.");
        const endpoint = await withAbort((dependencies.discover ?? (() => Service.discover()))(), context.signal);
        if (!endpoint || validateBaseUrl(endpoint.url) !== registration.url) throw new BackendDetectionError("unavailable", "Local service discovery changed or could not confirm the registered server; retry after checking the service.");
        const confirmed = await probe(registration.url, "v2", endpoint.auth?.username, endpoint.auth?.password);
        if (!confirmed || confirmed.pid !== info.pid || confirmed.version !== info.version) throw new BackendDetectionError("unavailable", "The local service changed during discovery; retry after checking the service.");
        return { baseUrl: registration.url, username: endpoint.auth?.username, password: endpoint.auth?.password,
          identity: { kind: "v2", version: confirmed.version, connectionSource: "discovered", processOwnership: "shared", survivesDisconnect: true } };
      }
      // With no registration the SDK has nothing to discover. Avoid its opaque
      // probe so an authentication failure can never be mistaken for absence.
    }
    if (options.allowStartup && config.autoServe && config.backend !== "v2" && !sawResponse) {
      const started = await withAbort((dependencies.start ?? ensureServer)({ baseUrl, autoServe: true, username: config.username, password: config.password, timeoutMs: Math.max(1, context.deadline - Date.now()) }), context.signal);
      const actual = validateBaseUrl(started.url ?? baseUrl);
      let info: Awaited<ReturnType<typeof probe>>;
      try {
        info = await probe(actual, "v1", config.username, config.password);
        if (!info) throw new BackendDetectionError("incompatible", "The started server does not expose the V1 health contract.");
      } catch (error) {
        if (started.managedByUs) stopServer(started.url ?? baseUrl);
        throw error;
      }
      return { baseUrl: actual, username: config.username, password: config.password,
        identity: { kind: "v1", version: info.version, connectionSource: started.managedByUs ? "owned-child" : "loopback", processOwnership: started.managedByUs ? "owned" : "external", survivesDisconnect: !started.managedByUs } };
    }
    throw new BackendDetectionError(sawResponse ? "incompatible" : "unavailable", "No compatible OpenCode server is available. Start it separately or set OPENCODE_BASE_URL. Doctor never starts a server.");
  } catch (error) {
    if (context.signal.aborted) throw new BackendDetectionError("timeout", "Backend detection exceeded its time budget.");
    if (error instanceof ServerAuthenticationError) throw new BackendDetectionError("authentication", "Server authentication failed; no alternate server was started.", error.status);
    if (error instanceof BackendDetectionError) throw error;
    throw new BackendDetectionError("unavailable", "OpenCode discovery failed. Check the server and service registration.");
  } finally { context.dispose(); }
}
