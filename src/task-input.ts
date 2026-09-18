import { nativeFormSchema, validateFormValues, type FormValues } from "./backends/v2-forms.js";
import type { FormField } from "@opencode/client";
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
  values?: FormValues;
  sessionId?: string;
  scope?: "project" | "session";
  reply?: "once" | "always" | "reject";
  reject?: boolean;
}
export const inputAnswerSchema = z.object({
  id: z.string().min(1), kind: z.enum(["question", "permission"]),
  answers: z.array(z.array(z.string())).optional(),
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional(),
  sessionId: z.string().optional(), scope: z.enum(["project", "session"]).optional(),
  reply: z.enum(["once", "always", "reject"]).optional(), reject: z.boolean().optional(),
}).superRefine((a, ctx) => {
  if (a.kind === "permission" && (!a.reply || a.answers || a.values || a.reject !== undefined))
    ctx.addIssue({ code: "custom", message: "Permission input requires reply only" });
  if (a.kind === "question" && ([a.answers !== undefined, a.values !== undefined, a.reject === true].filter(Boolean).length !== 1 || a.reply))
    ctx.addIssue({ code: "custom", message: "Question input requires answers, values, or reject=true, exclusively" });
});

function questions(item: PendingRequest): Array<{ question?: string; options?: Array<{ label: string }>; multiple?: boolean }> {
  return Array.isArray(item.questions) ? item.questions : [];
}
export function inputRequests(items: PendingRequest[]): InputRequests {
  return Object.fromEntries(items.map(item => {
    const key = `${item.kind}:${item.id}`;
    if (item.kind === "permission") {
      const v2 = item.backend === "v2";
      return [key, inputRequired.elicit({ message: `OpenCode requests ${String(item.permission ?? item.action ?? "permission")} for ${JSON.stringify(item.patterns ?? item.resources ?? [])}${v2 ? `. Always saves project-wide approval patterns ${JSON.stringify(item.always ?? item.save ?? [])}. Reject denies ALL pending requests in this session.` : ""}`,
        requestedSchema: { type: "object", properties: { decision: { type: "string", enum: ["once", "always", "reject"], description: "Choose explicitly; no approval is selected automatically" },
          ...(v2 ? { scope: { type: "string" as const, enum: ["request", "project", "session"], description: "Explicit acknowledgment: once=request, always=project, reject=session" } } : {}) }, required: v2 ? ["decision", "scope"] : ["decision"] } })];
    }
    if (item.backend === "v2") {
      const schema = nativeFormSchema(item.fields as FormField[]);
      if (!schema) throw new Error("This V2 form needs manual field-keyed values through opencode_job_input");
      return [key, inputRequired.elicit({ message: String(item.title ?? "OpenCode needs your input"), requestedSchema: schema as Parameters<typeof inputRequired.elicit>[0]["requestedSchema"] })];
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
    if (response.action !== "accept") {
      // Dismissing a V2 native form never authorizes a session-wide permission rejection.
      if (item.backend === "v2" && item.kind === "permission") return [];
      return [{ id: item.id, kind: item.kind, ...(item.kind === "permission" ? { reply: "reject" as const } : { reject: true }) }];
    }
    if (item.kind === "permission") {
      const reply = z.enum(["once", "always", "reject"]).parse(response.content?.decision);
      if (item.backend === "v2") {
        const scope = response.content?.scope;
        if (scope !== (reply === "always" ? "project" : reply === "reject" ? "session" : "request")) throw new Error("Explicit permission scope acknowledgment does not match the selected effect");
        return [{ id: item.id, kind: item.kind, reply, sessionId: String(item.sessionID), ...(scope === "project" || scope === "session" ? { scope } : {}) }];
      }
      return [{ id: item.id, kind: item.kind, reply }];
    }
    if (item.backend === "v2") return [{ id: item.id, kind: item.kind, sessionId: String(item.sessionID), values: validateFormValues(item.fields as FormField[], response.content) }];
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

export function canUseNativeForms(items: PendingRequest[]): boolean {
  return items.every(item => item.backend !== "v2" || item.kind === "permission" || Array.isArray(item.fields) && nativeFormSchema(item.fields as FormField[]) !== undefined);
}
