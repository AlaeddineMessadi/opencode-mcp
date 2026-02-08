import { describe, it, expect } from "vitest";
import {
  formatMessageResponse,
  formatMessageList,
  formatDiffResponse,
  formatSessionList,
  safeStringify,
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

  it("formats message info section", () => {
    const result = formatMessageResponse({
      info: { id: "msg-1", role: "assistant", createdAt: "2025-01-01" },
      parts: [],
    });
    expect(result).toContain("[assistant]");
    expect(result).toContain("msg-1");
    expect(result).toContain("2025-01-01");
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

  it("handles missing info gracefully", () => {
    const result = formatMessageResponse({
      info: { role: undefined, id: undefined },
      parts: [{ type: "text", text: "hello" }],
    });
    expect(result).toContain("[unknown]");
    expect(result).toContain("?");
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

  it("counts tool calls", () => {
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
    expect(result.content[0].text).toBe("Error: something broke");
    expect(result.isError).toBe(true);
  });

  it("converts non-Error values to string", () => {
    const result = toolError("string error");
    expect(result.content[0].text).toBe("Error: string error");
  });

  it("handles numbers", () => {
    const result = toolError(404);
    expect(result.content[0].text).toBe("Error: 404");
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
