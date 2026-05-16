import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../src/client.js";
import { registerProjectTools } from "../src/tools/project.js";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Behaviour tests for `opencode_project_init`. The migration to the new
 * SDK in PR #11 surfaced a security gap: `pathUtil.resolve()` only
 * canonicalizes `..`/`.` lexically, so a symlink at `/tmp/safe -> /etc`
 * would pass the forbidden-roots check unchecked. These tests guard
 * against regressions on that path and on the other input-validation
 * gates (NUL/CR/LF, system roots, existing files).
 */

interface CapturedTool {
  description: string;
  handler: (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function captureProjectTools(): {
  tools: Map<string, CapturedTool>;
  clientGet: ReturnType<typeof vi.fn>;
} {
  const tools = new Map<string, CapturedTool>();
  const mockServer = {
    tool: vi.fn((...args: unknown[]) => {
      const name = args[0] as string;
      const description = args[1] as string;
      const handler = args[args.length - 1] as CapturedTool["handler"];
      tools.set(name, { description, handler });
    }),
  } as unknown as McpServer;

  const clientGet = vi.fn().mockResolvedValue({});
  const mockClient = {
    get: clientGet,
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    subscribeSSE: vi.fn(),
    getBaseUrl: vi.fn().mockReturnValue("http://localhost:4096"),
  } as unknown as OpenCodeClient;

  registerProjectTools(mockServer, mockClient);
  return { tools, clientGet };
}

describe("opencode_project_init", () => {
  let scratch: string;

  beforeEach(async () => {
    // Realpath the tmp root because /tmp is itself a symlink on macOS and
    // realpath() inside the tool will canonicalize it. Tests assert
    // against the canonical form so they pass on every OS.
    scratch = realpathSync(await mkdtemp(path.join(tmpdir(), "opencode-init-")));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  async function callInit(input: Record<string, unknown>) {
    const { tools } = captureProjectTools();
    const init = tools.get("opencode_project_init");
    if (!init) throw new Error("opencode_project_init not registered");
    return init.handler(input);
  }

  // ── Happy path ──────────────────────────────────────────────────────

  it("creates a new directory and returns the resolved path", async () => {
    const target = path.join(scratch, "new-project");
    const result = await callInit({ path: target });
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain(target);
  });

  it("is idempotent on existing directories", async () => {
    const target = path.join(scratch, "existing");
    await mkdir(target);
    const result = await callInit({ path: target });
    expect(result.isError).not.toBe(true);
  });

  // ── Input validation ────────────────────────────────────────────────

  it.each([
    ["NUL byte", "/tmp\0/x"],
    ["CR", "/tmp\rfoo"],
    ["LF", "/tmp\nfoo"],
    ["CRLF", "/tmp\r\nfoo"],
  ])("rejects paths containing %s", async (_label, badPath) => {
    const result = await callInit({ path: badPath });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/NUL or CR\/LF/);
  });

  it("rejects relative paths", async () => {
    const result = await callInit({ path: "relative/path" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/absolute path/);
  });

  // ── Forbidden roots ────────────────────────────────────────────────

  it.each(["/", "/etc", "/usr", "/bin", "/sbin", "/sys", "/proc", "/dev"])(
    "rejects forbidden root %s",
    async (root) => {
      const result = await callInit({ path: root });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/System directories are not allowed/);
    },
  );

  it("rejects subpaths of forbidden roots (e.g. /etc/foo)", async () => {
    const result = await callInit({ path: "/etc/foo" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/System directories are not allowed/);
  });

  // `/var` is deliberately NOT in the deny-list — macOS user-temp paths
  // live at /var/folders/... and many other /var subtrees are legitimately
  // user-writable. This test guards against re-adding /var by accident.
  it("does NOT reject paths under /var (macOS user temp lives there)", async () => {
    // We don't actually create anything under /var here — the test asserts
    // that the deny-list does not match, not that the rest of the handler
    // succeeds. The handler will fail later (mkdir EACCES on system /var),
    // but the failure must NOT be "System directories are not allowed".
    const result = await callInit({ path: "/var/folders/test-project" });
    if (result.isError) {
      expect(result.content[0].text).not.toMatch(
        /System directories are not allowed/,
      );
    }
  });

  // ── Symlink escape (the security regression this test exists for) ──

  it("rejects symlink targets that point at forbidden roots", async () => {
    // Create a symlink in our scratch dir that points at /etc.
    // Without the realpath check, `pathUtil.resolve` would return the
    // lexical path inside scratch — which passes the forbidden-roots
    // check — and the OpenCode session would be scoped to /etc.
    const link = path.join(scratch, "evil-link");
    await symlink("/etc", link);

    const result = await callInit({ path: link });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(
      /System directories are not allowed.*resolved via symlink/,
    );
  });

  it("accepts a symlink that points at a safe directory", async () => {
    const realTarget = path.join(scratch, "real-target");
    await mkdir(realTarget);
    const link = path.join(scratch, "safe-link");
    await symlink(realTarget, link);

    const result = await callInit({ path: link });
    expect(result.isError).not.toBe(true);
    // The returned path is the canonical (realpath'd) one.
    expect(result.content[0].text).toContain(realTarget);
  });

  // ── Existing-file collision ────────────────────────────────────────

  it("rejects paths that already exist as a regular file", async () => {
    const target = path.join(scratch, "regular-file");
    await writeFile(target, "x");
    const result = await callInit({ path: target });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not a directory/);
  });
});
