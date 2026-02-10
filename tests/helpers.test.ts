import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  formatMessageResponse,
  formatMessageList,
  formatDiffResponse,
  formatSessionList,
  analyzeMessageResponse,
  isProviderConfigured,
  redactSecrets,
  resolveSessionStatus,
  safeStringify,
  setModelDefaults,
  applyModelDefaults,
  normalizeDirectory,
  toolResult,
  toolError,
  toolJson,
  directoryParam,
} from "../src/helpers.js";

// ─── formatMessageResponse ───────────────────────────────────────────────

describe("formatMessageResponse", () => {
  it("returns empty string for null/undefined input", () => {
    expect(formatMessageResponse(null)).toBe("");
    expect(formatMessageResponse(undefined)).toBe("");
  });

  it("omits verbose message info header for cleaner output", () => {
    const result = formatMessageResponse({
      info: { id: "msg-1", role: "assistant", createdAt: "2025-01-01" },
      parts: [],
    });
    // Message header is now omitted — output should be empty for messages with no parts
    expect(result).toBe("");
  });

  it("extracts text parts", () => {
    const result = formatMessageResponse({
      parts: [
        { type: "text", text: "Hello world" },
        { type: "text", text: "Second part" },
      ],
    });
    expect(result).toContain("Hello world");
    expect(result).toContain("Second part");
  });

  it("extracts text from content field as fallback", () => {
    const result = formatMessageResponse({
      parts: [{ type: "text", content: "Fallback content" }],
    });
    expect(result).toContain("Fallback content");
  });

  it("formats tool-invocation parts", () => {
    const result = formatMessageResponse({
      parts: [
        {
          type: "tool-invocation",
          toolName: "readFile",
          input: { path: "/foo" },
        },
      ],
    });
    expect(result).toContain("[Tool: readFile]");
    expect(result).toContain("/foo");
  });

  it("formats tool-result parts with output", () => {
    const result = formatMessageResponse({
      parts: [
        {
          type: "tool-result",
          toolName: "readFile",
          output: "file contents here",
        },
      ],
    });
    expect(result).toContain("[Tool: readFile]");
    expect(result).toContain("file contents here");
  });

  it("formats tool errors", () => {
    const result = formatMessageResponse({
      parts: [
        {
          type: "tool-invocation",
          toolName: "readFile",
          error: "File not found",
        },
      ],
    });
    expect(result).toContain("ERROR: File not found");
  });

  it("handles unknown part types", () => {
    const result = formatMessageResponse({
      parts: [{ type: "custom-type", data: "something" }],
    });
    expect(result).toContain("[custom-type]");
  });

  it("handles missing info gracefully and still extracts text", () => {
    const result = formatMessageResponse({
      info: { role: undefined, id: undefined },
      parts: [{ type: "text", text: "hello" }],
    });
    // No header emitted, but text content is still extracted
    expect(result).toContain("hello");
  });
});

// ─── formatMessageList ───────────────────────────────────────────────────

