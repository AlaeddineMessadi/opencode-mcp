import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../src/client.js";
import { registerGlobalTools } from "../src/tools/global.js";
import { registerWorkflowTools } from "../src/tools/workflow.js";
import { registerConfigTools } from "../src/tools/config.js";
import { registerSessionTools } from "../src/tools/session.js";
import { registerFileTools } from "../src/tools/file.js";
import { registerProjectTools } from "../src/tools/project.js";
import { registerProviderTools } from "../src/tools/provider.js";

// ─── Mock client factory ─────────────────────────────────────────────────

function createMockClient(overrides: Record<string, unknown> = {}) {
  return {
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(undefined),
    subscribeSSE: vi.fn(),
    getBaseUrl: vi.fn().mockReturnValue("http://localhost:4096"),
    ...overrides,
  } as unknown as OpenCodeClient;
}

// ─── Tool registration capture ───────────────────────────────────────────

function captureTools(registerFn: (server: McpServer, client: OpenCodeClient) => void) {
  const tools = new Map<string, { description: string; handler: Function }>();
  const mockServer = {
    tool: vi.fn((name: string, description: string, _schema: unknown, handler: Function) => {
      tools.set(name, { description, handler });
    }),
  } as unknown as McpServer;
  const mockClient = createMockClient();
  registerFn(mockServer, mockClient);
  return { tools, server: mockServer, client: mockClient };
}

// ─── Tool registration tests ─────────────────────────────────────────────

describe("Tool registration", () => {
  describe("registerGlobalTools", () => {
    it("registers opencode_health", () => {
      const { tools } = captureTools(registerGlobalTools);
      expect(tools.has("opencode_health")).toBe(true);
    });
  });

  describe("registerWorkflowTools", () => {
    it("registers all 8 workflow tools", () => {
      const { tools } = captureTools(registerWorkflowTools);
      const expected = [
        "opencode_setup",
        "opencode_ask",
        "opencode_reply",
        "opencode_conversation",
        "opencode_sessions_overview",
        "opencode_context",
        "opencode_wait",
        "opencode_review_changes",
      ];
      for (const name of expected) {
        expect(tools.has(name), `Missing tool: ${name}`).toBe(true);
      }
      expect(tools.size).toBe(8);
    });
  });

  describe("registerConfigTools", () => {
    it("registers all 3 config tools", () => {
      const { tools } = captureTools(registerConfigTools);
      expect(tools.has("opencode_config_get")).toBe(true);
      expect(tools.has("opencode_config_update")).toBe(true);
      expect(tools.has("opencode_config_providers")).toBe(true);
      expect(tools.size).toBe(3);
    });
  });

  describe("registerSessionTools", () => {
    it("registers 18 session tools", () => {
      const { tools } = captureTools(registerSessionTools);
      expect(tools.size).toBe(18);
      expect(tools.has("opencode_session_list")).toBe(true);
      expect(tools.has("opencode_session_create")).toBe(true);
      expect(tools.has("opencode_session_delete")).toBe(true);
      expect(tools.has("opencode_session_diff")).toBe(true);
      expect(tools.has("opencode_session_fork")).toBe(true);
    });
  });

  describe("registerFileTools", () => {
    it("registers 6 file tools", () => {
      const { tools } = captureTools(registerFileTools);
      expect(tools.size).toBe(6);
      expect(tools.has("opencode_find_text")).toBe(true);
      expect(tools.has("opencode_find_file")).toBe(true);
      expect(tools.has("opencode_file_read")).toBe(true);
    });
  });

  describe("registerProjectTools", () => {
    it("registers 2 project tools", () => {
      const { tools } = captureTools(registerProjectTools);
      expect(tools.size).toBe(2);
    });
  });

  describe("registerProviderTools", () => {
    it("registers 6 provider tools", () => {
      const { tools } = captureTools(registerProviderTools);
      expect(tools.size).toBe(6);
      expect(tools.has("opencode_provider_list")).toBe(true);
      expect(tools.has("opencode_provider_models")).toBe(true);
      expect(tools.has("opencode_provider_auth_methods")).toBe(true);
      expect(tools.has("opencode_provider_oauth_authorize")).toBe(true);
      expect(tools.has("opencode_provider_oauth_callback")).toBe(true);
      expect(tools.has("opencode_auth_set")).toBe(true);
    });
  });
});

