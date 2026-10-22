import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { McpServer, ResourceTemplate } from "../src/mcp-server.js";
import { OpenCodeClient } from "../src/client.js";
import { registerResources } from "../src/resources.js";
import { registerConfigTools } from "../src/tools/config.js";
import { registerFileTools } from "../src/tools/file.js";
import { registerProviderTools } from "../src/tools/provider.js";
import { registerMessageTools } from "../src/tools/message.js";
import { registerSessionTools } from "../src/tools/session.js";
import { analyzeMessageResponse, formatMessageResponse, redactSecrets, safeStringify, toolJson, toolResult } from "../src/helpers.js";

function capture() {
  const tools = new Map<string, { schema: z.ZodRawShape; handler: Function }>();
  const resources = new Map<string, { uri: string | ResourceTemplate; handler: Function }>();
  const server = {
    tool: (name: string, _description: string, schema: z.ZodRawShape, ...rest: unknown[]) => {
      tools.set(name, { schema, handler: rest.at(-1) as Function });
    },
    resource: (name: string, uri: string | ResourceTemplate, _options: unknown, handler: Function) => {
      resources.set(name, { uri, handler });
    },
  } as unknown as McpServer;
  const client = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() };
  for (const register of [registerConfigTools, registerFileTools, registerProviderTools, registerMessageTools, registerSessionTools]) {
    register(server, client as unknown as OpenCodeClient);
  }
  registerResources(server, client as unknown as OpenCodeClient);
  const call = (name: string, input: unknown) => {
    const tool = tools.get(name)!;
    return tool.handler(z.object(tool.schema).parse(input));
  };
  return { tools, resources, client, call };
}

// OpenCode 2.x flat messages (after envelope unwrapping).
const user = (id: string, created: number) => ({ id, type: "user", text: "Test", time: { created } });
const assistant = (id: string, created: number, text: string) => ({
  id, type: "assistant", agent: "build", model: { id: "model", providerID: "provider" },
  time: { created, completed: created }, content: [{ type: "text", text }], finish: "stop",
});
const idle = (id: string, created: number, outcome: string, extra: Record<string, unknown> = {}) => ({ id, type: "idle", outcome, time: { created }, ...extra });
const inboxUser = (id: string, created: number) => ({ id, sessionID: "ses_example", type: "user", time: { created }, payload: { text: "Test" }, delivery: "queue" });

