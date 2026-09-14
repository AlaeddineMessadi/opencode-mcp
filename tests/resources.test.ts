import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../src/client.js";
import { registerResources } from "../src/resources.js";

function createMockClient(getImpl?: (path: string) => Promise<unknown>) {
  return {
    get: vi.fn(getImpl ?? (() => Promise.resolve({}))),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    subscribeSSE: vi.fn(),
    getBaseUrl: vi.fn().mockReturnValue("http://localhost:4096"),
  } as unknown as OpenCodeClient;
}

function captureResources() {
  const resources = new Map<
    string,
    { uri: string; handler: Function }
  >();
  const mockServer = {
    resource: vi.fn(
      (name: string, uri: string, _opts: unknown, handler: Function) => {
        if (typeof uri === "string") resources.set(name, { uri, handler });
      },
    ),
  } as unknown as McpServer;
  const mockClient = createMockClient();
  registerResources(mockServer, mockClient);
  return { resources, server: mockServer, client: mockClient };
}

describe("Resource registration", () => {
  it("registers all 10 resources", () => {
    const { resources } = captureResources();
    expect(resources.size).toBe(10);
  });

  it("registers expected resource names", () => {
    const { resources } = captureResources();
    const expected = [
      "project-current",
      "config",
      "providers",
      "agents",
      "commands",
      "health",
      "vcs",
      "sessions",
      "mcp-servers",
      "file-status",
    ];
    for (const name of expected) {
      expect(resources.has(name), `Missing resource: ${name}`).toBe(true);
    }
  });

  it("uses opencode:// URI scheme", () => {
    const { resources } = captureResources();
    for (const [, { uri }] of resources) {
      expect(uri).toMatch(/^opencode:\/\//);
    }
  });
});

describe("Resource handlers", () => {
  it("config resource returns JSON from client", async () => {
    const mockClient = createMockClient(async (path) => {
      if (path === "/config") return { theme: "dark", model: "claude-3" };
      return {};
    });
    const resources = new Map<string, Function>();
    const mockServer = {
      resource: vi.fn((_n: string, _u: string, _o: unknown, handler: Function) => {
        resources.set(_n, handler);
      }),
    } as unknown as McpServer;
    registerResources(mockServer, mockClient);

    const handler = resources.get("config")!;
    const result = await handler();
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].mimeType).toBe("application/json");
    expect(result.contents[0].text).toContain("dark");
  });

  it("project-current returns fallback on error", async () => {
    const mockClient = createMockClient(async () => {
      throw new Error("No project");
    });
    const resources = new Map<string, Function>();
    const mockServer = {
      resource: vi.fn((_n: string, _u: string, _o: unknown, handler: Function) => {
        resources.set(_n, handler);
      }),
    } as unknown as McpServer;
    registerResources(mockServer, mockClient);

    const handler = resources.get("project-current")!;
    const result = await handler();
    expect(result.contents[0].text).toContain("No project currently active");
  });

  it("vcs resource returns fallback on error", async () => {
    const mockClient = createMockClient(async () => {
      throw new Error("No VCS");
    });
    const resources = new Map<string, Function>();
    const mockServer = {
      resource: vi.fn((_n: string, _u: string, _o: unknown, handler: Function) => {
        resources.set(_n, handler);
      }),
    } as unknown as McpServer;
    registerResources(mockServer, mockClient);

    const handler = resources.get("vcs")!;
    const result = await handler();
    expect(result.contents[0].text).toContain("No VCS information available");
  });

  it("health resource fetches from /global/health", async () => {
    const getMock = vi.fn().mockResolvedValue({ version: "1.0", ok: true });
    const mockClient = createMockClient(getMock as unknown as (path: string) => Promise<unknown>);
    const resources = new Map<string, Function>();
    const mockServer = {
      resource: vi.fn((_n: string, _u: string, _o: unknown, handler: Function) => {
        resources.set(_n, handler);
      }),
    } as unknown as McpServer;
    registerResources(mockServer, mockClient);

    const handler = resources.get("health")!;
    await handler();
    expect(getMock).toHaveBeenCalledWith("/global/health");
  });
});
