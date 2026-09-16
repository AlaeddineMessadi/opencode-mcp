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

function questions(item: PendingRequest): Array<{ question?: string; options?: Array<{ label: string }>; multiple?: boolean }> {
  return Array.isArray(item.questions) ? item.questions : [];
}
export function inputRequests(items: PendingRequest[]): InputRequests {
  return Object.fromEntries(items.map(item => {
    const key = `${item.kind}:${item.id}`;
    if (item.kind === "permission") {
      return [key, inputRequired.elicit({ message: `OpenCode requests ${String(item.permission ?? "permission")} for ${JSON.stringify(item.patterns ?? [])}`,
        requestedSchema: { type: "object", properties: { decision: { type: "string", enum: ["once", "always", "reject"], description: "Choose explicitly; no approval is selected automatically" } }, required: ["decision"] } })];
    }
    const qs = questions(item);
    const properties = Object.fromEntries(qs.map((q, index) => [`answer_${index}`, {
      type: "string" as const,
      description: `${q.question ?? "Answer"}${q.options?.length ? ` Options: ${q.options.map(o => o.label).join(", ")}.` : ""}${q.multiple ? " For multiple choices, enter a JSON array of labels." : ""}`,
    }]));
    return [key, inputRequired.elicit({ message: qs.map(q => q.question).join("\n") || "OpenCode needs your input",
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
    const answers = questions(item).map((q, index) => {
      const value = z.string().parse(response.content?.[`answer_${index}`]);
      return q.multiple ? z.array(z.string()).parse(JSON.parse(value)) : [value];
    });
    return [{ id: item.id, kind: item.kind, answers }];
  });
}

export function supportsForm(capabilities: unknown): boolean {
  const caps = capabilities as { elicitation?: { form?: unknown } } | undefined;
  return !!caps?.elicitation && typeof caps.elicitation.form === "object" && caps.elicitation.form !== null;
}
