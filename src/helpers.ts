/**
 * Smart response formatting helpers.
 *
 * Instead of dumping raw JSON to the LLM, these helpers extract the
 * meaningful content from OpenCode API responses so the LLM can reason
 * about them efficiently.
 */

import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Tool Annotations ─────────────────────────────────────────────────
// MCP spec tool annotations help clients understand tool behavior.

/** Read-only tool: does not modify state. */
export const readOnly = { readOnlyHint: true, destructiveHint: false } as const;

/** Destructive tool: permanently deletes data or shuts down services. */
export const destructive = { readOnlyHint: false, destructiveHint: true } as const;

/**
 * Shared Zod parameter for project directory targeting.
 * When provided, sent as the x-opencode-directory header so the
 * OpenCode server scopes the request to that project.
 */
export const directoryParam = z
  .string()
  .optional()
  .describe(
    "Absolute path to the project directory. " +
      "When provided, the request targets that project. " +
      "If omitted, the OpenCode server uses its own working directory.",
  );

// ── Default Provider/Model ────────────────────────────────────────────

/**
 * Module-level defaults for provider and model.
 * Set via `setModelDefaults()` during startup from env vars.
 * If not set, tools fall back to whatever the OpenCode server decides.
 */
let _defaultProviderID: string | undefined;
let _defaultModelID: string | undefined;

/**
 * Set the global default provider and model.
 * Called once from index.ts during startup.
 */
export function setModelDefaults(providerID?: string, modelID?: string): void {
  _defaultProviderID = providerID;
  _defaultModelID = modelID;
}

/**
 * Apply model defaults: use explicit params if both are provided,
 * otherwise fall back to env-var defaults if both are set,
 * otherwise return undefined (let the server decide).
 *
 * Returns `{ providerID, modelID }` or `undefined`.
 */
export function applyModelDefaults(
  providerID?: string,
  modelID?: string,
): { providerID: string; modelID: string } | undefined {
  // Explicit params take priority
  if (providerID && modelID) {
    return { providerID, modelID };
  }
  // Fall back to env-var defaults
  if (_defaultProviderID && _defaultModelID) {
    return { providerID: _defaultProviderID, modelID: _defaultModelID };
  }
  // No defaults available — let the server decide
  return undefined;
}

// ── Directory Validation ─────────────────────────────────────────────

/**
 * Normalize and validate a directory path:
 *  - Resolves to absolute (handles "..", trailing slashes, etc.)
 *  - Rejects relative paths (must start with /)
 *  - Validates that the path exists on disk
 *
 * Returns the normalized path, or undefined if input was undefined.
 * Throws a descriptive Error on validation failure.
 */
export function normalizeDirectory(directory?: string): string | undefined {
  if (!directory) return undefined;

  // Resolve to absolute (handles "..", ".", trailing slashes)
  const normalized = resolve(directory);

  // Must be an absolute path
  if (!normalized.startsWith("/")) {
    throw new Error(
      `Invalid directory: "${directory}" is not an absolute path. ` +
        `Provide a full path like "/home/user/my-project".`,
    );
  }

  // Must exist on disk
  if (!existsSync(normalized)) {
    throw new Error(
      `Directory not found: "${normalized}" does not exist. ` +
        `Check the path and try again.`,
    );
  }

  return normalized;
}

/**
 * Extract a human-readable summary from a message response.
 * Pulls text content from parts, summarizes tool calls, etc.
 * Accepts any shape — casts internally for safety.
 */