describe("formatMessageList", () => {
  it("returns 'No messages found.' for empty array", () => {
    expect(formatMessageList([])).toBe("No messages found.");
  });

  it("returns 'No messages found.' for null/undefined", () => {
    expect(formatMessageList(null as unknown as unknown[])).toBe(
      "No messages found.",
    );
  });

  it("formats a list of messages with indices", () => {
    const messages = [
      {
        info: { role: "user", id: "m1" },
        parts: [{ type: "text", text: "Hi there" }],
      },
      {
        info: { role: "assistant", id: "m2" },
        parts: [{ type: "text", text: "Hello!" }],
      },
    ];
    const result = formatMessageList(messages);
    expect(result).toContain("Message 1 [user]");
    expect(result).toContain("Message 2 [assistant]");
    expect(result).toContain("Hi there");
    expect(result).toContain("Hello!");
  });

  it("counts tool calls when text is also present", () => {
    const messages = [
      {
        info: { role: "assistant", id: "m1" },
        parts: [
          { type: "text", text: "Let me check" },
          { type: "tool-invocation", toolName: "search" },
          { type: "tool-result", toolName: "search" },
        ],
      },
    ];
    const result = formatMessageList(messages);
    expect(result).toContain("2 tool call(s)");
    expect(result).toContain("Let me check");
  });

  it("shows tool summaries when text is empty (the empty-message bug)", () => {
    const messages = [
      {
        info: { role: "assistant", id: "m1" },
        parts: [
          { type: "text", text: "" },
          { type: "tool-invocation", toolName: "Write", input: { path: "/src/App.tsx" } },
          { type: "tool-result", toolName: "Write" },
        ],
      },
    ];
    const result = formatMessageList(messages);
    expect(result).toContain("Agent performed 2 action(s)");
    expect(result).toContain("Write: /src/App.tsx");
  });

  it("shows tool summaries when there are no text parts at all", () => {
    const messages = [
      {
        info: { role: "assistant", id: "m1" },
        parts: [
          { type: "tool-invocation", toolName: "Bash", input: { command: "npm install" } },
        ],
      },
    ];
    const result = formatMessageList(messages);
    expect(result).toContain("Agent performed 1 action(s)");
    expect(result).toContain("Bash: npm install");
  });

  it("shows (no content) when parts array is empty", () => {
    const messages = [
      { info: { role: "assistant", id: "m1" }, parts: [] },
    ];
    const result = formatMessageList(messages);
    expect(result).toContain("(no content)");
  });

  it("truncates long tool input hints to 80 chars", () => {
    const longPath = "/very/long/path/that/goes/on/and/on/and/on/and/repeats/many/times/so/it/exceeds/eighty/chars.tsx";
    const messages = [
      {
        info: { role: "assistant", id: "m1" },
        parts: [
          { type: "tool-invocation", toolName: "Write", input: { path: longPath } },
        ],
      },
    ];
    const result = formatMessageList(messages);
    expect(result).toContain("...");
    expect(result.length).toBeLessThan(longPath.length + 200);
  });

  it("caps tool summaries at 10 and shows overflow count", () => {
    const toolParts = Array.from({ length: 15 }, (_, i) => ({
      type: "tool-invocation",
      toolName: `Tool${i}`,
      input: { path: `/file${i}.ts` },
    }));
    const messages = [
      { info: { role: "assistant", id: "m1" }, parts: toolParts },
    ];
    const result = formatMessageList(messages);
    expect(result).toContain("Agent performed 15 action(s)");
    expect(result).toContain("... and 5 more");
    expect(result).toContain("Tool0");
    expect(result).toContain("Tool9");
    expect(result).not.toContain("Tool10:");
  });

  it("marks tool errors in summaries", () => {
    const messages = [
      {
        info: { role: "assistant", id: "m1" },
        parts: [
          { type: "tool-result", toolName: "Bash", error: "command not found" },
        ],
      },
    ];
    const result = formatMessageList(messages);
    expect(result).toContain("Bash");
    expect(result).toContain("ERROR");
  });

  it("appends cost metadata from step-finish parts", () => {
    const messages = [
      {
        info: { role: "assistant", id: "m1" },
        parts: [
          { type: "text", text: "Done!" },
          { type: "step-finish", cost: 0.0023, tokens: { input: 1500, output: 200 } },
        ],
      },
    ];
    const result = formatMessageList(messages);
    expect(result).toContain("cost: $0.0023");
    expect(result).toContain("tokens: 1500 in, 200 out");
  });

  it("prefers command/query/url hints from tool input", () => {
    const messages = [
      {
        info: { role: "assistant", id: "m1" },
        parts: [
          { type: "tool-invocation", toolName: "Search", input: { query: "todo context" } },
          { type: "tool-invocation", toolName: "Fetch", input: { url: "https://example.com" } },
        ],
      },
    ];
    const result = formatMessageList(messages);
    expect(result).toContain("Search: todo context");
    expect(result).toContain("Fetch: https://example.com");
  });
});

// ─── formatDiffResponse ──────────────────────────────────────────────────

