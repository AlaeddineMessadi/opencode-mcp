/**
 * Smart response formatting helpers.
 *
 * Instead of dumping raw JSON to the LLM, these helpers extract the
 * meaningful content from OpenCode API responses so the LLM can reason
 * about them efficiently.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Extract a human-readable summary from a message response.
 * Pulls text content from parts, summarizes tool calls, etc.
 * Accepts any shape — casts internally for safety.
 */
export function formatMessageResponse(response: unknown): string {
  const r = response as any;
  const sections: string[] = [];

  if (r?.info) {
    const { id, role, createdAt } = r.info;
    sections.push(
      `[${role ?? "unknown"}] Message ${id ?? "?"}${createdAt ? ` at ${createdAt}` : ""}`,
    );
  }

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
        default:
          sections.push(
            `[${part.type}] ${JSON.stringify(part, null, 2)}`,
          );
      }
    }
  }

  return sections.join("\n\n");
}

/**
 * Format a list of messages, extracting text content from each.
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
        .map((p: any) => p.text ?? p.content ?? "")
        .join("");
      const toolParts = parts.filter(
        (p: any) => p.type === "tool-invocation" || p.type === "tool-result",
      );

      let summary = `--- Message ${i + 1} [${role}] (${id}) ---\n`;
      if (textParts) summary += textParts;
      if (toolParts.length > 0) {
        summary += `\n[${toolParts.length} tool call(s)]`;
      }
      return summary;
    })
    .join("\n\n");
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
  return toolResult(`Error: ${msg}`, true);
}

export function toolJson(value: unknown) {
  return toolResult(safeStringify(value));
}