export function formatMessageResponse(response: unknown): string {
  const r = response as any;
  const sections: string[] = [];

  // Omit verbose message header for cleaner output; the caller (opencode_ask etc.)
  // already provides session context.  Keep a minimal role tag only when it adds info.

  if (r?.parts && Array.isArray(r.parts)) {
    for (const part of r.parts) {
      switch (part.type) {
        case "text":
          sections.push(part.text ?? part.content ?? "");
          break;
        case "tool-invocation":
        case "tool-result":
          sections.push(
            `[Tool: ${part.toolName ?? "unknown"}] ${part.error ? `ERROR: ${part.error}` : typeof part.output === "string" ? part.output : JSON.stringify(part.output ?? part.input, null, 2)}`,
          );
          break;
        case "step-start":
        case "step-finish":
          // Internal lifecycle events — omit from user-facing output.
          // Optionally surface cost/token info from step-finish.
          if (part.type === "step-finish" && (part.cost != null || part.tokens)) {
            const meta: string[] = [];
            if (part.cost != null) meta.push(`cost: $${Number(part.cost).toFixed(4)}`);
            if (part.tokens) {
              const t = part.tokens;
              const tokParts: string[] = [];
              if (t.input) tokParts.push(`${t.input} in`);
              if (t.output) tokParts.push(`${t.output} out`);
              if (t.reasoning) tokParts.push(`${t.reasoning} reasoning`);
              if (tokParts.length > 0) meta.push(`tokens: ${tokParts.join(", ")}`);
            }
            if (meta.length > 0) sections.push(`_${meta.join(" | ")}_`);
          }
          break;
        default:
          // Skip unknown internal part types to keep output clean
          if (part.text || part.content) {
            sections.push(part.text ?? part.content);
          }
          // Only dump JSON for truly unknown parts that have meaningful data
          else if (part.type && !["source"].includes(part.type)) {
            sections.push(
              `[${part.type}] ${JSON.stringify(part, null, 2)}`,
            );
          }
      }
    }
  }

  return sections.join("\n\n");
}

/**
 * Format a list of messages, extracting text content from each.
 *
 * When the assistant message has no text content (common with some providers
 * that only emit tool calls), we show a concise summary of tool actions
 * instead of blank output.  Cost/token metadata from step-finish parts is
 * appended when available.
 */
export function formatMessageList(
  messages: unknown[],
): string {
  if (!messages || messages.length === 0) return "No messages found.";

  return messages
    .map((raw, i) => {
      const msg = raw as any;
      const role = msg?.info?.role ?? "unknown";
      const id = msg?.info?.id ?? "?";
      const parts = Array.isArray(msg?.parts) ? msg.parts : [];

      const textParts = parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => (p.text ?? p.content ?? "").trim())
        .filter(Boolean)
        .join("\n");

      const toolParts = parts.filter(
        (p: any) => p.type === "tool-invocation" || p.type === "tool-result",
      );

      // Extract cost/token metadata from step-finish parts
      const costMeta = extractCostMeta(parts);

      let summary = `--- Message ${i + 1} [${role}] (${id}) ---\n`;

      if (textParts) {
        summary += textParts;
        if (toolParts.length > 0) {
          summary += `\n[${toolParts.length} tool call(s)]`;
        }
      } else if (toolParts.length > 0) {
        // No text but agent performed actions — show concise tool summaries
        const toolSummaries = toolParts.slice(0, 10).map((p: any) => {
          const name = p.toolName ?? "unknown";
          // Extract the most useful arg (file path, command, etc.)
          const hint = summarizeToolInput(p.input);
          const errTag = p.error ? " ERROR" : "";
          return `  ${name}${hint ? `: ${hint}` : ""}${errTag}`;
        });
        summary += `Agent performed ${toolParts.length} action(s):\n${toolSummaries.join("\n")}`;
        if (toolParts.length > 10) {
          summary += `\n  ... and ${toolParts.length - 10} more`;
        }
      } else {
        summary += "(no content)";
      }

      if (costMeta) summary += `\n${costMeta}`;

      return summary;
    })
    .join("\n\n");
}

/**
 * Extract a short hint from a tool-call input object.
 * Prefers path, command, file, query — the most informative single arg.
 */
function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  // Ordered by likely usefulness
  for (const key of ["path", "filePath", "file", "command", "query", "url", "pattern", "text"]) {
    const val = obj[key];
    if (typeof val === "string" && val.length > 0) {
      return val.length > 80 ? val.slice(0, 77) + "..." : val;
    }
  }
  return "";
}

/**
 * Extract cost/token metadata from step-finish parts and return a
 * compact line, or empty string if none found.
 */
