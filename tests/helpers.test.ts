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

// ─── OpenCode 2.x message fixtures ───────────────────────────────────────
// Shapes follow components/schemas Session.Message.{User,Assistant,Idle} and
// Session.Message.Assistant.Tool / ToolState.* from the 2.x OpenAPI spec.

const tok = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

function userMsg(id: string, text: string, created = 1) {
  return { id, time: { created }, type: "user", text };
}

function assistantMsg(content: unknown[], extra: Record<string, unknown> = {}) {
  return { id: "msg_a", time: { created: 2 }, type: "assistant", content, ...extra };
}

function toolPart(name: string, state: Record<string, unknown>, id = `call_${name}`) {
  return { type: "tool", id, name, state, time: { created: 1 } };
}

const completed = (input: Record<string, unknown>, text?: string) => ({
  status: "completed",
  input,
  content: [{ type: "text", text: text ?? "ok" }],
});

const failed = (input: Record<string, unknown>, message: string) => ({
  status: "error",
  input,
  error: { type: "ToolError", message },
});

// ─── formatMessageResponse ───────────────────────────────────────────────

describe("formatMessageResponse", () => {
  it("returns empty string for null/undefined input", () => {
    expect(formatMessageResponse(null)).toBe("");
    expect(formatMessageResponse(undefined)).toBe("");
  });

  it("omits verbose message header for cleaner output", () => {
    // No header is emitted — an assistant message with no content renders empty
    expect(formatMessageResponse(assistantMsg([]))).toBe("");
  });

  it("extracts text content items", () => {
    const result = formatMessageResponse(assistantMsg([
      { type: "text", text: "Hello world" },
      { type: "text", text: "Second part" },
    ]));
    expect(result).toContain("Hello world");
    expect(result).toContain("Second part");
  });

  it("omits reasoning content from user-facing output", () => {
    const result = formatMessageResponse(assistantMsg([
      { type: "reasoning", text: "internal chain of thought" },
      { type: "text", text: "Final answer" },
    ]));
    expect(result).toBe("Final answer");
    expect(result).not.toContain("chain of thought");
  });

  it("formats running tool parts with their status", () => {
    const result = formatMessageResponse(assistantMsg([
      toolPart("read", { status: "running", input: { path: "/foo" }, metadata: {} }),
    ]));
    expect(result).toBe("[Tool: read] running");
  });

  it("formats completed tool parts with their text content", () => {
    const result = formatMessageResponse(assistantMsg([
      toolPart("read", completed({ path: "/foo" }, "file contents here")),
    ]));
    expect(result).toContain("[Tool: read]");
    expect(result).toContain("file contents here");
  });

  it("truncates long completed tool content to 300 chars", () => {
    const result = formatMessageResponse(assistantMsg([
      toolPart("read", completed({ path: "/foo" }, "x".repeat(1000))),
    ]));
    expect(result).toBe(`[Tool: read] ${"x".repeat(297)}...`);
  });

  it("formats tool errors using the structured error message", () => {
    const result = formatMessageResponse(assistantMsg([
      toolPart("read", failed({ path: "/foo" }, "File not found")),
    ]));
    expect(result).toContain("[Tool: read] ERROR: File not found");
  });

  it("skips unknown content types without text", () => {
    const result = formatMessageResponse(assistantMsg([
      { type: "custom-type", data: "something" },
      { type: "text", text: "visible" },
    ]));
    expect(result).toBe("visible");
  });

  it("formats user messages by their text", () => {
    expect(formatMessageResponse(userMsg("msg_u", "Hi there"))).toBe("Hi there");
  });

  it("formats idle markers with their outcome", () => {
    expect(formatMessageResponse({ id: "msg_i", time: { created: 3 }, type: "idle", outcome: "succeeded" }))
      .toBe("Run succeeded.");
    expect(formatMessageResponse({
      id: "msg_i", time: { created: 3 }, type: "idle", outcome: "failed",
      error: { type: "ProviderError", message: "boom" },
    })).toContain("Run failed:");
  });

  it("surfaces the assistant error when there is no content", () => {
    const result = formatMessageResponse(assistantMsg([], {
      finish: "error",
      error: { type: "ProviderAuthError", message: "Invalid API key", status: 401 },
    }));
    expect(result).toBe("Error: Invalid API key");
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

  it("formats a list of messages with type tags and ids", () => {
    const messages = [
      userMsg("m1", "Hi there", 1),
      { ...assistantMsg([{ type: "text", text: "Hello!" }]), id: "m2" },
    ];
    const result = formatMessageList(messages);
    expect(result).toContain(`--- [user] (m1) ${new Date(1).toISOString()} ---`);
    expect(result).toContain("--- [assistant] (m2)");
    expect(result).toContain("Hi there");
    expect(result).toContain("Hello!");
  });

  it("orders messages chronologically regardless of input order", () => {
    const messages = [
      { id: "m3", time: { created: 30 }, type: "idle", outcome: "succeeded" },
      { ...assistantMsg([{ type: "text", text: "Answer" }]), id: "m2", time: { created: 20 } },
      userMsg("m1", "Question", 10),
    ];
    const result = formatMessageList(messages);
    expect(result.indexOf("Question")).toBeLessThan(result.indexOf("Answer"));
    expect(result.indexOf("Answer")).toBeLessThan(result.indexOf("[idle] (m3)"));
    expect(result).toContain("Run succeeded.");
  });

  it("includes the assistant model when present", () => {
    const result = formatMessageList([
      assistantMsg([{ type: "text", text: "Hi" }], { model: { providerID: "anthropic", id: "claude-x" } }),
    ]);
    expect(result).toContain("model: anthropic/claude-x");
  });

  it("counts tool calls when text is also present", () => {
    const result = formatMessageList([
      assistantMsg([
        { type: "text", text: "Let me check" },
        toolPart("grep", completed({ pattern: "x" }), "c1"),
        toolPart("grep", completed({ pattern: "y" }), "c2"),
      ]),
    ]);
    expect(result).toContain("2 tool call(s)");
    expect(result).toContain("Let me check");
  });

  it("shows tool summaries when text is empty (the empty-message bug)", () => {
    const result = formatMessageList([
      assistantMsg([
        { type: "text", text: "" },
        toolPart("write", completed({ path: "/src/App.tsx" }), "c1"),
        toolPart("read", completed({ path: "/src/main.tsx" }), "c2"),
      ]),
    ]);
    expect(result).toContain("Agent performed 2 action(s)");
    expect(result).toContain("write: /src/App.tsx");
  });

  it("shows tool summaries when there are no text parts at all", () => {
    const result = formatMessageList([
      assistantMsg([toolPart("bash", completed({ command: "npm install" }))]),
    ]);
    expect(result).toContain("Agent performed 1 action(s)");
    expect(result).toContain("bash: npm install");
  });

  it("shows (no content) when content array is empty", () => {
    expect(formatMessageList([assistantMsg([])])).toContain("(no content)");
  });

  it("truncates long tool input hints to 80 chars", () => {
    const longPath = "/very/long/path/that/goes/on/and/on/and/on/and/repeats/many/times/so/it/exceeds/eighty/chars.tsx";
    const result = formatMessageList([
      assistantMsg([toolPart("write", completed({ path: longPath }))]),
    ]);
    expect(result).toContain("...");
    expect(result.length).toBeLessThan(longPath.length + 200);
  });

  it("caps tool summaries at 10 and shows overflow count", () => {
    const parts = Array.from({ length: 15 }, (_, i) =>
      toolPart(`Tool${i}`, completed({ path: `/file${i}.ts` })),
    );
    const result = formatMessageList([assistantMsg(parts)]);
    expect(result).toContain("Agent performed 15 action(s)");
    expect(result).toContain("... and 5 more");
    expect(result).toContain("Tool0");
    expect(result).toContain("Tool9");
    expect(result).not.toContain("Tool10:");
  });

  it("marks tool errors in summaries", () => {
    const result = formatMessageList([
      assistantMsg([toolPart("bash", failed({ command: "foo" }, "command not found"))]),
    ]);
    expect(result).toContain("bash: foo ERROR");
  });

  it("appends cost and token metadata from the assistant message", () => {
    const result = formatMessageList([
      assistantMsg([{ type: "text", text: "Done!" }], {
        cost: 0.0023,
        tokens: { input: 1500, output: 200, reasoning: 0, cache: { read: 100, write: 20 } },
      }),
    ]);
    expect(result).toContain("cost: $0.0023");
    expect(result).toContain("tokens: 1500 in, 200 out, 120 cache");
  });

  it("omits cost metadata when cost and tokens are zero", () => {
    const result = formatMessageList([
      assistantMsg([{ type: "text", text: "Done!" }], { cost: 0, tokens: tok }),
    ]);
    expect(result).not.toContain("cost:");
    expect(result).not.toContain("tokens:");
  });

  it("prefers command/query/url hints from tool input", () => {
    const result = formatMessageList([
      assistantMsg([
        toolPart("websearch", completed({ query: "todo context" }), "c1"),
        toolPart("webfetch", completed({ url: "https://example.com" }), "c2"),
      ]),
    ]);
    expect(result).toContain("websearch: todo context");
    expect(result).toContain("webfetch: https://example.com");
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

  it("formats sessions with title, id, and created time", () => {
    const created = Date.UTC(2025, 0, 1);
    const sessions = [
      { id: "s1", title: "Fix bug", time: { created, updated: created } },
      { id: "s2", title: "Add feature", time: { created: created + 1, updated: created + 1 } },
    ];
    const result = formatSessionList(sessions);
    expect(result).toContain("Fix bug [s1]");
    expect(result).toContain("Add feature [s2]");
    expect(result).toContain("created 2025-01-01T00:00:00.000Z");
  });

  it("shows the last run outcome", () => {
    const result = formatSessionList([{ id: "s1", title: "Done", outcome: "failed" }]);
    expect(result).toBe("- Done [s1] [failed]");
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

  it("detects response with empty content array as empty", () => {
    const result = analyzeMessageResponse(assistantMsg([]));
    expect(result.isEmpty).toBe(true);
    expect(result.warning).toContain("no text content");
  });

  it("detects response with only whitespace text as empty", () => {
    const result = analyzeMessageResponse(assistantMsg([{ type: "text", text: "   " }]));
    expect(result.isEmpty).toBe(true);
    expect(result.warning).toContain("no text content");
  });

  it("detects reasoning-only responses as empty", () => {
    const result = analyzeMessageResponse(assistantMsg([{ type: "reasoning", text: "thinking" }]));
    expect(result.isEmpty).toBe(true);
  });

  it("recognizes tool-only activity", () => {
    const result = analyzeMessageResponse(assistantMsg([
      toolPart("bash", { status: "running", input: { command: "ls" }, metadata: {} }),
    ]));
    expect(result.isEmpty).toBe(false);
    expect(result.warning).toBeNull();
  });

  it("detects the assistant-level structured error", () => {
    const result = analyzeMessageResponse(assistantMsg([], {
      finish: "error",
      error: { type: "ProviderAuthError", message: "Unauthorized", status: 401 },
    }));
    expect(result.hasError).toBe(true);
    expect(result.isEmpty).toBe(false);
    expect(result.warning).toContain("Unauthorized");
    expect(result.warning).not.toContain("verify your API key");
  });

  it("detects failed idle markers", () => {
    const result = analyzeMessageResponse({
      id: "msg_i", time: { created: 3 }, type: "idle", outcome: "failed",
      error: { type: "ProviderError", message: "overloaded" },
    });
    expect(result.hasError).toBe(true);
    expect(result.warning).toContain("overloaded");
  });

  it("does not treat succeeded idle markers as errors", () => {
    const result = analyzeMessageResponse({ id: "msg_i", time: { created: 3 }, type: "idle", outcome: "succeeded" });
    expect(result.hasError).toBe(false);
  });

  it("does not treat error keywords in prose as tool failure", () => {
    const result = analyzeMessageResponse(assistantMsg([{ type: "text", text: "Error: invalid key provided" }]));
    expect(result.hasError).toBe(false);
    expect(result.warning).toBeNull();
  });

  it("preserves explanations of unauthorized requests as content", () => {
    const result = analyzeMessageResponse(assistantMsg([{ type: "text", text: "Request unauthorized by provider" }]));
    expect(result.hasError).toBe(false);
  });

  it("returns no warning for valid response with text", () => {
    const result = analyzeMessageResponse(assistantMsg([{ type: "text", text: "Hello, world!" }]));
    expect(result.isEmpty).toBe(false);
    expect(result.hasError).toBe(false);
    expect(result.warning).toBeNull();
  });

  it("returns no warning for response with mixed content including text", () => {
    const result = analyzeMessageResponse(assistantMsg([
      { type: "text", text: "Let me check that." },
      toolPart("read", completed({ path: "/foo" })),
    ]));
    expect(result.isEmpty).toBe(false);
    expect(result.hasError).toBe(false);
    expect(result.warning).toBeNull();
  });

  it("handles response with no content field", () => {
    const result = analyzeMessageResponse({ id: "m1", time: { created: 1 }, type: "assistant" });
    expect(result.isEmpty).toBe(true);
    expect(result.warning).toContain("no text content");
  });

  it("treats user messages with text as non-empty", () => {
    expect(analyzeMessageResponse(userMsg("m1", "hi")).isEmpty).toBe(false);
  });
});

// ─── isProviderConfigured ─────────────────────────────────────────────────

describe("isProviderConfigured", () => {
  const provider = (id: string, extra: Record<string, unknown> = {}) => ({
    id, name: id, activation: "auto", package: "@ai-sdk/openai-compatible", ...extra,
  });
  const credential = (integrationID: string, active: boolean) => ({
    id: `cred_${integrationID}`, integrationID, label: "default", active, value: { type: "key", key: "x" },
  });

  it("returns true when provider settings carry a non-empty apiKey", () => {
    expect(isProviderConfigured(provider("opencode", { settings: { apiKey: "public" } }))).toBe(true);
  });

  it("returns false when provider settings have an empty apiKey", () => {
    expect(isProviderConfigured(provider("deepseek", { settings: { apiKey: "" } }))).toBe(false);
  });

  it("returns false with no settings and no credentials", () => {
    expect(isProviderConfigured(provider("groq"))).toBe(false);
  });

  it("returns true when an active credential matches the integrationID", () => {
    expect(isProviderConfigured(
      provider("anthropic", { integrationID: "anthropic-oauth" }),
      [credential("anthropic-oauth", true)],
    )).toBe(true);
  });

  it("returns true when an active credential matches the provider id", () => {
    expect(isProviderConfigured(provider("google"), [credential("google", true)])).toBe(true);
  });

  it("returns false when the matching credential is inactive", () => {
    expect(isProviderConfigured(provider("google"), [credential("google", false)])).toBe(false);
  });

  it("returns false when credentials belong to another integration", () => {
    expect(isProviderConfigured(provider("openai"), [credential("anthropic", true)])).toBe(false);
  });

  it("returns false when the provider has no id", () => {
    expect(isProviderConfigured({}, [credential("unknown", true)])).toBe(false);
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

  it("fully redacts short credentials without exposing a prefix", () => {
    const result = redactSecrets({ api_key: "short" }) as Record<string, unknown>;
    expect(result.api_key).toBe("***REDACTED***");
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
    expect(result.length).toBeLessThanOrEqual(100);
    expect(JSON.parse(result)).toMatchObject({ truncated: true, originalLength: JSON.stringify(big, null, 2).length });
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
    expect(result.content[0].text).toContain("opencode_provider_models");
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

  it("preserves trailing slashes", () => {
    const result = normalizeDirectory("/tmp/");
    expect(result).toBe("/tmp/");
  });

  it("preserves .. for server-side symlink resolution", () => {
    const result = normalizeDirectory("/tmp/foo/..");
    expect(result).toBe("/tmp/foo/..");
  });

  it("preserves . for server-side resolution", () => {
    // /tmp/. resolves to /tmp, which exists
    const result = normalizeDirectory("/tmp/.");
    expect(result).toBe("/tmp/.");
  });

  it("accepts directories that only exist on the server", () => {
    expect(normalizeDirectory("/this/path/absolutely/does/not/exist/xyz123"))
      .toBe("/this/path/absolutely/does/not/exist/xyz123");
  });

  it("accepts a known existing directory", () => {
    // /tmp always exists on Linux
    const result = normalizeDirectory("/tmp");
    expect(result).toBe("/tmp");
  });

  it("accepts the process working directory on any platform", () => {
    // Platform-agnostic regression: process.cwd() is always absolute for the
    // current platform, so normalizeDirectory must accept it regardless of OS.
    const result = normalizeDirectory(process.cwd());
    expect(result).toBeDefined();
  });

  // Regression for Windows drive-letter paths.
  // Before the fix, normalizeDirectory required the resolved path to start
  // with "/", which meant Windows absolute paths like "C:\\Users\\..." were
  // rejected. The fix switches to the platform-aware `path.isAbsolute`, so
  // this test guards the Windows path on a Windows CI runner.
  it.runIf(process.platform === "win32")(
    "accepts Windows drive-letter absolute paths",
    () => {
      const cwd = process.cwd(); // e.g. "C:\\Users\\runner\\work\\..."
      expect(cwd).toMatch(/^[A-Za-z]:\\/);
      const result = normalizeDirectory(cwd);
      expect(result).toBeDefined();
      expect(result).toMatch(/^[A-Za-z]:\\/);
    },
  );

  // Regression: header-injection defense.
  // `x-opencode-directory` is forwarded verbatim to the OpenCode server.
  // Node's `undici` rejects CR/LF in header values, but `normalizeDirectory`
  // guards explicitly so the contract is independent of the runtime.
  it.each([
    ["NUL byte", "/tmp\0/x"],
    ["CR", "/tmp\rfoo"],
    ["LF", "/tmp\nfoo"],
    ["CRLF", "/tmp\r\nfoo"],
  ])("rejects paths containing %s", (_label, badPath) => {
    expect(() => normalizeDirectory(badPath)).toThrow(/NUL or CR\/LF/);
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


describe("Issue #13: cross-platform server paths", () => {
  it.each([
    "/mnt/d/Projects/opencode-agent", "/remote/project", "C:\\Users\\me\\project",
    "D:/Projects/app", "\\\\server\\share\\project",
  ])("preserves %s on every client OS", (directory) => {
    expect(normalizeDirectory(directory)).toBe(directory);
  });
  it.each(["./project", "../project", "~/project", "project", "C:project", "\\project"])("rejects ambiguous path %s", (directory) => {
    expect(() => normalizeDirectory(directory)).toThrow("not an absolute path");
  });
});


describe("OpenCode 2.x response formats", () => {
  const message = assistantMsg([
    toolPart("bash", completed({ command: "pwd" }, "/project")),
  ]);
  it("formats completed tool parts and does not misdiagnose them as missing credentials", () => {
    expect(formatMessageResponse(message)).toContain("[Tool: bash] /project");
    expect(formatMessageList([message])).toContain("bash: pwd");
    expect(analyzeMessageResponse(message)).toEqual({ isEmpty: false, hasError: false, warning: null });
  });
  it("reports structured errors nested in tool state", () => {
    const failedMsg = assistantMsg([toolPart("bash", failed({ command: "x" }, "command failed"))]);
    expect(formatMessageResponse(failedMsg)).toContain("ERROR: command failed");
    const analysis = analyzeMessageResponse(failedMsg);
    expect(analysis.hasError).toBe(true);
    expect(analysis.warning).toContain("command failed");
  });
  it("includes the current patch field when formatting session diffs", () => {
    expect(formatDiffResponse([{ file: "app.ts", patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1 }])).toContain("+new");
  });
});
