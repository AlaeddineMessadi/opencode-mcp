import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/app.js";
import { McpServer } from "../src/mcp-server.js";
import { capabilities } from "../src/backends/capabilities.js";
import { OpenCodeClient } from "../src/client.js";
import type { JobService } from "../src/jobs.js";

afterEach(() => vi.restoreAllMocks());
const jobs = new Proxy({}, { get: () => () => { throw new Error("Unexpected job operation while inspecting catalog"); } }) as JobService;
const client = (kind: "v1" | "v2") => new OpenCodeClient({ baseUrl: "http://fixture.invalid", backend: kind });

describe("public backend capability inventory", () => {
  it("covers every actual tool/resource/template/prompt registration exactly once", () => {
    const actual: Array<{ name: string; kind: string }> = [];
    const resource = vi.spyOn(McpServer.prototype, "resource");
    const prompt = vi.spyOn(McpServer.prototype, "prompt");
    const server = createServer(client("v1"), jobs, "full");
    actual.push(...server.catalog.map(tool => ({ name: tool.name, kind: "tool" })));
    actual.push(...resource.mock.calls.map(([name, uri]) => ({ name, kind: typeof uri === "string" ? "resource" : "template" })));
    actual.push(...prompt.mock.calls.map(([name]) => ({ name, kind: "prompt" })));
    const keys = (items: typeof actual) => items.map(item => `${item.kind}:${item.name}`).sort();
    expect(keys(capabilities)).toEqual(keys(actual));
    expect(new Set(keys(capabilities)).size).toBe(capabilities.length);
    expect(actual.filter(item => item.kind === "tool")).toHaveLength(87);
    expect(actual.filter(item => item.kind === "resource")).toHaveLength(10);
    expect(actual.filter(item => item.kind === "template")).toHaveLength(4);
    expect(actual.filter(item => item.kind === "prompt")).toHaveLength(6);
  });
  it.each(["full", "essential"] as const)("preserves %s tool names, schemas, and annotations across backends", profile => {
    const legacy = createServer(client("v1"), jobs, profile).catalog;
    const modern = createServer(client("v2"), jobs, profile).catalog;
    expect(modern).toEqual(legacy);
    if (profile === "essential") expect(legacy).toHaveLength(25);
  });
  it("distinguishes the upstream command blocker from the planned V1-only exceptions", () => {
    const tools = capabilities.filter(item => item.kind === "tool");
    expect(tools.filter(item => item.v2 === "supported")).toHaveLength(64);
    expect(tools.filter(item => item.v2 === "unsupported")).toHaveLength(22);
    expect(tools.filter(item => item.v2 === "blocked").map(item => item.name)).toEqual(["opencode_command_execute"]);
  });
  it.each(capabilities.filter(item => item.kind === "tool" && item.v2 !== "supported"))("rejects $name on V2 before transport or handler mutation", async capability => {
    const handlers = new Map<string, Function>();
    vi.spyOn(McpServer.prototype, "registerTool").mockImplementation(((name: string, _configuration: unknown, handler: Function) => { handlers.set(name, handler); return {}; }) as any);
    const transport = client("v2");
    const get = vi.spyOn(transport, "get"), post = vi.spyOn(transport, "post"), patch = vi.spyOn(transport, "patch"), put = vi.spyOn(transport, "put"), remove = vi.spyOn(transport, "delete");
    createServer(transport, jobs, "full");
    const result = await handlers.get(capability.name)!({}, { mcpReq: { signal: new AbortController().signal } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({ code: "UNSUPPORTED_CAPABILITY", capability: capability.name, backend: "v2" });
    for (const method of [get, post, patch, put, remove]) expect(method).not.toHaveBeenCalled();
  });
});