function extractCostMeta(parts: any[]): string {
  const stepFinish = parts.find(
    (p: any) => p.type === "step-finish" && (p.cost != null || p.tokens),
  );
  if (!stepFinish) return "";
  const meta: string[] = [];
  if (stepFinish.cost != null) meta.push(`cost: $${Number(stepFinish.cost).toFixed(4)}`);
  if (stepFinish.tokens) {
    const t = stepFinish.tokens;
    const tokParts: string[] = [];
    if (t.input) tokParts.push(`${t.input} in`);
    if (t.output) tokParts.push(`${t.output} out`);
    if (t.reasoning) tokParts.push(`${t.reasoning} reasoning`);
    if (tokParts.length > 0) meta.push(`tokens: ${tokParts.join(", ")}`);
  }
  return meta.length > 0 ? `_${meta.join(" | ")}_` : "";
}

/**
 * Format a diff response into a readable summary.
 */
export function formatDiffResponse(diffs: unknown[]): string {
  if (!diffs || diffs.length === 0) return "No changes found.";

  return diffs
    .map((d: unknown) => {
      const diff = d as Record<string, unknown>;
      const path = diff.path ?? diff.file ?? "unknown";
      const status = diff.status ?? diff.type ?? "";
      const additions =
        typeof diff.additions === "number" ? `+${diff.additions}` : "";
      const deletions =
        typeof diff.deletions === "number" ? `-${diff.deletions}` : "";
      const stats = [additions, deletions].filter(Boolean).join(" ");
      let line = `${status} ${path}`;
      if (stats) line += ` (${stats})`;
      if (typeof diff.diff === "string") {
        line += `\n${diff.diff}`;
      }
      return line;
    })
    .join("\n");
}

/**
 * Format session objects for LLM-friendly display.
 */
export function formatSessionList(
  sessions: unknown[],
): string {
  if (!sessions || sessions.length === 0) return "No sessions found.";

  return sessions
    .map((raw) => {
      const s = raw as any;
      const id = s?.id ?? "?";
      const title = s?.title ?? "(untitled)";
      const createdAt = s?.createdAt ?? "";
      const parentID = s?.parentID ? ` (child of ${s.parentID})` : "";
      return `- ${title} [${id}]${parentID}${createdAt ? ` created ${createdAt}` : ""}`;
    })
    .join("\n");
}

/**
 * Generic safe JSON stringify with truncation for very large responses.
 */
export function safeStringify(
  value: unknown,
  maxLength: number = 50000,
): string {
  const json = JSON.stringify(value, null, 2);
  if (json.length <= maxLength) return json;
  return (
    json.slice(0, maxLength) +
    `\n\n... [truncated, ${json.length - maxLength} more characters]`
  );
}

/**
 * Analyze an AI message response for signs of failure:
 *  - Completely empty (null/undefined)
 *  - Has parts but no text content (provider returned nothing)
 *  - Contains error indicators in parts
 *
 * Returns a diagnostic object with `isEmpty`, `hasError`, and `warning` text.
 */
export function analyzeMessageResponse(response: unknown): {
  isEmpty: boolean;
  hasError: boolean;
  warning: string | null;
} {
  if (response === null || response === undefined) {
    return {
      isEmpty: true,
      hasError: false,
      warning:
        "The AI returned an empty response. This usually means the provider " +
        "is not configured or the API key is missing/invalid. " +
        "Use `opencode_setup` to check provider status, or " +
        "`opencode_auth_set` to configure an API key.",
    };
  }

  const r = response as any;
  const parts = Array.isArray(r?.parts) ? r.parts : [];

  // Check for error parts
  const errorParts = parts.filter(
    (p: any) =>
      p.error ||
      (p.type === "tool-result" && p.error) ||
      (typeof p.text === "string" && /\b(error|unauthorized|forbidden|invalid.?key)\b/i.test(p.text)),
  );
  if (errorParts.length > 0) {
    const firstError =
      errorParts[0].error ??
      errorParts[0].text ??
      JSON.stringify(errorParts[0]);
    return {
      isEmpty: false,
      hasError: true,
      warning:
        `The response contains an error: ${typeof firstError === "string" ? firstError : JSON.stringify(firstError)}. ` +
        "This may indicate an authentication issue. " +
        "Use `opencode_auth_set` to verify your API key.",
    };
  }

  // Check if there's any actual text content
  const textContent = parts
    .filter((p: any) => p.type === "text")
    .map((p: any) => (p.text ?? p.content ?? "").trim())
    .join("");

  if (parts.length === 0 || textContent === "") {
    return {
      isEmpty: true,
      hasError: false,
      warning:
        "The AI returned a response with no text content. This usually means " +
        "the provider API key is missing or the model is unavailable. " +
        "Try a different provider/model, or use `opencode_auth_set` to configure credentials.",
    };
  }

  return { isEmpty: false, hasError: false, warning: null };
}

