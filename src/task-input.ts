/** Translate OpenCode requests into MCP form requests; every response is validated again. */
import { inputRequired, type InputRequests } from "@modelcontextprotocol/server";
import { z } from "zod";

export interface PendingRequest {
  id: string;
  kind: "question" | "permission";
  [key: string]: unknown;
}
export interface InputAnswer {
  id: string;
  kind: "question" | "permission";
  answers?: string[][];
  reply?: "once" | "always" | "reject";
  reject?: boolean;
}
export const inputAnswerSchema = z.object({
  id: z.string().min(1), kind: z.enum(["question", "permission"]),
  answers: z.array(z.array(z.string())).optional(),
  reply: z.enum(["once", "always", "reject"]).optional(), reject: z.boolean().optional(),
}).superRefine((a, ctx) => {
  if (a.kind === "permission" && (!a.reply || a.answers || a.reject !== undefined))
    ctx.addIssue({ code: "custom", message: "Permission input requires reply only" });
  if (a.kind === "question" && ((a.answers === undefined) === (a.reject !== true) || a.reply))
    ctx.addIssue({ code: "custom", message: "Question input requires answers or reject=true, exclusively" });
});

/** A single OpenCode 2.x form field (Form.Field union). */
interface FormField {
  key?: string;
  title?: string;
  description?: string;
  type?: string;
  options?: Array<{ value?: string; label?: string }>;
}

function formFields(item: PendingRequest): FormField[] {
  return Array.isArray(item.fields) ? (item.fields as FormField[]) : [];
}
function isMultiselect(field: FormField): boolean {
  return field?.type === "multiselect";
}
export function inputRequests(items: PendingRequest[]): InputRequests {
  return Object.fromEntries(items.map(item => {
    const key = `${item.kind}:${item.id}`;
    if (item.kind === "permission") {
      // OpenCode 2.x Permission.Request: { action, resources, message? }.
      const action = typeof item.action === "string" ? item.action : "permission";
      const resources = Array.isArray(item.resources) ? item.resources.map(String) : [];
      const note = typeof item.message === "string" && item.message ? `\n${item.message}` : "";
      return [key, inputRequired.elicit({ message: `OpenCode requests ${action} for ${JSON.stringify(resources)}${note}`,
        requestedSchema: { type: "object", properties: { decision: { type: "string", enum: ["once", "always", "reject"], description: "Choose explicitly; no approval is selected automatically" } }, required: ["decision"] } })];
    }
    const fields = formFields(item);
    const properties = Object.fromEntries(fields.map((field, index) => {
      const labels = (field.options ?? []).map(option => option.label ?? option.value ?? "").filter(Boolean);
      return [`answer_${index}`, {
        type: "string" as const,
        description: `${field.description ?? field.title ?? "Answer"}${labels.length ? ` Options: ${labels.join(", ")}.` : ""}${isMultiselect(field) ? " For multiple choices, enter a JSON array of labels." : ""}`,
      }];
    }));
    return [key, inputRequired.elicit({ message: fields.map(field => field.title ?? field.description).filter(Boolean).join("\n") || (typeof item.title === "string" && item.title ? item.title : "OpenCode needs your input"),
      requestedSchema: { type: "object", properties, required: Object.keys(properties) } })];
  }));
}

/** Unknown/already-consumed keys are ignored by the Tasks extension contract. */
export function decodeInputResponses(items: PendingRequest[], responses: Record<string, unknown>): InputAnswer[] {
  const answer = z.object({ action: z.enum(["accept", "decline", "cancel"]), content: z.record(z.string(), z.unknown()).optional() });
  return items.flatMap<InputAnswer>(item => {
    const raw = responses[`${item.kind}:${item.id}`];
    if (raw === undefined) return [];
    const response = answer.parse(raw);
    if (response.action !== "accept") return [{ id: item.id, kind: item.kind,
      ...(item.kind === "permission" ? { reply: "reject" as const } : { reject: true }) }];
    if (item.kind === "permission") return [{ id: item.id, kind: item.kind,
      reply: z.enum(["once", "always", "reject"]).parse(response.content?.decision) }];
    const answers = formFields(item).map((field, index) => {
      const value = z.string().parse(response.content?.[`answer_${index}`]);
      return isMultiselect(field) ? z.array(z.string()).parse(JSON.parse(value)) : [value];
    });
    return [{ id: item.id, kind: item.kind, answers }];
  });
}

export function supportsForm(capabilities: unknown): boolean {
  const caps = capabilities as { elicitation?: { form?: unknown } } | undefined;
  return !!caps?.elicitation && typeof caps.elicitation.form === "object" && caps.elicitation.form !== null;
}
