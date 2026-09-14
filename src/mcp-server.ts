/** Shared registration contract. SDK v2 owns protocol validation and transport serving. */
import { McpServer as SdkServer, ResourceTemplate, type ServerContext, type ToolAnnotations,
  type ResourceMetadata, type ReadResourceCallback, type ReadResourceTemplateCallback,
  type InputRequiredResult, type GetPromptResult, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { withRequestOptions } from "./async.js";

export { ResourceTemplate };
export type ToolContext = { signal?: AbortSignal; _meta?: Record<string, unknown>; mcpReq?: ServerContext["mcpReq"] };
export type ToolProfile = "full" | "essential";

const readers = new Set(`health setup status context conversation sessions_overview check wait review_changes
  config_get config_providers provider_list provider_models provider_auth_methods
  session_list session_get session_children session_status session_todo session_diff session_search permission_list
  message_list message_get find_text find_file find_symbol file_list file_read file_status
  project_list project_current path_get vcs_info agent_list command_list lsp_status formatter_status
  mcp_status tool_ids tool_list events_poll question_list job_get job_list`.split(/\s+/).map(n => `opencode_${n}`));
const essential = new Set(`setup provider_list provider_models ask reply run fire check wait conversation review_changes context status
  session_abort session_create session_list permission_list session_permission question_list question_reply question_reject
  job_get job_list job_cancel job_input`.split(/\s+/).map(n => `opencode_${n}`));

export function annotationsFor(name: string): ToolAnnotations {
  const readOnly = readers.has(name);
  return { readOnlyHint: readOnly, destructiveHint: !readOnly,
    idempotentHint: readOnly, openWorldHint: true };
}

export const jobStatusSchema = z.enum(["accepted", "running", "input_required", "completed", "failed", "cancelled", "unknown"]);
function outputSchema(name: string) {
  const common = { text: z.string(), isError: z.boolean() };
  if (["opencode_run", "opencode_fire", "opencode_wait", "opencode_check", "opencode_job_get", "opencode_job_cancel"].includes(name)) {
    return z.object({ ...common, sessionId: z.string().optional(), jobId: z.string().optional(),
      messageId: z.string().optional(), directory: z.string().optional(), status: jobStatusSchema,
      result: z.unknown().optional(), error: z.unknown().optional() }).loose();
  }
  if (name === "opencode_session_create") return z.object({ ...common, sessionId: z.string(), session: z.unknown() }).loose();
  return z.object({ ...common, data: z.unknown().optional() }).loose();
}

export function withStructuredText(result: CallToolResult): CallToolResult {
  return { ...result, structuredContent: {
    ...(result.structuredContent && typeof result.structuredContent === "object" ? result.structuredContent : {}),
    text: result.content.filter(c => c.type === "text").map(c => c.text).join("\n"),
    isError: result.isError === true,
  } };
}

export class McpServer extends SdkServer {
  profile: ToolProfile = "full";
  readonly catalog: Array<{ name: string; description: string; inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>; annotations: ToolAnnotations }> = [];

  tool<S extends z.ZodRawShape>(name: string, description: string, shape: S,
    ...rest: [handler: (args: z.infer<z.ZodObject<S>>, extra?: ToolContext) => Promise<CallToolResult | InputRequiredResult>]
      | [annotations: ToolAnnotations, handler: (args: z.infer<z.ZodObject<S>>, extra?: ToolContext) => Promise<CallToolResult | InputRequiredResult>]) {
    if (this.profile === "essential" && !essential.has(name)) return;
    const handler = rest[rest.length - 1] as (args: z.infer<z.ZodObject<S>>, extra?: ToolContext) => Promise<CallToolResult | InputRequiredResult>;
    // Central explicit inventory is authoritative; scattered legacy hints may be incomplete.
    const annotations = annotationsFor(name);
    const input = z.object(shape);
    const output = outputSchema(name);
    this.catalog.push({ name, description, inputSchema: z.toJSONSchema(input), outputSchema: z.toJSONSchema(output), annotations });
    return this.registerTool(name, { description, inputSchema: input, outputSchema: output, annotations },
      async (args, ctx) => withRequestOptions({ signal: ctx.mcpReq.signal }, async () => {
        const result = await handler(args, { signal: ctx.mcpReq.signal, _meta: ctx.mcpReq._meta, mcpReq: ctx.mcpReq });
        return result.resultType === "input_required" ? result as InputRequiredResult : withStructuredText(result as CallToolResult);
      }));
  }

  resource(name: string, uri: string, metadata: ResourceMetadata, handler: ReadResourceCallback): void;
  resource(name: string, uri: ResourceTemplate, metadata: ResourceMetadata, handler: ReadResourceTemplateCallback): void;
  resource(name: string, uri: string | ResourceTemplate, metadata: ResourceMetadata,
    handler: ReadResourceCallback | ReadResourceTemplateCallback): void {
    if (typeof uri === "string") this.registerResource(name, uri, metadata,
      (url, ctx) => withRequestOptions({ signal: ctx.mcpReq.signal }, () => (handler as ReadResourceCallback)(url, ctx)));
    else this.registerResource(name, uri, metadata,
      (url, variables, ctx) => withRequestOptions({ signal: ctx.mcpReq.signal }, () => (handler as ReadResourceTemplateCallback)(url, variables, ctx)));
  }

  prompt<S extends z.ZodRawShape>(name: string, description: string, shape: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<GetPromptResult>) {
    return this.registerPrompt(name, { description, argsSchema: z.object(shape) }, handler);
  }
}
