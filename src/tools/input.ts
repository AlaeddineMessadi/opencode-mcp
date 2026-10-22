import { inputRequired } from "@modelcontextprotocol/server";
import { z } from "zod";
import { McpServer } from "../mcp-server.js";
import { OpenCodeClient } from "../client.js";
import { JobService } from "../jobs.js";
import { directoryParam, normalizeDirectory, toolJson, toolResult } from "../helpers.js";
import { decodeInputResponses, inputAnswerSchema, inputRequests, supportsForm } from "../task-input.js";

const errorResult = (error: unknown) => toolResult(error instanceof Error ? error.message : String(error), true);

/**
 * Resolve the session that owns a form. OpenCode 2.x forms are
 * session-scoped: replies and dismissals address
 * /api/session/{sessionID}/form/{formID}.
 */
async function formSession(client: OpenCodeClient, formId: string, directory: string | undefined, sessionId?: string): Promise<string> {
  if (sessionId) return sessionId;
  const forms = await client.get<any[]>("/api/form", undefined, directory);
  const form = (Array.isArray(forms) ? forms : []).find((f) => f?.id === formId);
  if (typeof form?.sessionID !== "string" || !form.sessionID) throw new Error("Form not found; supply the sessionId that owns it");
  return form.sessionID;
}

export function registerInputTools(server: McpServer, client: OpenCodeClient, jobs: JobService) {
  server.tool("opencode_question_list", "List pending OpenCode forms, optionally filtered to a session.", {
    sessionId: z.string().optional(), directory: directoryParam,
  }, async ({ sessionId, directory }) => {
    try {
      const forms = await client.get<any[]>("/api/form", undefined, normalizeDirectory(directory));
      return toolJson(sessionId ? forms.filter((f) => f.sessionID === sessionId) : forms);
    } catch (error) { return errorResult(error); }
  });
  server.tool("opencode_question_reply", "Answer a pending OpenCode form. Supply one value per field, keyed by field key.", {
    requestId: z.string().min(1),
    sessionId: z.string().optional().describe("Session that owns the form; auto-detected from the pending form list when omitted"),
    answer: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])),
    directory: directoryParam,
  }, async ({ requestId, sessionId, answer, directory }) => {
    try {
      directory = normalizeDirectory(directory);
      const sid = await formSession(client, requestId, directory, sessionId);
      return toolJson(await client.post(`/api/session/${encodeURIComponent(sid)}/form/${encodeURIComponent(requestId)}/reply`, { answer }, { directory }));
    } catch (error) { return errorResult(error); }
  });
  server.tool("opencode_question_reject", "Dismiss a pending OpenCode form explicitly.", {
    requestId: z.string().min(1),
    sessionId: z.string().optional().describe("Session that owns the form; auto-detected from the pending form list when omitted"),
    directory: directoryParam,
  }, async ({ requestId, sessionId, directory }) => {
    try {
      directory = normalizeDirectory(directory);
      const sid = await formSession(client, requestId, directory, sessionId);
      return toolJson(await client.delete(`/api/session/${encodeURIComponent(sid)}/form/${encodeURIComponent(requestId)}`, undefined, directory));
    } catch (error) { return errorResult(error); }
  });
  for (const action of ["get", "cancel"] as const) {
    server.tool(`opencode_job_${action}`, action === "get" ? "Observe a durable job by ID, including pending inputs and final results." : "Explicitly abort the OpenCode session owned by a job. This also stops other work in that session.", {
      jobId: z.string().min(1),
    }, async ({ jobId }, extra) => {
      try {
        const job = await jobs[action](jobId, { signal: extra?.signal });
        return toolResult(job.text ?? `Job ${jobId}: ${job.status}`, job.status === "failed", { ...job });
      } catch (error) { return toolResult(error instanceof Error ? error.message : String(error), true, { jobId, status: "unknown" }); }
    });
  }
  server.tool("opencode_job_list", "List locally retained jobs in this OpenCode server and credential scope.", {
    limit: z.number().int().positive().max(200).optional(),
  }, async ({ limit }) => {
    try { return toolJson(await jobs.list(limit)); } catch (error) { return errorResult(error); }
  });
  server.tool("opencode_job_input", "Respond to a job's pending questions or permissions. Omit responses to request MCP forms when supported, or receive manual response instructions. Never approves automatically.", {
    jobId: z.string().min(1), responses: z.array(inputAnswerSchema).optional(),
  }, async ({ jobId, responses }, extra) => {
    try {
      const options = { signal: extra?.signal };
      let job = await jobs.get(jobId, options);
      const input = responses ?? (extra?.mcpReq?.inputResponses ? decodeInputResponses(job.inputs ?? [], extra.mcpReq.inputResponses) : undefined);
      if (input?.length) job = await jobs.update(jobId, input, options);
      if (job.status === "input_required" && job.inputs?.length) {
        const envelope = extra?.mcpReq?.envelope as Record<string, unknown> | undefined;
        if (supportsForm(envelope?.["io.modelcontextprotocol/clientCapabilities"])) return inputRequired({ inputRequests: inputRequests(job.inputs) });
        return toolResult("OpenCode needs input. Call opencode_job_input with explicit responses for the pending IDs.", false, { ...job });
      }
      return toolResult(job.text ?? `Job ${jobId}: ${job.status}`, job.status === "failed", { ...job });
    } catch (error) { return errorResult(error); }
  });
}
