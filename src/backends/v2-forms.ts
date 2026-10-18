import { ElicitRequestFormParamsSchema } from "@modelcontextprotocol/core";
import { isDeepStrictEqual } from "node:util";
import type { FormField } from "@opencode/client";
export type FormValues = Record<string, string | number | boolean | string[]>;
/** The manual and native input paths share this validator; no defaults imply consent. */
export function validateFormValues(fields: readonly FormField[], input: unknown): FormValues {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("V2 forms require field-keyed values");
  const values = input as Record<string, unknown>;
  for (const key of Object.keys(values)) if (!fields.some(field => field.key === key && field.type !== "external")) throw new Error(`Unknown form field: ${key}`);
  const result: FormValues = {};
  for (const field of fields) {
    if (field.type === "external") continue;
    const active = !field.when?.length || field.when.every(condition => condition.op === "eq" ? values[condition.key] === condition.value : values[condition.key] !== condition.value);
    const value = values[field.key];
    if (!active) { if (value !== undefined) throw new Error(`Field ${field.key} is not currently active`); continue; }
    if (value === undefined) { if (field.required) throw new Error(`Missing required field: ${field.key}`); continue; }
    const invalid = () => { throw new Error(`Invalid value for form field ${field.key}`); };
    switch (field.type) {
      case "string": {
        if (typeof value !== "string") { invalid(); break; }
        if (field.minLength !== undefined && value.length < field.minLength || field.maxLength !== undefined && value.length > field.maxLength) invalid();
        if (field.pattern && !new RegExp(field.pattern).test(value)) invalid();
        if (field.options?.length && !field.custom && !field.options.some(option => option.value === value)) invalid();
        if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) invalid();
        if (field.format === "uri") { try { new URL(value); } catch { invalid(); } }
        if (field.format === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value)) invalid();
        if (field.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value)))) invalid();
        result[field.key] = value; break;
      }
      case "integer": case "number": {
        if (typeof value !== "number" || !Number.isFinite(value) || field.type === "integer" && !Number.isInteger(value)) { invalid(); break; }
        if (field.minimum !== undefined && (Number.isNaN(Number(field.minimum)) || value < Number(field.minimum)) || field.maximum !== undefined && (Number.isNaN(Number(field.maximum)) || value > Number(field.maximum))) invalid();
        result[field.key] = value; break;
      }
      case "boolean": if (typeof value !== "boolean") invalid(); else result[field.key] = value; break;
      case "multiselect": {
        if (!Array.isArray(value) || value.some(item => typeof item !== "string") || new Set(value).size !== value.length) { invalid(); break; }
        if (field.minItems !== undefined && value.length < field.minItems || field.maxItems !== undefined && value.length > field.maxItems) invalid();
        if (!field.custom && value.some(item => !field.options.some(option => option.value === item))) invalid();
        result[field.key] = value; break;
      }
    }
  }
  return result;
}
/** Advanced conditional/external forms require manual responses with the original contract. */
export function nativeFormSchema(fields: readonly FormField[]): Record<string, unknown> | undefined {
  if (fields.some(field => field.type === "external" || field.when?.length || field.type === "string" && (field.pattern || field.options?.length && (field.minLength !== undefined || field.maxLength !== undefined || field.format !== undefined)) || field.type === "multiselect" && field.custom)) return undefined;
  const properties: Record<string, unknown> = {}, required: string[] = [];
  for (const field of fields) {
    if (field.type === "external") return undefined;
    const schema: Record<string, unknown> = { title: field.title ?? field.key, description: field.description };
    if (field.type === "multiselect") { schema.type = "array"; schema.items = { type: "string", ...(!field.custom ? { enum: field.options.map(option => option.value) } : {}) }; if (field.minItems !== undefined) schema.minItems = field.minItems; if (field.maxItems !== undefined) schema.maxItems = field.maxItems; }
    else { schema.type = field.type;
      if (field.type === "string") { if (field.options?.length && !field.custom) schema.enum = field.options.map(option => option.value); for (const key of ["format","minLength","maxLength","pattern"] as const) if (field[key] !== undefined) schema[key] = field[key]; }
      if (field.type === "integer" || field.type === "number") { if (typeof field.minimum === "number") schema.minimum = field.minimum; if (typeof field.maximum === "number") schema.maximum = field.maximum; }
    }
    properties[field.key] = schema; if (field.required) required.push(field.key);
  }
  const schema = JSON.parse(JSON.stringify({ type: "object", properties, required }));
  const parsed = ElicitRequestFormParamsSchema.safeParse({ mode: "form", message: "OpenCode input", requestedSchema: schema });
  if (!parsed.success || !isDeepStrictEqual(schema, parsed.data.requestedSchema)) return undefined;
  return schema;
}