/**
 * Detect if a string value looks like an API key or secret token,
 * regardless of the key name it's stored under.
 */
const SECRET_VALUE_PREFIXES = /^(?:sk-|tvly-|ctx7sk-|pplx-|hf_|ghp_|gho_|ghu_|ghs_|ghr_|xoxb-|xoxp-|xapp-|whsec_|rk-|pk_live_|sk_live_|sk_test_|pk_test_|FLWSECK_|access_|bearer\s)/i;
const LONG_HEX_OR_BASE64 = /^[A-Za-z0-9+/=_-]{32,}$/;

function looksLikeSecret(val: string): boolean {
  if (val.length < 16) return false;
  if (SECRET_VALUE_PREFIXES.test(val)) return true;
  // Long alphanumeric strings without spaces (probable tokens)
  if (LONG_HEX_OR_BASE64.test(val) && !val.includes(" ")) return true;
  return false;
}

/**
 * Redact query-parameter values in a URL string that look like secrets.
 */
function redactUrlSecrets(url: string): string {
  try {
    const parsed = new URL(url);
    let changed = false;
    const sensitiveParamPattern = /(?:key|token|secret|password|credential|auth)/i;
    for (const [name, val] of parsed.searchParams.entries()) {
      if ((sensitiveParamPattern.test(name) && val.length > 8) || looksLikeSecret(val)) {
        parsed.searchParams.set(name, val.slice(0, 4) + "***REDACTED***");
        changed = true;
      }
    }
    return changed ? parsed.toString() : url;
  } catch {
    return url;
  }
}

/**
 * Redact values that look like API keys, tokens, or secrets.
 * Replaces the value with the first 4 characters + "***REDACTED***".
 * Works recursively on objects and arrays.
 *
 * Three layers of detection:
 * 1. Key-name based: key names matching sensitive patterns (KEY, TOKEN, SECRET, etc.)
 * 2. Value-based: string values matching known API key prefixes or long hex/base64 tokens
 * 3. URL-based: query parameters in URL strings that contain secrets
 */
export function redactSecrets(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    return value.map((item) => {
      // Redact string items in arrays that look like secrets (e.g. command args)
      if (typeof item === "string" && looksLikeSecret(item)) {
        return item.slice(0, 4) + "***REDACTED***";
      }
      return redactSecrets(item);
    });
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    const sensitiveKeyPattern = /(?:key|token|secret|password|credential|api_key|apikey|auth)/i;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string") {
        if (v.length > 8 && sensitiveKeyPattern.test(k)) {
          // Layer 1: key-name match
          result[k] = v.slice(0, 4) + "***REDACTED***";
        } else if (looksLikeSecret(v)) {
          // Layer 2: value looks like a secret
          result[k] = v.slice(0, 4) + "***REDACTED***";
        } else if (v.includes("://") && v.includes("?")) {
          // Layer 3: URL with query params — redact secret params
          result[k] = redactUrlSecrets(v);
        } else {
          result[k] = v;
        }
      } else if (typeof v === "object" && v !== null) {
        result[k] = redactSecrets(v);
      } else {
        result[k] = v;
      }
    }
    return result;
  }

  return value;
}

/**
 * Determine whether a provider object from the OpenCode API is truly configured
 * (i.e. has usable credentials), as opposed to being a built-in default.
 *
 * Detection layers:
 *  - source "env" / "config" / "api" → always configured
 *  - source "custom" with a non-empty apiKey → configured
 *  - source "custom" for "anthropic" with extra option keys (OAuth sets headers) → configured
 *  - Everything else → not configured
 */
