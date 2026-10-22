/**
 * Smart response formatting helpers.
 *
 * Instead of dumping raw JSON to the LLM, these helpers extract the
 * meaningful content from OpenCode API responses so the LLM can reason
 * about them efficiently.
 */

import { z } from "zod";
import { posix, win32 } from "node:path";

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

// OpenCode 2.x dropped prompt-level structured output (OutputFormat); prompts
// are plain text and models are selected per session.

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
 * Validate a server-side absolute path without interpreting it on this host.
 * POSIX, Windows drive and UNC paths are supported on every client platform.
 * Preserve separators, symlinks and dot segments for the server to resolve.
 * Local-only filesystem tools perform their own validation separately.
 */
export function normalizeDirectory(directory?: string): string | undefined {
  if (!directory) return undefined;

  // Reject control bytes that could smuggle headers when this value is
  // forwarded as `x-opencode-directory`. Node's `undici` rejects CR/LF in
  // header values, but defending here keeps the contract explicit and
  // protects against future runtime changes or non-fetch transports.
  if (/[\0\r\n]/.test(directory)) {
    throw new Error(
      `Invalid directory: path must not contain NUL or CR/LF characters.`,
    );
  }

  const windowsAbsolute = win32.isAbsolute(directory) &&
    (/^[a-z]:[\\/]/i.test(directory) || /^\\\\[^\\]+\\[^\\]+/.test(directory));
  if (!posix.isAbsolute(directory) && !windowsAbsolute) {
    throw new Error(
      `Invalid directory: "${directory}" is not an absolute path. ` +
      `Use an absolute path on the OpenCode server, not a client-relative path.`,
    );
  }
  return directory;
}

/**
 * Extract a human-readable summary from a message response.
 * Pulls text content from parts, summarizes tool calls, etc.
 * Accepts any shape — casts internally for safety.
 */
/**
 * Format a single OpenCode 2.x message into readable text.
 *
 * Messages are flat objects tagged by `type`:
 *  - `user`      → `{ id, time, type, text | payload.text }`
 *  - `assistant` → `{ id, time, type, content: [text|reasoning|tool], finish, error, cost, tokens }`
 *  - `idle`      → `{ id, time, type, outcome, error }` (turn separators)
 */
export function formatMessageResponse(response: unknown): string {
  const r = response as any;
  if (r === null || r === undefined) return "";
  if (typeof r !== "object") return String(r);
  const sections: string[] = [];

  if (r.type === "user") {
    const text = typeof r.text === "string" ? r.text : typeof r.payload?.text === "string" ? r.payload.text : undefined;
    sections.push(text ?? safeStringify(r.payload ?? r));
    return sections.join("\n\n");
  }
  if (r.type === "idle") {
    const outcome = typeof r.outcome === "string" ? r.outcome : "unknown";
    sections.push(r.error ? `Run ${outcome}: ${JSON.stringify(r.error)}` : `Run ${outcome}.`);
    return sections.join("\n\n");
  }

  if (Array.isArray(r.content)) {
    for (const part of r.content as any[]) {
      switch (part?.type) {
        case "text":
          if (part.text) sections.push(part.text);
          break;
        case "reasoning":
          // Reasoning traces are model-internal; omit from user-facing output.
          break;
        case "tool": {
          const state = part.state ?? {};
          const name = part.name ?? "unknown";
          if (state.status === "error") {
            const err = state.error;
            const detail = typeof err?.message === "string" ? err.message : JSON.stringify(err ?? "");
            sections.push(`[Tool: ${name}] ERROR: ${detail}`);
          } else if (state.status === "completed") {
            const detail = summarizeToolContent(state.content);
            sections.push(`[Tool: ${name}]${detail ? ` ${detail}` : ""}`);
          } else {
            sections.push(`[Tool: ${name}] ${state.status ?? "running"}`);
          }
          break;
        }
        default:
          if (part?.type && part.text) sections.push(part.text);
          break;
      }
    }
  }
  if (typeof r.text === "string" && sections.length === 0) sections.push(r.text);
  if (r.error && sections.length === 0) {
    const err = r.error;
    sections.push(`Error: ${typeof err?.message === "string" ? err.message : JSON.stringify(err)}`);
  }
  return sections.join("\n\n");
}