describe("formatDiffResponse", () => {
  it("returns 'No changes found.' for empty array", () => {
    expect(formatDiffResponse([])).toBe("No changes found.");
  });

  it("returns 'No changes found.' for null/undefined", () => {
    expect(formatDiffResponse(null as unknown as unknown[])).toBe(
      "No changes found.",
    );
  });

  it("formats diffs with path and status", () => {
    const diffs = [
      { path: "src/index.ts", status: "modified", additions: 5, deletions: 2 },
      { path: "README.md", status: "added", additions: 10, deletions: 0 },
    ];
    const result = formatDiffResponse(diffs);
    expect(result).toContain("modified src/index.ts");
    expect(result).toContain("+5 -2");
    expect(result).toContain("added README.md");
    expect(result).toContain("+10");
  });

  it("includes diff content when present", () => {
    const diffs = [
      {
        path: "foo.ts",
        status: "modified",
        diff: "+const x = 1;\n-const x = 0;",
      },
    ];
    const result = formatDiffResponse(diffs);
    expect(result).toContain("+const x = 1;");
  });

  it("handles file field as fallback for path", () => {
    const diffs = [{ file: "bar.ts", type: "changed" }];
    const result = formatDiffResponse(diffs);
    expect(result).toContain("bar.ts");
    expect(result).toContain("changed");
  });
});

// ─── formatSessionList ───────────────────────────────────────────────────

describe("formatSessionList", () => {
  it("returns 'No sessions found.' for empty array", () => {
    expect(formatSessionList([])).toBe("No sessions found.");
  });

  it("returns 'No sessions found.' for null/undefined", () => {
    expect(formatSessionList(null as unknown as unknown[])).toBe(
      "No sessions found.",
    );
  });

  it("formats sessions with title, id, and date", () => {
    const sessions = [
      { id: "s1", title: "Fix bug", createdAt: "2025-01-01" },
      { id: "s2", title: "Add feature", createdAt: "2025-01-02" },
    ];
    const result = formatSessionList(sessions);
    expect(result).toContain("Fix bug [s1]");
    expect(result).toContain("Add feature [s2]");
    expect(result).toContain("created 2025-01-01");
  });

  it("shows parent relationship", () => {
    const sessions = [{ id: "s2", title: "Child", parentID: "s1" }];
    const result = formatSessionList(sessions);
    expect(result).toContain("(child of s1)");
  });

  it("handles untitled sessions", () => {
    const sessions = [{ id: "s1" }];
    const result = formatSessionList(sessions);
    expect(result).toContain("(untitled)");
  });
});

// ─── analyzeMessageResponse ──────────────────────────────────────────────