describe("provider and configuration contracts", () => {
  it("sanitizes config and provider resources, including short passwords", async () => {
    const { resources, client } = capture();
    // GET /api/config: layered config documents; GET /api/provider: Provider.Info list.
    const config = [{ type: "document", path: "/home/user/.config/opencode/opencode.json",
      info: { providers: { example: { settings: { apiKey: "synthetic-private-credential", password: "tiny" } } } } }];
    const providers = [{ id: "example", name: "Example", activation: "enabled", package: "@opencode/ai/providers/openai-compatible",
      settings: { apiKey: "synthetic-private-credential", password: "tiny", baseURL: "https://example.invalid/v1" } }];
    client.get.mockImplementation(async (path: string) => path === "/api/config" ? config : providers);
    for (const name of ["config", "providers"]) {
      const result = await resources.get(name)!.handler();
      expect(result.contents[0].text).not.toContain("synthetic-private-credential");
      expect(result.contents[0].text).not.toContain('"tiny"');
    }
    expect(client.get.mock.calls.map(([path]) => path)).toEqual(["/api/config", "/api/provider"]);
  });

  it("patches the experimental config endpoint and redacts any echoed secrets", async () => {
    const { client, call } = capture();
    // 2.1.2 answers 204 (Config.Patch accepts `shell`); tolerate a body but never leak secrets from it.
    client.patch.mockResolvedValueOnce(undefined);
    const result = await call("opencode_config_update", { config: { shell: "/bin/zsh" }, directory: "/srv/project" });
    expect(client.patch).toHaveBeenLastCalledWith("/api/experimental/config", { shell: "/bin/zsh" }, "/srv/project");
    expect(result.isError).toBeUndefined();
    const echoed = { shell: "/bin/zsh", password: "tiny" };
    client.patch.mockResolvedValueOnce(echoed);
    const redacted = await call("opencode_config_update", { config: { shell: "/bin/zsh" } });
    expect(redacted.structuredContent.data).toEqual(redactSecrets(echoed));
    expect(JSON.stringify(redacted)).not.toContain('"tiny"');
  });

  it("starts integration OAuth with an explicit method and completes it with the attempt code", async () => {
    const { client, call } = capture();
    client.post.mockResolvedValue({ attemptID: "att_1", url: "https://example.invalid/authorize", instructions: "Open the URL", mode: "code", time: { created: 1, expires: 2 } });
    const started = await call("opencode_provider_oauth_authorize", { providerId: "example", methodID: "browser" });
    expect(client.post).toHaveBeenLastCalledWith("/api/integration/example/connect/oauth", { methodID: "browser" });
    expect(started.structuredContent.data).toMatchObject({ attemptID: "att_1", mode: "code" });
    client.post.mockResolvedValue(undefined);
    await call("opencode_provider_oauth_callback", { providerId: "example", attemptID: "att_1", code: "synthetic-code" });
    expect(client.post).toHaveBeenLastCalledWith("/api/integration/example/connect/oauth/att_1/complete", { code: "synthetic-code" });
    await call("opencode_provider_oauth_callback", { providerId: "example", attemptID: "att_1" });
    expect(client.post).toHaveBeenLastCalledWith("/api/integration/example/connect/oauth/att_1/complete", {});
    expect(() => call("opencode_provider_oauth_callback", { providerId: "example" })).toThrow();
  });

  it("defaults OAuth to the integration's first oauth method", async () => {
    const { client, call } = capture();
    client.get.mockResolvedValue([{ id: "example", name: "Example", methods: [{ type: "key" }, { id: "browser", type: "oauth", label: "Login" }], connections: [] }]);
    client.post.mockResolvedValue({ attemptID: "att_1", url: "https://example.invalid/authorize", instructions: "", mode: "auto", time: { created: 1, expires: 2 } });
    await call("opencode_provider_oauth_authorize", { providerId: "example" });
    expect(client.post).toHaveBeenLastCalledWith("/api/integration/example/connect/oauth", { methodID: "browser" });
  });

  it("lists integration connection methods and preserves the raw method IDs", async () => {
    const { client, call } = capture();
    const data = [
      { id: "digitalocean", name: "DigitalOcean", connections: [],
        methods: [{ type: "key" }, { type: "env", names: ["DIGITALOCEAN_ACCESS_TOKEN"] }, { id: "browser", type: "oauth", label: "Login with DigitalOcean" }] },
      { id: "example", name: "Example", connections: [{ id: "conn_1" }], methods: [{ id: "personal", type: "oauth", label: "Personal" }] },
    ];
    client.get.mockResolvedValue(data);
    const result = await call("opencode_provider_auth_methods", {});
    expect(client.get).toHaveBeenLastCalledWith("/api/integration", undefined, undefined);
    expect(result.content[0].text).toContain("- digitalocean: key, env(DIGITALOCEAN_ACCESS_TOKEN), oauth");
    expect(result.content[0].text).toContain("- example: oauth (1 connection(s))");
    expect(result.structuredContent.data).toEqual(data);
  });
});