/** Render tool result content (array of text/file items) as a compact hint. */
function summarizeToolContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const texts = content
    .filter((item: any) => item?.type === "text" && typeof item.text === "string")
    .map((item: any) => item.text);
  if (texts.length === 0) return "";
  const joined = texts.join("\n");
  return joined.length > 300 ? joined.slice(0, 297) + "..." : joined;
}

/**
 * Format a list of OpenCode 2.x messages (any order), extracting text content
 * from each. Idle markers delimit turns; assistant messages carry tool parts.
 */
export function formatMessageList(
  messages: unknown[],
): string {
  if (!messages || messages.length === 0) return "No messages found.";

  const ordered = [...messages].sort((a, b) => {
    const x = a as any, y = b as any;
    return (x?.time?.created ?? 0) - (y?.time?.created ?? 0) || String(x?.id ?? "").localeCompare(String(y?.id ?? ""));
  });

  return ordered
    .map((raw) => {
      const msg = raw as any;
      const type = msg?.type ?? "unknown";
      const id = msg?.id ?? "?";
      const time = typeof msg?.time?.created === "number" ? new Date(msg.time.created).toISOString() : "";

      if (type === "idle") {
        const outcome = msg.outcome ?? "unknown";
        return `--- [idle] (${id}) ---\n${msg.error ? `Run ${outcome}: ${JSON.stringify(msg.error)}` : `Run ${outcome}.`}`;
      }
      if (type === "user") {
        const text = typeof msg?.text === "string" ? msg.text : msg?.payload?.text;
        return `--- [user] (${id})${time ? ` ${time}` : ""} ---\n${text ?? "(no text)"}`;
      }
      if (type !== "assistant") {
        const text = typeof msg?.text === "string" ? msg.text : JSON.stringify(msg?.payload ?? msg);
        return `--- [${type}] (${id}) ---\n${text}`;
      }

      const content = Array.isArray(msg.content) ? msg.content : [];
      const textParts = content
        .filter((p: any) => p?.type === "text" && p.text)
        .map((p: any) => String(p.text).trim())
        .filter(Boolean)
        .join("\n");
      const toolParts = content.filter((p: any) => p?.type === "tool");
      const modelTag = msg?.model?.providerID && msg?.model?.id ? ` model: ${msg.model.providerID}/${msg.model.id}` : "";

      let summary = `--- [assistant] (${id})${time ? ` ${time}` : ""}${modelTag} ---\n`;
      if (textParts) {
        summary += textParts;
        if (toolParts.length > 0) summary += `\n[${toolParts.length} tool call(s)]`;
      } else if (toolParts.length > 0) {
        const toolSummaries = toolParts.slice(0, 10).map((p: any) => {
          const name = p.name ?? "unknown";
          const hint = summarizeToolInput(p.state?.input);
          const errTag = p.state?.status === "error" ? " ERROR" : "";
          return `  ${name}${hint ? `: ${hint}` : ""}${errTag}`;
        });
        summary += `Agent performed ${toolParts.length} action(s):\n${toolSummaries.join("\n")}`;
        if (toolParts.length > 10) summary += `\n  ... and ${toolParts.length - 10} more`;
      } else {
        summary += "(no content)";
      }

      const costMeta = extractCostMeta(msg);
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
 * Extract cost/token metadata from an OpenCode 2.x assistant message.
 */
function extractCostMeta(msg: any): string {
  const meta: string[] = [];
  if (typeof msg?.cost === "number" && msg.cost > 0) meta.push(`cost: $${Number(msg.cost).toFixed(4)}`);
  const t = msg?.tokens;
  if (t && typeof t === "object") {
    const tokParts: string[] = [];
    if (t.input) tokParts.push(`${t.input} in`);
    if (t.output) tokParts.push(`${t.output} out`);
    if (t.reasoning) tokParts.push(`${t.reasoning} reasoning`);
    if (t.cache?.read || t.cache?.write) tokParts.push(`${(t.cache.read ?? 0) + (t.cache.write ?? 0)} cache`);
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
      const patch = diff.patch ?? diff.diff;
      if (typeof patch === "string") {
        line += `\n${patch}`;
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
      const parentID = s?.parentID ? ` (child of ${s.parentID})` : "";
      const created = typeof s?.time?.created === "number" ? ` created ${new Date(s.time.created).toISOString()}` : "";
      const outcome = typeof s?.outcome === "string" ? ` [${s.outcome}]` : "";
      return `- ${title} [${id}]${parentID}${outcome}${created}`;
    })
    .join("\n");
}

/**
 * Serialize JSON, returning a valid JSON preview envelope for large values.
 * The preview is deliberately a string: it must never be mistaken for complete data.
 */
export function safeStringify(
  value: unknown,
  maxLength: number = 50000,
): string {
  if (!Number.isInteger(maxLength) || maxLength < 32) {
    throw new Error("JSON output budget must be an integer of at least 32 characters.");
  }
  const json = JSON.stringify(value ?? null, null, 2);
  if (json.length <= maxLength) return json;
  const envelope = (length: number) => JSON.stringify({
    truncated: true,
    originalLength: json.length,
    omittedCharacters: json.length - length,
    preview: json.slice(0, length),
  });
  if (envelope(0).length > maxLength) return JSON.stringify({ truncated: true });
  let low = 0;
  let high = Math.min(json.length, maxLength);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (envelope(middle).length <= maxLength) low = middle;
    else high = middle - 1;
  }
  return envelope(low);
}

/**
 * Analyze an OpenCode 2.x assistant message for signs of failure:
 *  - Completely empty (null/undefined)
 *  - Has content but no text (provider returned nothing)
 *  - Contains an error field or errored tool parts
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
  const content = Array.isArray(r?.content) ? r.content : [];

  const errorParts = content.filter(
    (p: any) => p?.type === "tool" && p?.state?.status === "error",
  );
  if (r?.error || r?.type === "idle" && r?.outcome === "failed" || errorParts.length > 0) {
    const firstError =
      r?.error ?? errorParts[0]?.state?.error ?? JSON.stringify(errorParts[0]);
    return {
      isEmpty: false,
      hasError: true,
      warning:
        `The response contains an error: ${typeof firstError === "string" ? firstError : JSON.stringify(firstError)}.`,
    };
  }

  const hasToolActivity = content.some((p: any) => p?.type === "tool");
  if (content.length === 0 && typeof r?.text !== "string") {
    return {
      isEmpty: true,
      hasError: false,
      warning:
        "The AI returned a response with no text content. This usually means " +
        "the provider API key is missing or the model is unavailable. " +
        "Try a different provider/model, or use `opencode_auth_set` to configure credentials.",
    };
  }
  const textContent = content
    .filter((p: any) => p?.type === "text")
    .map((p: any) => String(p.text ?? "").trim())
    .join("");
  if (textContent === "" && !hasToolActivity && typeof r?.text !== "string") {
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
      if ((sensitiveParamPattern.test(name) && val.length > 0) || looksLikeSecret(val)) {
        parsed.searchParams.set(name, (val.length > 8 ? val.slice(0, 4) : "") + "***REDACTED***");
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
        if (v.length > 0 && sensitiveKeyPattern.test(k)) {
          // Layer 1: key-name match
          result[k] = (v.length > 8 ? v.slice(0, 4) : "") + "***REDACTED***";
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
 * Determine whether a provider object from the OpenCode 2.x API is usable.
 *
 * v2 providers carry `integrationID`, `activation`, and `settings`; usable
 * credentials live either in the provider settings (apiKey) or as an active
 * credential entry for the provider's integration.
 */
export function isProviderConfigured(
  p: Record<string, unknown>,
  credentials?: Array<Record<string, unknown>>,
): boolean {
  const settings = p.settings as Record<string, unknown> | undefined;
  if (typeof settings?.apiKey === "string" && settings.apiKey !== "") return true;
  const id = p.integrationID ?? p.id;
  if (typeof id !== "string") return false;
  return (credentials ?? []).some(
    (credential) => credential?.active === true && (credential.integrationID === id || credential.integrationID === p.id),
  );
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
export function toolResult(text: string, isError = false, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
    ...(structuredContent ? { structuredContent } : {}),
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
    tips.push("- Use `opencode_provider_list` and `opencode_provider_models` to find an available alternative");
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
  const text = safeStringify(value);
  return toolResult(text, false, { data: JSON.parse(text) });
}