describe("analyzeMessageResponse", () => {
  it("detects null response as empty", () => {
    const result = analyzeMessageResponse(null);
    expect(result.isEmpty).toBe(true);
    expect(result.hasError).toBe(false);
    expect(result.warning).toContain("empty response");
    expect(result.warning).toContain("opencode_setup");
  });

  it("detects undefined response as empty", () => {
    const result = analyzeMessageResponse(undefined);
    expect(result.isEmpty).toBe(true);
    expect(result.warning).toContain("API key");
  });

  it("detects response with empty parts array as empty", () => {
    const result = analyzeMessageResponse({ parts: [] });
    expect(result.isEmpty).toBe(true);
    expect(result.warning).toContain("no text content");
  });

  it("detects response with only whitespace text as empty", () => {
    const result = analyzeMessageResponse({
      parts: [{ type: "text", text: "   " }],
    });
    expect(result.isEmpty).toBe(true);
    expect(result.warning).toContain("no text content");
  });

  it("detects response with no text parts as empty", () => {
    const result = analyzeMessageResponse({
      parts: [{ type: "tool-invocation", toolName: "something" }],
    });
    expect(result.isEmpty).toBe(true);
    expect(result.warning).toContain("no text content");
  });

  it("detects error parts with .error field", () => {
    const result = analyzeMessageResponse({
      parts: [{ type: "tool-result", error: "Unauthorized" }],
    });
    expect(result.hasError).toBe(true);
    expect(result.isEmpty).toBe(false);
    expect(result.warning).toContain("Unauthorized");
    expect(result.warning).toContain("authentication");
  });

  it("detects error keywords in text parts", () => {
    const result = analyzeMessageResponse({
      parts: [{ type: "text", text: "Error: invalid key provided" }],
    });
    expect(result.hasError).toBe(true);
    expect(result.warning).toContain("invalid key");
  });

  it("detects 'unauthorized' keyword in text", () => {
    const result = analyzeMessageResponse({
      parts: [{ type: "text", text: "Request unauthorized by provider" }],
    });
    expect(result.hasError).toBe(true);
  });

  it("returns no warning for valid response with text", () => {
    const result = analyzeMessageResponse({
      parts: [{ type: "text", text: "Hello, world!" }],
    });
    expect(result.isEmpty).toBe(false);
    expect(result.hasError).toBe(false);
    expect(result.warning).toBeNull();
  });

  it("returns no warning for response with mixed parts including text", () => {
    const result = analyzeMessageResponse({
      info: { id: "m1", role: "assistant" },
      parts: [
        { type: "text", text: "Let me check that." },
        { type: "tool-invocation", toolName: "readFile" },
      ],
    });
    expect(result.isEmpty).toBe(false);
    expect(result.hasError).toBe(false);
    expect(result.warning).toBeNull();
  });

  it("handles response with no parts field", () => {
    const result = analyzeMessageResponse({ info: { id: "m1" } });
    expect(result.isEmpty).toBe(true);
    expect(result.warning).toContain("no text content");
  });
});

// ─── isProviderConfigured ─────────────────────────────────────────────────

describe("isProviderConfigured", () => {
  it("returns true for source=env", () => {
    expect(isProviderConfigured({ id: "huggingface", source: "env" })).toBe(true);
  });

  it("returns true for source=config", () => {
    expect(isProviderConfigured({ id: "google", source: "config" })).toBe(true);
  });

  it("returns true for source=api", () => {
    expect(isProviderConfigured({ id: "zai-coding", source: "api" })).toBe(true);
  });

  it("returns true for source=custom with non-empty apiKey", () => {
    expect(isProviderConfigured({ id: "opencode", source: "custom", options: { apiKey: "public" } })).toBe(true);
  });

  it("returns true for anthropic with OAuth headers (heuristic)", () => {
    expect(isProviderConfigured({
      id: "anthropic",
      source: "custom",
      options: { apiKey: "", headers: { "anthropic-beta": "test" } },
    })).toBe(true);
  });

  it("returns false for source=custom with empty options", () => {
    expect(isProviderConfigured({ id: "groq", source: "custom", options: {} })).toBe(false);
  });

  it("returns false for source=custom with only empty apiKey", () => {
    expect(isProviderConfigured({ id: "deepseek", source: "custom", options: { apiKey: "" } })).toBe(false);
  });

  it("returns false when source is undefined", () => {
    expect(isProviderConfigured({ id: "unknown" })).toBe(false);
  });

  it("returns false for non-anthropic provider with extra options but no apiKey", () => {
    // The anthropic heuristic should NOT apply to other providers
    expect(isProviderConfigured({
      id: "openai",
      source: "custom",
      options: { apiKey: "", headers: { "some-header": "value" } },
    })).toBe(false);
  });
});

// ─── redactSecrets ───────────────────────────────────────────────────────

