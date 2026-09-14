/** July 2026 Tasks extension bridge. SDK v2 currently handles core MCP only.
 * Keep extension dispatch at the stdio boundary; all core traffic uses serveStdio.
 */
import type { Transport, JSONRPCMessage } from "@modelcontextprotocol/server";
import { z } from "zod";
import { JobService, type JobSnapshot } from "./jobs.js";
import { runInputSchema } from "./job-contract.js";
import { applyModelDefaults, toolResult } from "./helpers.js";
import { withStructuredText } from "./mcp-server.js";
import { decodeInputResponses, inputRequests, supportsForm } from "./task-input.js";

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
const VERSION = "2026-07-28";
const versionKey = "io.modelcontextprotocol/protocolVersion";
const capsKey = "io.modelcontextprotocol/clientCapabilities";
const envelopeSchema = z.looseObject({
  [versionKey]: z.literal(VERSION),
  [capsKey]: z.looseObject({
    extensions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    elicitation: z.looseObject({ form: z.record(z.string(), z.unknown()).optional(), url: z.record(z.string(), z.unknown()).optional() }).optional(),
  }),
  "io.modelcontextprotocol/clientInfo": z.looseObject({ name: z.string(), version: z.string() }).optional(),
  "io.modelcontextprotocol/logLevel": z.enum(["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"]).optional(),
  progressToken: z.union([z.string(), z.number()]).optional(),
});
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);

export function taskFromJob(job: JobSnapshot, detailed = false): Record<string, unknown> {
  const status = job.status === "cancelled" ? "cancelled" : job.status === "input_required" ? "input_required"
    : ["completed", "failed"].includes(job.status) ? "completed" : "working";
  const task: Record<string, unknown> = {
    taskId: job.jobId, status, createdAt: new Date(job.createdAt!).toISOString(),
    lastUpdatedAt: new Date(job.updatedAt!).toISOString(), ttlMs: job.expiresAt! - job.createdAt!, pollIntervalMs: 2000,
    statusMessage: job.status === "unknown" ? "Submission outcome unknown; observation will not resend it." : job.status,
  };
  if (detailed && status === "completed") task.result = { resultType: "complete", ...withStructuredText(
    toolResult(job.text ?? (job.status === "failed" ? "OpenCode task failed" : "Completed"), job.status === "failed", { ...job })) };
  if (detailed && status === "input_required") task.inputRequests = inputRequests(job.inputs ?? []);
  return { resultType: detailed ? "complete" : "task", ...task };
}

