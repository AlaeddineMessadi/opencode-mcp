import { OpenCodeClient } from "./client.js";
import { createRequestContext, withAbort } from "./async.js";
import { isProviderConfigured, normalizeDirectory } from "./helpers.js";
import { operate } from "./backends/adapter.js";
import { capabilities } from "./backends/capabilities.js";
import { BackendDetectionError, detectBackend, readBackendConfig, type BackendConfig, type DetectedBackend, type DetectionDependencies } from "./backend-detection.js";
import type { BackendIdentity } from "./backends/contracts.js";

export interface DoctorCheck { id: string; status: "pass" | "warn" | "fail" | "skipped"; message: string; remedy?: string }
export interface DoctorReport {
  schemaVersion: 1;
  ready: boolean;
  checks: DoctorCheck[];
  backend?: BackendIdentity & { integrationTargetVersion: string; matchesIntegrationTarget: boolean; capabilities: { supported: number; unsupported: number; blocked: number } };
}
export interface DoctorOptions {
  directory?: string;
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  /** Injectable lower budget for deadline tests; production always uses 15 s. */
  timeoutMs?: number;
  dependencies?: DetectionDependencies;
  detect?: typeof detectBackend;
  client?: (connection: DetectedBackend) => OpenCodeClient;
}
const ids = ["node", "configuration", "backend", "authentication", "supported_version", "provider_configuration", "project_access", "lifecycle"];
function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { _tag?: string; status?: unknown; statusCode?: unknown; response?: { status?: unknown }; cause?: { status?: unknown } };
  if (candidate._tag === "UnauthorizedError") return 401;
  const status = candidate.status ?? candidate.statusCode ?? candidate.response?.status ?? candidate.cause?.status;
  return typeof status === "number" ? status : undefined;
}
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const context = createRequestContext({ timeout: Math.min(options.timeoutMs ?? 15000, 15000) });
  const report: DoctorReport = { schemaVersion: 1, ready: false, checks: [] };
  const add = (id: string, status: DoctorCheck["status"], message: string, remedy?: string) => report.checks.push({ id, status, message, ...(remedy ? { remedy } : {}) });
  const finish = () => {
    for (const id of ids) if (!report.checks.some(check => check.id === id)) add(id, "skipped", "Not checked because an earlier requirement failed.");
    report.ready = !report.checks.some(check => check.status === "fail" || check.status === "skipped");
    return report;
  };
  try {
    const major = Number((options.nodeVersion ?? process.versions.node).split(".")[0]);
    add("node", major >= 22 ? "pass" : "fail", major >= 22 ? "Node.js meets the >=22 requirement." : "Node.js 22 or newer is required.", major >= 22 ? undefined : "Install a supported Node.js version.");
    let config: BackendConfig;
    let directory: string | undefined;
    try { config = readBackendConfig(options.env); directory = normalizeDirectory(options.directory); }
    catch {
      add("configuration", "fail", "Invalid backend, URL, profile, model defaults, or directory configuration.", "Use --help; check OPENCODE_BACKEND, OPENCODE_BASE_URL, model defaults, and an absolute server directory.");
      return finish();
    }
    add("configuration", "pass", "Environment and directory configuration are valid.");
    if (major < 22) return finish();
    let connection: DetectedBackend;
    try {
      connection = await withAbort((options.detect ?? detectBackend)(config, { signal: context.signal, deadline: context.deadline, allowStartup: false }, options.dependencies), context.signal);
    } catch (error) {
      const auth = error instanceof BackendDetectionError && error.code === "authentication";
      add("backend", "fail", auth ? "The server rejected authentication." : context.signal.aborted ? "The 15-second diagnostic deadline expired." : "No backend satisfying the configured contract could be detected.", auth ? "Check server authentication configuration." : "Start OpenCode separately or configure an explicit OPENCODE_BASE_URL; doctor never starts it.");
      if (auth) add("authentication", "fail", "Server authentication failed.", "Check OPENCODE_SERVER_USERNAME and OPENCODE_SERVER_PASSWORD.");
      return finish();
    }
    const identity = connection.identity;
    const integrationTargetVersion = identity.kind === "v1" ? "1.18.31" : "2.0.6";
    const matchesIntegrationTarget = identity.version === integrationTargetVersion;
    const safeVersion = identity.version && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(identity.version) ? identity.version : undefined;
    report.backend = { ...identity, version: safeVersion, integrationTargetVersion, matchesIntegrationTarget,
      capabilities: { supported: capabilities.filter(c => c[identity.kind] === "supported").length,
        unsupported: capabilities.filter(c => c[identity.kind] === "unsupported").length,
        blocked: capabilities.filter(c => c[identity.kind] === "blocked").length } };
    add("backend", "pass", `Detected the ${identity.kind.toUpperCase()} server contract.`);
    add("authentication", "pass", "The server accepted the read-only connection probe; model credentials have not been tested.");
    const recognizedVersion = safeVersion?.startsWith(identity.kind === "v1" ? "1." : "2.") === true;
    add("supported_version", matchesIntegrationTarget ? "pass" : recognizedVersion ? "warn" : "fail",
      matchesIntegrationTarget ? `Server contract recognized and version matches the ${integrationTargetVersion} integration target.` : recognizedVersion ? `Server contract recognized; the integration target is ${integrationTargetVersion}.` : "The server version is absent, malformed, or outside the recognized backend major.",
      matchesIntegrationTarget ? undefined : `Use the ${integrationTargetVersion} target and consult documented live verification evidence.`);
    add("lifecycle", "pass", identity.survivesDisconnect ? "The external/shared server survives MCP disconnect while its owning process remains alive. A local executable is not required." : "The owned child stops with MCP; background execution does not survive disconnect.");
    const client = (options.client ?? (found => new OpenCodeClient({ baseUrl: found.baseUrl, username: found.username, password: found.password, backend: found.identity.kind, identity: found.identity })))(connection);
    const request = { directory, signal: context.signal, deadline: context.deadline };
    // Keep reads sequential: any 401/403 ends diagnostics without another request.
    try {
      const raw: unknown = await withAbort(operate(client, "providers.list", request), context.signal);
      const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
      const list = Array.isArray(raw) ? raw : Array.isArray(record?.all) ? record.all : [];
      const connected = Array.isArray(record?.connected) ? record.connected : [];
      const configured = list.some(provider => provider && typeof provider === "object" && (isProviderConfigured(provider) || connected.includes(provider.id)));
      add("provider_configuration", configured ? "pass" : "fail", configured ? "At least one provider is configured. Credentials were not exercised and no inference was run." : "No configured provider was found.", configured ? undefined : "Configure a provider in OpenCode, then rerun doctor.");
    } catch (error) {
      const auth = [401, 403].includes(statusCode(error) ?? 0);
      add("provider_configuration", "fail", auth ? "The provider read was denied by server authentication." : context.signal.aborted ? "The diagnostic deadline expired while reading providers." : "Provider configuration could not be read.", "Check the server connection and provider configuration.");
      if (auth) { report.checks.find(check => check.id === "authentication")!.status = "fail"; return finish(); }
    }
    if (!directory) {
      add("project_access", "pass", "Project access was not requested. Supply --directory to check an explicit server project.");
    } else if (!context.signal.aborted) {
      try {
        const project: unknown = await withAbort(operate(client, "projects.current", request), context.signal);
        if (!project || typeof project !== "object" || typeof (project as { worktree?: unknown }).worktree !== "string") throw new Error("Invalid project response");
        add("project_access", "pass", "The requested/default project is accessible on the OpenCode server.");
      } catch (error) {
        const auth = [401, 403].includes(statusCode(error) ?? 0);
        add("project_access", "fail", auth ? "The project read was denied by server authentication." : context.signal.aborted ? "The diagnostic deadline expired while reading the project." : "The requested/default project could not be accessed.", "Pass --directory with an existing absolute path on the OpenCode server.");
        if (auth) report.checks.find(check => check.id === "authentication")!.status = "fail";
      }
    }
    return finish();
  } finally { context.dispose(); }
}
export function formatDoctor(report: DoctorReport): string {
  return [report.ready ? "OpenCode MCP is ready." : "OpenCode MCP is not ready.", ...report.checks.map(check => `${check.status.toUpperCase()} ${check.id}: ${check.message}${check.remedy ? ` ${check.remedy}` : ""}`)].join("\n");
}