describe("redactSecrets", () => {
  it("redacts values with 'key' in the property name", () => {
    const result = redactSecrets({ BRAVE_API_KEY: "sk-abc123456789" }) as Record<string, unknown>;
    expect(result.BRAVE_API_KEY).toBe("sk-a***REDACTED***");
  });

  it("redacts values with 'token' in the property name", () => {
    const result = redactSecrets({ HF_TOKEN: "hf_1234567890abcdef" }) as Record<string, unknown>;
    expect(result.HF_TOKEN).toBe("hf_1***REDACTED***");
  });

  it("redacts values with 'secret' in the property name", () => {
    const result = redactSecrets({ client_secret: "mysecretvalue123" }) as Record<string, unknown>;
    expect(result.client_secret).toBe("myse***REDACTED***");
  });

  it("redacts values with 'password' in the property name", () => {
    const result = redactSecrets({ db_password: "hunter2longpassword" }) as Record<string, unknown>;
    expect(result.db_password).toBe("hunt***REDACTED***");
  });

  it("does not redact short values (<=8 chars)", () => {
    const result = redactSecrets({ api_key: "short" }) as Record<string, unknown>;
    expect(result.api_key).toBe("short");
  });

  it("does not redact non-sensitive keys", () => {
    const result = redactSecrets({ theme: "dark", name: "my-project" }) as Record<string, unknown>;
    expect(result.theme).toBe("dark");
    expect(result.name).toBe("my-project");
  });

  it("redacts nested objects recursively", () => {
    const result = redactSecrets({
      mcp: {
        servers: {
          myserver: { api_key: "sk-longapikey123456" },
        },
      },
    }) as any;
    expect(result.mcp.servers.myserver.api_key).toBe("sk-l***REDACTED***");
  });

  it("handles arrays", () => {
    const result = redactSecrets([{ token: "longtoken12345678" }]) as any[];
    expect(result[0].token).toBe("long***REDACTED***");
  });

  it("handles null and undefined", () => {
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeUndefined();
  });

  it("passes through primitive values", () => {
    expect(redactSecrets("hello")).toBe("hello");
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(true)).toBe(true);
  });

  // --- Value-level scanning (F2 fix) ---

  it("redacts string values that look like API keys by prefix (sk-)", () => {
    const result = redactSecrets({ url: "sk-proj-abcdef1234567890abcdef" }) as Record<string, unknown>;
    expect(result.url).toBe("sk-p***REDACTED***");
  });

  it("redacts string values with known prefixes (tvly-, hf_, ghp_)", () => {
    const r1 = redactSecrets({ value: "tvly-dev-qFDR0t05aBc1234567890" }) as Record<string, unknown>;
    expect(r1.value).toBe("tvly***REDACTED***");

    const r2 = redactSecrets({ value: "hf_abcdef1234567890" }) as Record<string, unknown>;
    expect(r2.value).toBe("hf_a***REDACTED***");

    const r3 = redactSecrets({ arg: "ghp_xyzw1234567890abcdefgh" }) as Record<string, unknown>;
    expect(r3.arg).toBe("ghp_***REDACTED***");
  });

  it("redacts long hex/base64 token strings regardless of key name", () => {
    const result = redactSecrets({ command: "abcdef1234567890ABCDEF1234567890ab" }) as Record<string, unknown>;
    expect(result.command).toBe("abcd***REDACTED***");
  });

  it("does NOT redact short values even with known prefixes", () => {
    const result = redactSecrets({ v: "sk-short" }) as Record<string, unknown>;
    expect(result.v).toBe("sk-short");
  });

  it("redacts secrets in URL query parameters", () => {
    const result = redactSecrets({
      url: "https://api.example.com/mcp?tavilyApiKey=tvly-dev-qFDR0t05aBc1234567890",
    }) as Record<string, unknown>;
    const url = result.url as string;
    expect(url).toContain("tavilyApiKey=tvly***REDACTED***");
    expect(url).not.toContain("qFDR0t05");
  });

  it("redacts secrets in arrays (command args)", () => {
    const result = redactSecrets(["npx", "-y", "some-tool", "sk-proj-abcdef1234567890abcdef"]) as string[];
    expect(result[0]).toBe("npx");
    expect(result[1]).toBe("-y");
    expect(result[2]).toBe("some-tool");
    expect(result[3]).toBe("sk-p***REDACTED***");
  });

  it("does not redact normal URL without secrets in params", () => {
    const result = redactSecrets({
      url: "https://example.com/api?format=json&page=1",
    }) as Record<string, unknown>;
    expect(result.url).toBe("https://example.com/api?format=json&page=1");
  });
});

// ─── safeStringify ───────────────────────────────────────────────────────

