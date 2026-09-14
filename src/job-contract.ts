import { z } from "zod";
import { directoryParam, outputFormatParam } from "./helpers.js";

export const dispatchShape = {
  prompt: z.string().min(1).describe("Task or instruction to send to OpenCode"),
  sessionId: z.string().optional().describe("Existing session to continue; omit to create one"),
  title: z.string().optional().describe("Title for a new session"),
  providerID: z.string().optional().describe("Provider ID from provider discovery"),
  modelID: z.string().optional().describe("Model ID from provider discovery"),
  variant: z.string().optional().describe("Model variant"),
  agent: z.string().optional().describe("OpenCode agent name"),
  directory: directoryParam,
  format: outputFormatParam,
};
export const runShape = {
  ...dispatchShape,
  maxDurationSeconds: z.number().positive().max(3600).optional()
    .describe("Maximum observation duration in seconds (default 600); timeout does not abort the job"),
};
export const runInputSchema = z.object(runShape);
