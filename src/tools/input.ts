import { inputRequired } from "@modelcontextprotocol/server";
import { z } from "zod";
import { McpServer } from "../mcp-server.js";
import { OpenCodeClient } from "../client.js";
import { JobService } from "../jobs.js";
import { directoryParam, normalizeDirectory, toolJson, toolResult } from "../helpers.js";
import { decodeInputResponses, inputAnswerSchema, inputRequests, supportsForm } from "../task-input.js";

const errorResult = (error: unknown) => toolResult(error instanceof Error ? error.message : String(error), true);

export function registerInputTools(server: McpServer, client: OpenCodeClient, jobs: JobService) {
  server.tool("opencode_question_list", "List pending OpenCode questions, optionally filtered to a session.", {
    sessionId: z.string().optional(), directory: directoryParam,
  }, async ({ sessionId, directory }) => {
    try {
      const questions = await client.get<any[]>("/question", undefined, normalizeDirectory(directory));
      return toolJson(sessionId ? questions.filter(q => q.sessionID === sessionId) : questions);
    } catch (error) { return errorResult(error); }
  });
  server.tool("opencode_question_reply", "Answer an OpenCode question request. Supply one array of selected labels or free text per question.", {
    requestId: z.string().min(1), answers: z.array(z.array(z.string())), directory: directoryParam,
  }, async ({ requestId, answers, directory }) => {
    try { return toolJson(await client.post(`/question/${encodeURIComponent(requestId)}/reply`, { answers }, { directory: normalizeDirectory(directory) })); }
    catch (error) { return errorResult(error); }
  });
  server.tool("opencode_question_reject", "Reject a pending OpenCode question explicitly.", {
    requestId: z.string().min(1), directory: directoryParam,
  }, async ({ requestId, directory }) => {
    try { return toolJson(await client.post(`/question/${encodeURIComponent(requestId)}/reject`, undefined, { directory: normalizeDirectory(directory) })); }
    catch (error) { return errorResult(error); }
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