describe("safeStringify", () => {
  it("stringifies normal objects", () => {
    const result = safeStringify({ a: 1, b: "hello" });
    expect(result).toBe(JSON.stringify({ a: 1, b: "hello" }, null, 2));
  });

  it("truncates long strings", () => {
    const big = { data: "x".repeat(100000) };
    const result = safeStringify(big, 100);
    expect(result.length).toBeLessThan(200);
    expect(result).toContain("truncated");
    expect(result).toContain("more characters");
  });

  it("does not truncate when under limit", () => {
    const result = safeStringify({ a: 1 }, 50000);
    expect(result).not.toContain("truncated");
  });

  it("uses default maxLength of 50000", () => {
    const small = { a: 1 };
    const result = safeStringify(small);
    expect(result).toBe(JSON.stringify(small, null, 2));
  });
});

// ─── toolResult ──────────────────────────────────────────────────────────

describe("toolResult", () => {
  it("returns standard MCP tool response", () => {
    const result = toolResult("hello");
    expect(result).toEqual({
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("adds isError flag when true", () => {
    const result = toolResult("fail", true);
    expect(result).toEqual({
      content: [{ type: "text", text: "fail" }],
      isError: true,
    });
  });

  it("does not add isError when false", () => {
    const result = toolResult("ok", false);
    expect(result).not.toHaveProperty("isError");
  });
});

// ─── toolError ───────────────────────────────────────────────────────────

describe("toolError", () => {
  it("extracts message from Error instances", () => {
    const result = toolError(new Error("something broke"));
    expect(result.content[0].text).toContain("Error: something broke");
    expect(result.isError).toBe(true);
  });

  it("converts non-Error values to string", () => {
    const result = toolError("string error");
    expect(result.content[0].text).toContain("Error: string error");
  });

  it("handles numbers", () => {
    const result = toolError(404);
    expect(result.content[0].text).toContain("Error: 404");
  });

  // ── Auto-suggestion tests ──────────────────────────────────────────

  it("suggests auth fix for 401 errors", () => {
    const result = toolError(new Error("Request failed with status 401"));
    expect(result.content[0].text).toContain("Suggestions");
    expect(result.content[0].text).toContain("opencode_provider_test");
    expect(result.content[0].text).toContain("opencode_auth_set");
  });

  it("suggests auth fix for API key errors", () => {
    const result = toolError(new Error("Invalid API key provided"));
    expect(result.content[0].text).toContain("Suggestions");
    expect(result.content[0].text).toContain("opencode_auth_set");
  });

  it("suggests async pattern for timeout errors", () => {
    const result = toolError(new Error("Request timed out after 120s"));
    expect(result.content[0].text).toContain("Suggestions");
    expect(result.content[0].text).toContain("opencode_message_send_async");
    expect(result.content[0].text).toContain("opencode_conversation");
  });

  it("suggests session list for session not found", () => {
    const result = toolError(new Error("Session not found: ses_abc123"));
    expect(result.content[0].text).toContain("opencode_sessions_overview");
  });

  it("suggests rate limit workaround for 429 errors", () => {
    const result = toolError(new Error("Rate limit exceeded (429)"));
    expect(result.content[0].text).toContain("Suggestions");
    expect(result.content[0].text).toContain("minimax-m2.1-free");
  });

  it("suggests server check for connection errors", () => {
    const result = toolError(new Error("fetch failed: ECONNREFUSED"));
    expect(result.content[0].text).toContain("opencode_setup");
  });

  it("does not add suggestions for generic errors", () => {
    const result = toolError(new Error("Something unexpected happened"));
    expect(result.content[0].text).toBe("Error: Something unexpected happened");
    expect(result.content[0].text).not.toContain("Suggestions");
  });
});

// ─── resolveSessionStatus ─────────────────────────────────────────────────

describe("resolveSessionStatus", () => {
  it("returns 'idle' for null/undefined", () => {
    expect(resolveSessionStatus(null)).toBe("idle");
    expect(resolveSessionStatus(undefined)).toBe("idle");
  });

  it("returns the string directly when status is a string", () => {
    expect(resolveSessionStatus("running")).toBe("running");
    expect(resolveSessionStatus("idle")).toBe("idle");
    expect(resolveSessionStatus("completed")).toBe("completed");
  });

  it("extracts .state from status objects", () => {
    expect(resolveSessionStatus({ state: "running" })).toBe("running");
    expect(resolveSessionStatus({ state: "idle" })).toBe("idle");
  });

  it("extracts .status from status objects", () => {
    expect(resolveSessionStatus({ status: "error" })).toBe("error");
  });

  it("extracts .type from status objects", () => {
    expect(resolveSessionStatus({ type: "processing" })).toBe("processing");
  });

  it("detects running from boolean flag", () => {
    expect(resolveSessionStatus({ running: true })).toBe("running");
  });

  it("detects done from boolean flag", () => {
    expect(resolveSessionStatus({ done: true })).toBe("completed");
  });

  it("detects error from boolean flag", () => {
    expect(resolveSessionStatus({ error: true })).toBe("error");
  });

  it("returns 'unknown' for unrecognisable objects", () => {
    expect(resolveSessionStatus({ foo: "bar" })).toBe("unknown");
    expect(resolveSessionStatus({})).toBe("unknown");
  });

  it("returns 'unknown' for non-string/non-object types", () => {
    expect(resolveSessionStatus(42)).toBe("unknown");
    expect(resolveSessionStatus(true)).toBe("unknown");
  });

  it("prefers .state over boolean flags", () => {
    expect(resolveSessionStatus({ state: "idle", running: true })).toBe("idle");
  });
});

// ─── toolJson ────────────────────────────────────────────────────────────

describe("toolJson", () => {
  it("wraps JSON output in a tool result", () => {
    const result = toolJson({ status: "ok" });
    expect(result.content[0].text).toContain('"status": "ok"');
    expect(result).not.toHaveProperty("isError");
  });

  it("handles arrays", () => {
    const result = toolJson([1, 2, 3]);
    expect(result.content[0].text).toContain("[");
    expect(result.content[0].text).toContain("1");
  });
});

// ─── directoryParam ─────────────────────────────────────────────────────

describe("directoryParam", () => {
  it("is a zod schema that accepts strings", () => {
    const result = directoryParam.safeParse("/home/user/project");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("/home/user/project");
    }
  });

  it("accepts undefined (optional)", () => {
    const result = directoryParam.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBeUndefined();
    }
  });

  it("rejects non-string values", () => {
    const result = directoryParam.safeParse(123);
    expect(result.success).toBe(false);
  });
});

// ─── setModelDefaults / applyModelDefaults ───────────────────────────────

describe("applyModelDefaults", () => {
  beforeEach(() => {
    // Reset defaults before each test
    setModelDefaults(undefined, undefined);
  });

  afterEach(() => {
    setModelDefaults(undefined, undefined);
  });

  it("returns explicit params when both are provided", () => {
    const result = applyModelDefaults("anthropic", "claude-opus-4-6");
    expect(result).toEqual({ providerID: "anthropic", modelID: "claude-opus-4-6" });
  });

  it("returns undefined when neither explicit params nor defaults are set", () => {
    const result = applyModelDefaults();
    expect(result).toBeUndefined();
  });

  it("returns undefined when only providerID is provided (incomplete pair)", () => {
    const result = applyModelDefaults("anthropic");
    expect(result).toBeUndefined();
  });

  it("returns undefined when only modelID is provided (incomplete pair)", () => {
    const result = applyModelDefaults(undefined, "claude-opus-4-6");
    expect(result).toBeUndefined();
  });

  it("falls back to env-var defaults when no explicit params", () => {
    setModelDefaults("openai", "gpt-4o");
    const result = applyModelDefaults();
    expect(result).toEqual({ providerID: "openai", modelID: "gpt-4o" });
  });

  it("falls back to defaults when only providerID is given (incomplete)", () => {
    setModelDefaults("openai", "gpt-4o");
    const result = applyModelDefaults("anthropic");
    expect(result).toEqual({ providerID: "openai", modelID: "gpt-4o" });
  });

  it("explicit params take priority over defaults", () => {
    setModelDefaults("openai", "gpt-4o");
    const result = applyModelDefaults("anthropic", "claude-opus-4-6");
    expect(result).toEqual({ providerID: "anthropic", modelID: "claude-opus-4-6" });
  });

  it("returns undefined when only default providerID is set (incomplete pair)", () => {
    setModelDefaults("openai", undefined);
    const result = applyModelDefaults();
    expect(result).toBeUndefined();
  });

  it("returns undefined when only default modelID is set (incomplete pair)", () => {
    setModelDefaults(undefined, "gpt-4o");
    const result = applyModelDefaults();
    expect(result).toBeUndefined();
  });
});

// ─── normalizeDirectory ──────────────────────────────────────────────────

describe("normalizeDirectory", () => {
  it("returns undefined for undefined input", () => {
    expect(normalizeDirectory(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string input", () => {
    expect(normalizeDirectory("")).toBeUndefined();
  });

  it("normalizes a valid absolute path", () => {
    const result = normalizeDirectory("/tmp");
    expect(result).toBe("/tmp");
  });

  it("removes trailing slashes", () => {
    const result = normalizeDirectory("/tmp/");
    expect(result).toBe("/tmp");
  });

  it("resolves .. in paths", () => {
    const result = normalizeDirectory("/tmp/foo/..");
    expect(result).toBe("/tmp");
  });

  it("resolves . in paths", () => {
    // /tmp/. resolves to /tmp, which exists
    const result = normalizeDirectory("/tmp/.");
    expect(result).toBe("/tmp");
  });

  it("throws for non-existent directory", () => {
    expect(() => normalizeDirectory("/this/path/absolutely/does/not/exist/xyz123"))
      .toThrow("does not exist");
  });

  it("accepts a known existing directory", () => {
    // /tmp always exists on Linux
    const result = normalizeDirectory("/tmp");
    expect(result).toBe("/tmp");
  });
});

// ─── diagnoseError (via toolError) ───────────────────────────────────────

describe("toolError diagnoseError enhancements", () => {
  it("suggests OPENCODE_BASE_URL check for ECONNREFUSED", () => {
    const result = toolError(new Error("fetch failed: ECONNREFUSED 127.0.0.1:4096"));
    const text = result.content[0].text;
    expect(text).toContain("OPENCODE_BASE_URL");
    expect(text).toContain("auto-reconnect");
  });

  it("suggests network check for ENOTFOUND", () => {
    const result = toolError(new Error("getaddrinfo ENOTFOUND some-host"));
    const text = result.content[0].text;
    expect(text).toContain("Cannot reach");
    expect(text).toContain("OPENCODE_BASE_URL");
  });

  it("suggests network check for EHOSTUNREACH", () => {
    const result = toolError(new Error("connect EHOSTUNREACH 192.168.1.100"));
    const text = result.content[0].text;
    expect(text).toContain("Cannot reach");
  });

  it("suggests retry for ETIMEDOUT", () => {
    const result = toolError(new Error("connect ETIMEDOUT 10.0.0.1:4096"));
    const text = result.content[0].text;
    expect(text).toContain("not responding");
    expect(text).toContain("retry");
  });

  it("suggests opencode_run for timeout errors", () => {
    const result = toolError(new Error("Request timed out after 120s"));
    const text = result.content[0].text;
    expect(text).toContain("opencode_run");
  });

  it("suggests absolute path for directory validation errors", () => {
    const result = toolError(new Error("Invalid directory: \"./foo\" is not an absolute path"));
    const text = result.content[0].text;
    expect(text).toContain("absolute path");
    expect(text).toContain("/home/user/my-project");
  });

  it("suggests absolute path for directory not found errors", () => {
    const result = toolError(new Error("Directory not found: \"/bad/path\" does not exist"));
    const text = result.content[0].text;
    expect(text).toContain("absolute path");
  });
});
