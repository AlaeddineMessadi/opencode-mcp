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
  const client = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn() };
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

describe("provider and configuration contracts", () => {
  it("sanitizes resource and config-update output, including short passwords", async () => {
    const { resources, client, call } = capture();
    const config = { provider: { example: { options: { apiKey: "synthetic-private-credential", password: "tiny" } } } };
    client.get.mockResolvedValue(config);
    client.patch.mockResolvedValue(config);
    for (const name of ["config", "providers"]) {
      const result = await resources.get(name)!.handler();
      expect(result.contents[0].text).not.toContain("synthetic-private-credential");
      expect(result.contents[0].text).not.toContain('"tiny"');
    }
    const result = await call("opencode_config_update", { config: { theme: "dark" } });
    expect(result.structuredContent.data).toEqual(redactSecrets(config));
    expect(JSON.stringify(result)).not.toContain('"tiny"');
  });

  it("sends OAuth method and additional inputs, and validates the callback", async () => {
    const { client, call } = capture();
    client.post.mockResolvedValue({ url: "https://example.invalid/authorize", method: "code" });
    await call("opencode_provider_oauth_authorize", { providerId: "example", method: 2, inputs: { organization: "test" } });
    expect(client.post).toHaveBeenLastCalledWith("/provider/example/oauth/authorize", { method: 2, inputs: { organization: "test" } });
    await call("opencode_provider_oauth_authorize", { providerId: "example" });
    expect(client.post).toHaveBeenLastCalledWith("/provider/example/oauth/authorize", { method: 0 });
    await call("opencode_provider_oauth_callback", { providerId: "example", callbackData: { method: 2, code: "synthetic-code" } });
    expect(client.post).toHaveBeenLastCalledWith("/provider/example/oauth/callback", { method: 2, code: "synthetic-code" });
    expect(() => call("opencode_provider_oauth_callback", { providerId: "example", callbackData: { method: -1 } })).toThrow();
  });

  it("includes method indices and input metadata in discovery", async () => {
    const { client, call } = capture();
    const data = { example: [{ type: "oauth", label: "Personal", prompts: [{ key: "organization", type: "text" }] }] };
    client.get.mockResolvedValue(data);
    const result = await call("opencode_provider_auth_methods", {});
    expect(result.content[0].text).toContain("[0] oauth (Personal)");
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
    expect(analyzeMessageResponse({ parts: [{ type: "text", text: "Fixed the error in validation." }] }).hasError).toBe(false);
    expect(analyzeMessageResponse({ info: { error: { name: "APIError", data: { message: "Unavailable" } } }, parts: [] }).hasError).toBe(true);
    expect(analyzeMessageResponse({ parts: [{ type: "tool", state: { status: "error", error: "Compiler failed" } }] }).hasError).toBe(true);
    expect(toolResult("summary", false, { data: [1] }).structuredContent).toEqual({ data: [1] });
    const structured = { info: { structured: { answer: 42 } }, parts: [] };
    expect(analyzeMessageResponse(structured)).toEqual({ isEmpty: false, hasError: false, warning: null });
    expect(JSON.parse(formatMessageResponse(structured))).toEqual({ answer: 42 });
  });

  it("returns navigable SDK symbol locations and preserves structured source data", async () => {
    const { client, call } = capture();
    const data = [{ name: "example", kind: 12, location: { uri: "file:///project/example.ts", range: { start: { line: 0, character: 0 } } } }];
    client.get.mockResolvedValue(data);
    const result = await call("opencode_find_symbol", { query: "example" });
    expect(result.content[0].text).toContain("file:///project/example.ts:1");
    expect(result.content[0].text).not.toContain("[object Object]");
    expect(result.structuredContent.data).toEqual(data);
  });

  it("returns session creation IDs as structured data", async () => {
    const { client, call } = capture();
    const session = { id: "ses_example", title: "Example" };
    client.post.mockResolvedValue(session);
    expect((await call("opencode_session_create", {})).structuredContent).toEqual({ sessionId: session.id, session });
  });

  it("forwards supported prompt format for sync and async messages", async () => {
    const { client, call, tools } = capture();
    const format = { type: "json_schema", schema: { type: "object" }, retryCount: 1 };
    client.post.mockResolvedValue({ info: { id: "msg_example" }, parts: [{ type: "text", text: "{}" }] });
    await call("opencode_message_send", { sessionId: "ses_example", text: "Test", format });
    expect(client.post.mock.lastCall?.[1]).toMatchObject({ format });
    const asynchronous = await call("opencode_message_send_async", { sessionId: "ses_example", text: "Test", format });
    expect(client.post.mock.lastCall?.[1]).toMatchObject({ format });
    expect(asynchronous.structuredContent.data.messageId).toMatch(/^msg_[a-f0-9]{26}$/);
    expect(client.post.mock.lastCall?.[1].messageID).toBe(asynchronous.structuredContent.data.messageId);
    expect(tools.get("opencode_shell_execute")!.schema).not.toHaveProperty("format");
  });
});

describe("project-scoped resource contracts", () => {
  it.each(["/srv/project with spaces", "C:\\work\\project", "/srv/100%ready"])("reads server directory %s without local resolution", async (directory) => {
    const { resources, client } = capture();
    client.get.mockResolvedValue({ id: "project" });
    const resource = resources.get("project-scoped")!;
    const uri = new URL(`opencode://projects/${encodeURIComponent(directory)}/current`);
    const variables = (resource.uri as ResourceTemplate).uriTemplate.match(uri.href)!;
    const result = await resource.handler(uri, variables);
    expect(client.get).toHaveBeenLastCalledWith("/project/current", undefined, directory);
    expect(result.contents[0].uri).toBe(uri.href);
  });

  it("reads a specific scoped session and transcript", async () => {
    const { resources, client } = capture();
    client.get.mockResolvedValue([]);
    for (const [name, suffix, endpoint] of [["session-scoped", "", ""], ["session-messages-scoped", "/messages", "/message"]]) {
      const resource = resources.get(name)!;
      const uri = new URL(`opencode://projects/%2Fsrv%2Fproject/sessions/ses_example${suffix}`);
      await resource.handler(uri, (resource.uri as ResourceTemplate).uriTemplate.match(uri.href)!);
      expect(client.get).toHaveBeenLastCalledWith(`/session/ses_example${endpoint}`, undefined, "/srv/project");
    }
  });
});