export class TaskTransport implements Transport {
  onmessage?: Transport["onmessage"];
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  private era?: "legacy" | "modern";
  private probing = false;
  private readonly active = new Map<string | number, AbortController>();
  constructor(private readonly inner: Transport, private readonly jobs: JobService) {}
  async start() {
    this.inner.onclose = () => { this.abort(); this.onclose?.(); };
    this.inner.onerror = error => this.onerror?.(error);
    this.inner.onmessage = (message, extra) => {
      void this.receive(message, () => this.onmessage?.(message, extra)).catch(error => this.onerror?.(error));
    };
    await this.inner.start();
  }
  send: Transport["send"] = (message, options) => this.inner.send(message, options);
  setProtocolVersion = (version: string) => this.inner.setProtocolVersion?.(version);
  setSupportedProtocolVersions = (versions: string[]) => this.inner.setSupportedProtocolVersions?.(versions);
  private abort() { for (const controller of this.active.values()) controller.abort(); this.active.clear(); }
  async close() { this.abort(); await this.inner.close(); }
  private async receive(message: JSONRPCMessage, forward: () => void) {
    if (!("method" in message)) { forward(); return; }
    const request = message as { id?: string | number; method: string; params?: Record<string, any> };
    if (request.method === "notifications/cancelled") {
      this.active.get(request.params?.requestId)?.abort(); forward(); return;
    }
    const meta = request.params?._meta;
    const modern = object(meta) && meta[versionKey] === VERSION;
    // Do not pin a malformed opening; the SDK must still validate core metadata.
    const validEnvelope = envelopeSchema.safeParse(meta).success;
    const hasEnvelope = object(meta) && Object.keys(meta).some(key => [versionKey, capsKey, "io.modelcontextprotocol/clientInfo", "io.modelcontextprotocol/logLevel"].includes(key));
    const claimedVersion = object(meta) ? meta[versionKey] : undefined;
    const requestError = async (code: number, message: string, data?: unknown) => {
      if (request.id !== undefined) await this.send({ jsonrpc: "2.0", id: request.id, error: { code, message, ...(data ? { data } : {}) } });
    };
    if ((this.era === "modern" && !modern) || (this.era === "legacy" && modern)) {
      await requestError(-32022, "Cannot change protocol era on an open connection", { supported: this.era === "modern" ? [VERSION] : ["2025-11-25"], requested: claimedVersion ?? request.params?.protocolVersion ?? "2025-11-25" });
      return;
    }
    if (!this.era) {
      if (modern && validEnvelope) {
        if (request.method === "server/discover") this.probing = true;
        else if (!this.probing || request.id !== undefined) this.era = "modern";
      } else if (!hasEnvelope) this.era = "legacy";
    }
    const caps = object(meta) ? meta[capsKey] : undefined;
    const taskCapable = object(caps) && object(caps.extensions) && object(caps.extensions[TASKS_EXTENSION]);
    const extensionMethod = request.method.startsWith("tasks/");
    const run = request.method === "tools/call" && request.params?.name === "opencode_run" && modern && taskCapable;
    if (!extensionMethod && !run) { forward(); return; }
    if (request.id === undefined) return; // Extension methods are requests, never notifications.
    const id = request.id;
    const fail = (code: number, message: string, data?: unknown) => this.send({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
    if (modern && !validEnvelope) { await fail(-32602, "Invalid MCP request metadata"); return; }
    if (!modern || this.era !== "modern") { await fail(-32022, "Tasks require a 2026-07-28 connection", { supported: [VERSION], requested: claimedVersion ?? "2025-11-25" }); return; }
    if (!taskCapable) { await fail(-32021, "Client must advertise the Tasks extension", { requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } } }); return; }
    if (!run && !["tasks/get", "tasks/update", "tasks/cancel"].includes(request.method)) { await fail(-32601, "Method not found"); return; }
    if (this.active.has(id)) { await fail(-32600, "Duplicate active request ID"); return; }
    const controller = new AbortController();
    this.active.set(id, controller);
    try {
      let result: Record<string, unknown>;
      if (run) {
        const args = runInputSchema.parse(request.params?.arguments ?? {});
        const job = await this.jobs.start({ ...args, model: applyModelDefaults(args.providerID, args.modelID) }, { signal: controller.signal });
        result = taskFromJob(job);
      } else {
        const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
        if (request.method === "tasks/get") {
          const job = await this.jobs.get(taskId, { signal: controller.signal });
          if (job.status === "input_required" && !supportsForm(caps)) {
            await fail(-32021, "Pending input requires form elicitation", { requiredCapabilities: { elicitation: { form: {} } } });
            return;
          }
          result = taskFromJob(job, true);
        }
        else if (request.method === "tasks/cancel") {
          // The extension acknowledges cancellation intent; get reports the eventual state.
          await this.jobs.cancel(taskId, { signal: controller.signal });
          result = { resultType: "complete" };
        } else {
          const responses = z.record(z.string(), z.unknown()).parse(request.params?.inputResponses);
          const job = await this.jobs.get(taskId, { signal: controller.signal });
          const answers = decodeInputResponses(job.inputs ?? [], responses);
          if (answers.length) await this.jobs.update(taskId, answers, { signal: controller.signal });
          result = { resultType: "complete" };
        }
      }
      await this.send({ jsonrpc: "2.0", id, result });
    } catch (error) {
      await fail(error instanceof z.ZodError ? -32602 : -32603,
        error instanceof z.ZodError ? "Invalid task parameters" : error instanceof Error ? error.message : "Task operation failed");
    } finally { this.active.delete(id); }
  }
}