export function isProviderConfigured(p: Record<string, unknown>): boolean {
  const source = p.source as string | undefined;
  if (source === "env" || source === "config" || source === "api") return true;
  if (source === "custom") {
    const opts = p.options as Record<string, unknown> | undefined;
    if (typeof opts?.apiKey === "string" && opts.apiKey !== "") return true;
    // Anthropic heuristic: OAuth sets headers but no apiKey
    if (p.id === "anthropic" && opts && Object.keys(opts).some((k) => k !== "apiKey")) return true;
  }
  return false;
}

/**
 * Resolve a session status value from the OpenCode API.
 *
 * The API may return status as a plain string ("idle", "running") or as an
 * object like `{ state: "running", ... }`.  This helper normalises both forms
 * into a human-readable string.
 */
export function resolveSessionStatus(raw: unknown): string {
  if (raw === null || raw === undefined) return "idle";
  if (typeof raw === "string") return raw;
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    // Try common property names the API might use
    for (const key of ["state", "status", "type"]) {
      if (typeof obj[key] === "string") return obj[key] as string;
    }
    // Last resort: check for a meaningful boolean flag
    if (obj.running === true) return "running";
    if (obj.done === true) return "completed";
    if (obj.error === true) return "error";
  }
  return "unknown";
}

/**
 * Standard tool response builder.
 */
export function toolResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

export function toolError(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  const suggestions = diagnoseError(msg);
  const text = suggestions
    ? `Error: ${msg}\n\n**Suggestions:**\n${suggestions}`
    : `Error: ${msg}`;
  return toolResult(text, true);
}

/**
 * Analyze an error message and return contextual suggestions, or empty
 * string if no specific advice applies.  Keeps suggestions concise to
 * minimise token overhead.
 */
function diagnoseError(msg: string): string {
  const lower = msg.toLowerCase();
  const tips: string[] = [];

  if (lower.includes("api key") || lower.includes("401") || lower.includes("403") || lower.includes("unauthorized") || lower.includes("forbidden")) {
    tips.push("- Check credentials with `opencode_provider_test`");
    tips.push("- Set a key with `opencode_auth_set`");
  } else if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("aborted")) {
    tips.push("- Use `opencode_run` for complex tasks (handles polling automatically)");
    tips.push("- Or use `opencode_message_send_async` + `opencode_wait` for manual control");
    tips.push("- Check session progress with `opencode_conversation`");
  } else if (lower.includes("not found") && lower.includes("session")) {
    tips.push("- List active sessions with `opencode_sessions_overview`");
  } else if (lower.includes("rate limit") || lower.includes("429")) {
    tips.push("- Wait a moment and retry, or switch provider");
    tips.push("- Try a free model: `opencode_ask` with providerID `opencode`, modelID `minimax-m2.1-free`");
  } else if (lower.includes("econnrefused")) {
    tips.push("- The OpenCode server is not accepting connections");
    tips.push("- Is `opencode serve` running? Check with `opencode_setup`");
    tips.push("- Verify OPENCODE_BASE_URL is correct (default: http://127.0.0.1:4096)");
    tips.push("- The server will auto-reconnect on the next request if OPENCODE_AUTO_SERVE is enabled");
  } else if (lower.includes("enotfound") || lower.includes("ehostunreach")) {
    tips.push("- Cannot reach the OpenCode server host");
    tips.push("- Check that OPENCODE_BASE_URL points to a reachable address");
    tips.push("- If running remotely, verify network connectivity");
  } else if (lower.includes("etimedout")) {
    tips.push("- The server is not responding (connection timed out)");
    tips.push("- The server may be overloaded or starting up — retry in a few seconds");
    tips.push("- Check with `opencode_setup` to verify server health");
  } else if (lower.includes("unreachable") || lower.includes("fetch failed")) {
    tips.push("- Is `opencode serve` running? Check with `opencode_setup`");
    tips.push("- Verify OPENCODE_BASE_URL is correct (default: http://127.0.0.1:4096)");
  } else if (lower.includes("directory not found") || lower.includes("not an absolute path")) {
    tips.push("- The `directory` parameter must be an absolute path to an existing directory");
    tips.push("- Example: `/home/user/my-project` (not `./my-project` or `~/my-project`)");
  }

  return tips.join("\n");
}

export function toolJson(value: unknown) {
  return toolResult(safeStringify(value));
}