describe("machine-readable response contracts", () => {
  it("keeps large resource JSON valid and within budget, including escaped text", () => {
    const value = { data: '\n"\\'.repeat(20000) };
    for (const budget of [32, 100, 50000]) {
      const result = safeStringify(value, budget);
      expect(result.length).toBeLessThanOrEqual(budget);
      expect(JSON.parse(result).truncated).toBe(true);
    }
    expect(safeStringify(undefined)).toBe("null");
    expect(toolJson(value).structuredContent?.data).toMatchObject({ truncated: true });
  });

  it("recognizes typed errors without marking normal debugging prose as failure", () => {
    expect(analyzeMessageResponse(assistant("msg_a", 1, "Fixed the error in validation.")).hasError).toBe(false);
    expect(analyzeMessageResponse({ ...assistant("msg_a", 1, ""), content: [], error: { type: "APIError", message: "Unavailable" } }).hasError).toBe(true);
    expect(analyzeMessageResponse({ ...assistant("msg_a", 1, ""), content: [
      { type: "tool", id: "call_1", name: "shell", state: { status: "error", input: {}, error: { type: "ToolError", message: "Compiler failed" } } },
    ] }).hasError).toBe(true);
    expect(analyzeMessageResponse(idle("msg_i", 2, "failed", { error: { type: "ProviderError", message: "Down" } })).hasError).toBe(true);
    expect(analyzeMessageResponse(idle("msg_i", 2, "succeeded")).hasError).toBe(false);
    expect(toolResult("summary", false, { data: [1] }).structuredContent).toEqual({ data: [1] });
  });

  it("formats assistant text and tool results while omitting reasoning", () => {
    const text = formatMessageResponse({ ...assistant("msg_a", 1, "Done"), content: [
      { type: "reasoning", text: "private chain of thought" },
      { type: "tool", id: "call_1", name: "shell", state: { status: "completed", input: {}, content: [{ type: "text", text: "exit 0" }] } },
      { type: "text", text: '{"answer":42}' },
    ] });
    expect(text).toContain("[Tool: shell] exit 0");
    expect(text).toContain('{"answer":42}');
    expect(text).not.toContain("private chain of thought");
  });

  it("returns navigable file-search entries and preserves structured source data", async () => {
    const { client, call } = capture();
    // GET /api/fs/find returns FileSystem.Entry ({ path, type }) items.
    const data = [{ path: "src/example.ts", type: "file" }, { path: "src", type: "directory" }];
    client.get.mockResolvedValue(data);
    const result = await call("opencode_find_file", { query: "example", type: "file", limit: 5, directory: "/project" });
    expect(client.get).toHaveBeenLastCalledWith("/api/fs/find", { query: "example", type: "file", limit: "5" }, "/project");
    expect(result.content[0].text).toContain("src/example.ts");
    expect(result.content[0].text).toContain("[DIR] src");
    expect(result.content[0].text).not.toContain("[object Object]");
    expect(result.structuredContent.data).toEqual(data);
    const text = await call("opencode_find_text", { pattern: "example" });
    expect(client.get).toHaveBeenLastCalledWith("/api/fs/find", { query: "example" }, undefined);
    expect(text.structuredContent.data).toEqual(data);
  });

  it("returns session creation IDs as structured data and binds the location in the body", async () => {
    const { client, call } = capture();
    const session = { id: "ses_example", title: "Example", time: { created: 1, updated: 1 }, location: { directory: "/srv/project" } };
    client.post.mockResolvedValue(session);
    expect((await call("opencode_session_create", { title: "Example", directory: "/srv/project" })).structuredContent).toEqual({ sessionId: session.id, session });
    expect(client.post.mock.lastCall?.[0]).toBe("/api/session");
    expect(client.post.mock.lastCall?.[1]).toEqual({ title: "Example", location: { directory: "/srv/project" } });
  });

  it("submits plain-text prompts and correlates async sends by a pre-assigned message ID", async () => {
    const { client, call, tools } = capture();
    client.post.mockResolvedValue(inboxUser("msg_inbox", 1));
    const asynchronous = await call("opencode_message_send_async", { sessionId: "ses_example", text: "Test" });
    expect(client.post.mock.lastCall?.[0]).toBe("/api/session/ses_example/prompt");
    expect(asynchronous.structuredContent.data.messageId).toMatch(/^msg_[a-f0-9]{26}$/);
    expect(client.post.mock.lastCall?.[1]).toEqual({ id: asynchronous.structuredContent.data.messageId, text: "Test" });
    // OpenCode 2.x has no prompt-level output format.
    for (const name of ["opencode_message_send", "opencode_message_send_async", "opencode_shell_execute"]) {
      expect(tools.get(name)!.schema).not.toHaveProperty("format");
    }
  });

  it("waits for the synchronous turn and returns its own assistant answer", async () => {
    const { client, call } = capture();
    client.post.mockImplementation(async (path: string) => path.endsWith("/prompt") ? inboxUser("msg_new", 4) : undefined);
    // Newest-first, as returned by GET /api/session/{id}/message.
    client.get.mockResolvedValue([idle("msg_i2", 6, "succeeded"), assistant("msg_a2", 5, "New answer"), user("msg_new", 4),
      idle("msg_i1", 3, "succeeded"), assistant("msg_a1", 2, "Old answer"), user("msg_old", 1)]);
    const result = await call("opencode_message_send", { sessionId: "ses_example", text: "Test" });
    expect(client.post.mock.calls.map(([path, body]) => [path, body])).toEqual([
      ["/api/session/ses_example/prompt", { text: "Test" }],
      ["/api/experimental/session/ses_example/wait", undefined],
    ]);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("New answer");
    expect(result.content[0].text).not.toContain("Old answer");
    expect(result.structuredContent.data).toMatchObject({ id: "msg_a2" });
  });

  // Regression: the idle marker must be the one closing this turn, never an
  // older one in the same history window.
  it("judges a synchronous send by its own turn's idle marker, not an older one", async () => {
    const { client, call } = capture();
    client.post.mockImplementation(async (path: string) => path.endsWith("/prompt") ? inboxUser("msg_new", 4) : undefined);
    client.get.mockResolvedValue([idle("msg_i2", 6, "succeeded"), assistant("msg_a2", 5, "New answer"), user("msg_new", 4),
      idle("msg_i1", 3, "failed", { error: { type: "ProviderError", message: "old outage" } }), assistant("msg_a1", 2, "Old answer"), user("msg_old", 1)]);
    const result = await call("opencode_message_send", { sessionId: "ses_example", text: "Test" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).not.toContain("old outage");
  });
});

describe("project-scoped resource contracts", () => {
  it.each(["/srv/project with spaces", "C:\\work\\project", "/srv/100%ready"])("reads server directory %s without local resolution", async (directory) => {
    const { resources, client } = capture();
    client.get.mockResolvedValue({ directory, project: { id: "project" } });
    const resource = resources.get("project-scoped")!;
    const uri = new URL(`opencode://projects/${encodeURIComponent(directory)}/current`);
    const variables = (resource.uri as ResourceTemplate).uriTemplate.match(uri.href)!;
    const result = await resource.handler(uri, variables);
    expect(client.get).toHaveBeenLastCalledWith("/api/location", undefined, directory);
    expect(result.contents[0].uri).toBe(uri.href);
  });

  it("reads a specific scoped session and transcript", async () => {
    const { resources, client } = capture();
    client.get.mockResolvedValue([]);
    for (const [name, suffix, endpoint] of [["session-scoped", "", ""], ["session-messages-scoped", "/messages", "/message"]]) {
      const resource = resources.get(name)!;
      const uri = new URL(`opencode://projects/%2Fsrv%2Fproject/sessions/ses_example${suffix}`);
      await resource.handler(uri, (resource.uri as ResourceTemplate).uriTemplate.match(uri.href)!);
      expect(client.get).toHaveBeenLastCalledWith(`/api/session/ses_example${endpoint}`, undefined, "/srv/project");
    }
  });
});