// ─── Tool handler tests ──────────────────────────────────────────────────

describe("Tool handlers", () => {
  describe("opencode_health", () => {
    it("returns health data from client", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue({ version: "1.0.0", status: "healthy" }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((_n: string, _d: string, _s: unknown, handler: Function) => {
          tools.set(_n, handler);
        }),
      } as unknown as McpServer;
      registerGlobalTools(mockServer, mockClient);

      const handler = tools.get("opencode_health")!;
      const result = await handler({});
      expect(result.content[0].text).toContain("healthy");
      expect(result.content[0].text).toContain("1.0.0");
    });

    it("returns error on failure", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockRejectedValue(new Error("Connection refused")),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((_n: string, _d: string, _s: unknown, handler: Function) => {
          tools.set(_n, handler);
        }),
      } as unknown as McpServer;
      registerGlobalTools(mockServer, mockClient);

      const handler = tools.get("opencode_health")!;
      const result = await handler({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Connection refused");
    });
  });

  describe("opencode_ask", () => {
    let mockClient: OpenCodeClient;
    let handler: Function;

    beforeEach(() => {
      mockClient = createMockClient({
        post: vi.fn()
          .mockResolvedValueOnce({ id: "session-1" }) // create session
          .mockResolvedValueOnce({ // send message
            info: { id: "msg-1", role: "assistant" },
            parts: [{ type: "text", text: "Here is the answer" }],
          }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((_n: string, _d: string, _s: unknown, h: Function) => {
          tools.set(_n, h);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);
      handler = tools.get("opencode_ask")!;
    });

    it("creates session and sends message", async () => {
      const result = await handler({ prompt: "What is this project?" });
      expect(result.content[0].text).toContain("session-1");
      expect(result.content[0].text).toContain("Here is the answer");
      expect((mockClient.post as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
    });

    it("uses prompt as title when none provided", async () => {
      await handler({ prompt: "What is this project?" });
      const [, body] = (mockClient.post as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(body.title).toBe("What is this project?");
    });

    it("uses custom title when provided", async () => {
      await handler({ prompt: "question", title: "My Title" });
      const [, body] = (mockClient.post as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(body.title).toBe("My Title");
    });

    it("includes model when providerID and modelID are set", async () => {
      await handler({
        prompt: "test",
        providerID: "anthropic",
        modelID: "claude-3",
      });
      const [, body] = (mockClient.post as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(body.model).toEqual({ providerID: "anthropic", modelID: "claude-3" });
    });

    it("includes agent when set", async () => {
      await handler({ prompt: "test", agent: "build" });
      const [, body] = (mockClient.post as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(body.agent).toBe("build");
    });

    it("returns error on failure", async () => {
      const failClient = createMockClient({
        post: vi.fn().mockRejectedValue(new Error("Server down")),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((_n: string, _d: string, _s: unknown, h: Function) => {
          tools.set(_n, h);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, failClient);
      const askHandler = tools.get("opencode_ask")!;
      const result = await askHandler({ prompt: "test" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Server down");
    });

    it("warns when response is empty (auth issue)", async () => {
      const emptyClient = createMockClient({
        post: vi.fn()
          .mockResolvedValueOnce({ id: "session-2" }) // create session
          .mockResolvedValueOnce(null), // empty response from provider
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((_n: string, _d: string, _s: unknown, h: Function) => {
          tools.set(_n, h);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, emptyClient);
      const askHandler = tools.get("opencode_ask")!;
      const result = await askHandler({ prompt: "test" });
      expect(result.content[0].text).toContain("WARNING");
      expect(result.content[0].text).toContain("empty response");
    });

    it("warns when response has no text content", async () => {
      const noTextClient = createMockClient({
        post: vi.fn()
          .mockResolvedValueOnce({ id: "session-3" })
          .mockResolvedValueOnce({ parts: [] }), // empty parts
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((_n: string, _d: string, _s: unknown, h: Function) => {
          tools.set(_n, h);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, noTextClient);
      const askHandler = tools.get("opencode_ask")!;
      const result = await askHandler({ prompt: "test" });
      expect(result.content[0].text).toContain("WARNING");
      expect(result.content[0].text).toContain("no text content");
    });

    it("does not warn for valid response", async () => {
      // already tested above, but explicitly verify no WARNING
      const result = await handler({ prompt: "What is this project?" });
      expect(result.content[0].text).not.toContain("WARNING");
    });
  });

  describe("opencode_reply", () => {
    it("warns when reply response is empty", async () => {
      const emptyClient = createMockClient({
        post: vi.fn().mockResolvedValueOnce(null), // empty response
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((_n: string, _d: string, _s: unknown, h: Function) => {
          tools.set(_n, h);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, emptyClient);
      const handler = tools.get("opencode_reply")!;
      const result = await handler({ sessionId: "s1", prompt: "follow up" });
      expect(result.content[0].text).toContain("WARNING");
      expect(result.content[0].text).toContain("empty response");
    });

    it("does not warn for valid reply", async () => {
      const goodClient = createMockClient({
        post: vi.fn().mockResolvedValueOnce({
          info: { id: "m2", role: "assistant" },
          parts: [{ type: "text", text: "Sure, here you go" }],
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((_n: string, _d: string, _s: unknown, h: Function) => {
          tools.set(_n, h);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, goodClient);
      const handler = tools.get("opencode_reply")!;
      const result = await handler({ sessionId: "s1", prompt: "follow up" });
      expect(result.content[0].text).toContain("Sure, here you go");
      expect(result.content[0].text).not.toContain("WARNING");
    });
  });

  describe("opencode_context", () => {
    it("fetches all context data in parallel", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/project/current") return Promise.resolve({ name: "my-project" });
          if (path === "/path") return Promise.resolve({ cwd: "/home/dev" });
          if (path === "/vcs") return Promise.resolve({ branch: "main" });
          if (path === "/config") return Promise.resolve({ theme: "dark" });
          if (path === "/agent") return Promise.resolve([{ name: "build", description: "Build agent", mode: "auto" }]);
          return Promise.resolve({});
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((_n: string, _d: string, _s: unknown, h: Function) => {
          tools.set(_n, h);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_context")!;
      const result = await handler({});
      expect(result.content[0].text).toContain("my-project");
      expect(result.content[0].text).toContain("/home/dev");
      expect(result.content[0].text).toContain("main");
      expect(result.content[0].text).toContain("build");
    });

    it("handles partial failures gracefully", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/project/current") return Promise.resolve({ name: "proj" });
          return Promise.reject(new Error("not available"));
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((_n: string, _d: string, _s: unknown, h: Function) => {
          tools.set(_n, h);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_context")!;
      const result = await handler({});
      // Should not error out — partial results are ok
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("proj");
    });
  });

  describe("opencode_setup", () => {
    it("shows WORKING for provider that responds to probe", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/global/health") return Promise.resolve({ version: "0.2.0" });
          if (path === "/provider") return Promise.resolve([
            { id: "anthropic", connected: true, models: [{ id: "claude-sonnet-4-20250514" }] },
            { id: "openai", connected: false, models: [] },
          ]);
          if (path === "/provider/auth") return Promise.resolve({
            openai: [{ type: "api" }, { type: "oauth" }],
          });
          if (path === "/project/current") return Promise.resolve({ name: "my-app", worktree: "/home/user/my-app", vcs: "git" });
          return Promise.resolve({});
        }),
        post: vi.fn()
          .mockResolvedValueOnce({ id: "probe-session-1" }) // create probe session
          .mockResolvedValueOnce({ // probe response with text
            parts: [{ type: "text", text: "OK" }],
          }),
        delete: vi.fn().mockResolvedValue(undefined),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((_n: string, _d: string, _s: unknown, h: Function) => {
          tools.set(_n, h);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_setup")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("healthy");
      expect(text).toContain("0.2.0");
      expect(text).toContain("anthropic");
      expect(text).toContain("WORKING");
      expect(text).toContain("NOT CONFIGURED");
      expect(text).toContain("available auth: api, oauth");
      expect(text).toContain("my-app");
      expect(text).toContain("Next Steps");
    });

    it("shows CONNECTED BUT NOT RESPONDING for provider with empty probe", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/global/health") return Promise.resolve({ version: "0.2.0" });
          if (path === "/provider") return Promise.resolve([
            { id: "google", connected: true, models: [{ id: "gemini-2.5-flash" }] },
          ]);
          if (path === "/provider/auth") return Promise.resolve({});
          if (path === "/project/current") return Promise.resolve({ name: "proj" });
          return Promise.resolve({});
        }),
        post: vi.fn()
          .mockResolvedValueOnce({ id: "probe-session-2" }) // create probe session
          .mockResolvedValueOnce(null), // empty probe response
        delete: vi.fn().mockResolvedValue(undefined),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((_n: string, _d: string, _s: unknown, h: Function) => {
          tools.set(_n, h);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_setup")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("google");
      expect(text).toContain("CONNECTED BUT NOT RESPONDING");
      expect(text).toContain("API key may be invalid");
    });

    it("shows 'could not verify' when probe throws", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/global/health") return Promise.resolve({ version: "0.2.0" });
          if (path === "/provider") return Promise.resolve([
            { id: "anthropic", connected: true, models: [{ id: "claude-3" }] },
          ]);
          if (path === "/provider/auth") return Promise.resolve({});
          if (path === "/project/current") return Promise.resolve({ name: "proj" });
          return Promise.resolve({});
        }),
        post: vi.fn()
          .mockRejectedValueOnce(new Error("timeout")), // probe fails entirely
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((_n: string, _d: string, _s: unknown, h: Function) => {
          tools.set(_n, h);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_setup")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("could not verify");
    });

    it("reports unreachable server", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((_n: string, _d: string, _s: unknown, h: Function) => {
          tools.set(_n, h);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_setup")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("UNREACHABLE");
      expect(text).toContain("ECONNREFUSED");
      // Should not contain provider or project sections
      expect(text).not.toContain("## Providers");
    });
  });

  describe("opencode_provider_list (compact)", () => {
    it("returns compact provider summary without models", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue([
          { id: "anthropic", connected: true, models: [{ id: "claude-3" }, { id: "claude-4" }] },
          { id: "openai", connected: false, models: [{ id: "gpt-4" }] },
          { id: "google", connected: true, models: [] },
        ]),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((_n: string, _d: string, _s: unknown, h: Function) => {
          tools.set(_n, h);
        }),
      } as unknown as McpServer;
      registerProviderTools(mockServer, mockClient);

      const handler = tools.get("opencode_provider_list")!;
      const result = await handler({});
      const text = result.content[0].text;
      // Should be compact — no model IDs dumped
      expect(text).toContain("anthropic: connected (2 models)");
      expect(text).toContain("openai: not configured (1 model)");
      expect(text).toContain("google: connected (0 models)");
      expect(text).toContain("opencode_provider_models");
      // Must NOT contain raw model IDs
      expect(text).not.toContain("claude-3");
      expect(text).not.toContain("gpt-4");
    });

    it("returns message when no providers", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue([]),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((_n: string, _d: string, _s: unknown, h: Function) => {
          tools.set(_n, h);
        }),
      } as unknown as McpServer;
      registerProviderTools(mockServer, mockClient);

      const handler = tools.get("opencode_provider_list")!;
      const result = await handler({});
      expect(result.content[0].text).toContain("No providers configured");
    });
  });

  describe("opencode_provider_models", () => {
    const providerData = [
      {
        id: "anthropic",
        connected: true,
        models: [
          { id: "claude-3", name: "Claude 3" },
          { id: "claude-4", name: "Claude 4" },
        ],
      },
      { id: "openai", connected: false, models: [{ id: "gpt-4" }] },
    ];

    it("lists models for a specific provider", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue(providerData),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((_n: string, _d: string, _s: unknown, h: Function) => {
          tools.set(_n, h);
        }),
      } as unknown as McpServer;
      registerProviderTools(mockServer, mockClient);

      const handler = tools.get("opencode_provider_models")!;
      const result = await handler({ providerId: "anthropic" });
      const text = result.content[0].text;
      expect(text).toContain("anthropic");
      expect(text).toContain("connected");
      expect(text).toContain("claude-3");
      expect(text).toContain("Claude 3");
      expect(text).toContain("claude-4");
      // Should NOT contain other provider models
      expect(text).not.toContain("gpt-4");
    });

    it("returns error for unknown provider", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue(providerData),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((_n: string, _d: string, _s: unknown, h: Function) => {
          tools.set(_n, h);
        }),
      } as unknown as McpServer;
      registerProviderTools(mockServer, mockClient);

      const handler = tools.get("opencode_provider_models")!;
      const result = await handler({ providerId: "nonexistent" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
      expect(result.content[0].text).toContain("anthropic");
    });

    it("shows NOT CONFIGURED status for disconnected provider", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue(providerData),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((_n: string, _d: string, _s: unknown, h: Function) => {
          tools.set(_n, h);
        }),
      } as unknown as McpServer;
      registerProviderTools(mockServer, mockClient);

      const handler = tools.get("opencode_provider_models")!;
      const result = await handler({ providerId: "openai" });
      const text = result.content[0].text;
      expect(text).toContain("NOT CONFIGURED");
      expect(text).toContain("gpt-4");
    });
  });

  describe("directory parameter propagation", () => {
    it("passes directory to client.get in opencode_health", async () => {
      const getMock = vi.fn().mockResolvedValue({ status: "ok" });
      const mockClient = createMockClient({ get: getMock });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((_n: string, _d: string, _s: unknown, h: Function) => {
          tools.set(_n, h);
        }),
      } as unknown as McpServer;
      registerGlobalTools(mockServer, mockClient);

      const handler = tools.get("opencode_health")!;
      await handler({ directory: "/home/user/project-a" });
      expect(getMock).toHaveBeenCalledWith("/global/health", undefined, "/home/user/project-a");
    });

    it("passes directory to client.post in opencode_ask", async () => {
      const postMock = vi.fn()
        .mockResolvedValueOnce({ id: "s1" })
        .mockResolvedValueOnce({ info: { id: "m1", role: "assistant" }, parts: [{ type: "text", text: "ok" }] });
      const mockClient = createMockClient({ post: postMock });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((_n: string, _d: string, _s: unknown, h: Function) => {
          tools.set(_n, h);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_ask")!;
      await handler({ prompt: "hello", directory: "/srv/web-app" });
      // Both calls should include directory
      expect(postMock.mock.calls[0][2]).toEqual({ directory: "/srv/web-app" });
      expect(postMock.mock.calls[1][2]).toEqual({ directory: "/srv/web-app" });
    });

    it("passes undefined directory when not provided", async () => {
      const getMock = vi.fn().mockResolvedValue({ status: "ok" });
      const mockClient = createMockClient({ get: getMock });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((_n: string, _d: string, _s: unknown, h: Function) => {
          tools.set(_n, h);
        }),
      } as unknown as McpServer;
      registerGlobalTools(mockServer, mockClient);

      const handler = tools.get("opencode_health")!;
      await handler({});
      expect(getMock).toHaveBeenCalledWith("/global/health", undefined, undefined);
    });
  });
});
