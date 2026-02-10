import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient } from "../src/client.js";
import { registerGlobalTools } from "../src/tools/global.js";
import { registerWorkflowTools } from "../src/tools/workflow.js";
import { registerConfigTools } from "../src/tools/config.js";
import { registerSessionTools } from "../src/tools/session.js";
import { registerMessageTools } from "../src/tools/message.js";
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
    tool: vi.fn((...args: unknown[]) => {
      // Handle both 4-arg (name, desc, schema, handler) and
      // 5-arg (name, desc, schema, annotations, handler) forms
      const name = args[0] as string;
      const description = args[1] as string;
      const handler = args[args.length - 1] as Function;
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
    it("registers all 13 workflow tools", () => {
      const { tools } = captureTools(registerWorkflowTools);
      const expected = [
        "opencode_setup",
        "opencode_ask",
        "opencode_reply",
        "opencode_conversation",
        "opencode_sessions_overview",
        "opencode_context",
        "opencode_wait",
        "opencode_run",
        "opencode_fire",
        "opencode_check",
        "opencode_review_changes",
        "opencode_provider_test",
        "opencode_status",
      ];
      for (const name of expected) {
        expect(tools.has(name), `Missing tool: ${name}`).toBe(true);
      }
      expect(tools.size).toBe(13);
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
    it("registers 20 session tools", () => {
      const { tools } = captureTools(registerSessionTools);
      expect(tools.size).toBe(20);
      expect(tools.has("opencode_session_list")).toBe(true);
      expect(tools.has("opencode_session_create")).toBe(true);
      expect(tools.has("opencode_session_delete")).toBe(true);
      expect(tools.has("opencode_session_diff")).toBe(true);
      expect(tools.has("opencode_session_fork")).toBe(true);
      expect(tools.has("opencode_permission_list")).toBe(true);
      expect(tools.has("opencode_session_permission")).toBe(true);
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
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
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
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
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
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
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
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
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
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
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
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
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
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
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
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
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
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
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
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
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
    it("shows 'Ready to use' for providers with source=env and context-dependent next steps", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/global/health") return Promise.resolve({ version: "0.2.0" });
          if (path === "/provider") return Promise.resolve({ all: [
            { id: "huggingface", name: "Hugging Face", source: "env", env: ["HF_TOKEN"], models: { "meta-llama": { id: "meta-llama" } } },
            // openai and anthropic: source=custom with empty options = NOT configured (listed under Quick setup)
            { id: "openai", name: "OpenAI", source: "custom", options: {}, env: ["OPENAI_API_KEY"], models: {} },
            { id: "anthropic", name: "Anthropic", source: "custom", options: {}, env: ["ANTHROPIC_API_KEY"], models: { "claude-sonnet-4-20250514": { id: "claude-sonnet-4-20250514" } } },
          ]});
          if (path === "/provider/auth") return Promise.resolve({
            openai: [{ type: "api", label: "API Key" }, { type: "oauth", label: "OAuth" }],
            anthropic: [{ type: "api", label: "API Key" }],
          });
          if (path === "/project/current") return Promise.resolve({ name: "my-app", worktree: "/home/user/my-app", vcs: "git" });
          return Promise.resolve({});
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_setup")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("healthy");
      expect(text).toContain("0.2.0");
      expect(text).toContain("Ready to use");
      expect(text).toContain("huggingface");
      expect(text).toContain("HF_TOKEN");
      expect(text).toContain("Quick setup options");
      expect(text).toContain("anthropic");
      expect(text).toContain("openai");
      expect(text).toContain("my-app");
      // Has a ready provider (huggingface), so next steps should say "ready to go"
      expect(text).toContain("ready to go");
      expect(text).toContain("Next Steps");
    });

    it("shows 'No providers configured' and setup guidance when none have any source", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/global/health") return Promise.resolve({ version: "0.2.0" });
          if (path === "/provider") return Promise.resolve({ all: [
            // No source field = not configured
            { id: "google", name: "Google", models: { "gemini-2.5-flash": { id: "gemini-2.5-flash" } } },
          ]});
          if (path === "/provider/auth") return Promise.resolve({});
          if (path === "/project/current") return Promise.resolve({ name: "proj" });
          return Promise.resolve({});
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_setup")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("google");
      expect(text).toContain("No providers configured yet");
      // Next steps should guide to configure a provider
      expect(text).toContain("You need to configure a provider first");
      expect(text).toContain("opencode_auth_set");
    });

    it("detects source=custom with OAuth headers as configured — anthropic heuristic (N1 fix)", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/global/health") return Promise.resolve({ version: "0.2.0" });
          if (path === "/provider") return Promise.resolve({ all: [
            // anthropic with OAuth: source=custom, empty apiKey, but has headers
            { id: "anthropic", name: "Anthropic", source: "custom", options: { apiKey: "", headers: { "anthropic-beta": "test" } }, models: { "claude-3": { id: "claude-3" } } },
          ]});
          if (path === "/provider/auth") return Promise.resolve({});
          if (path === "/project/current") return Promise.resolve({ name: "proj" });
          return Promise.resolve({});
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_setup")!;
      const result = await handler({});
      const text = result.content[0].text;
      // anthropic with OAuth headers should be detected as configured
      expect(text).toContain("Ready to use");
      expect(text).toContain("anthropic");
      expect(text).toContain("ready to go");
    });

    it("does NOT detect source=custom with empty options as configured", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/global/health") return Promise.resolve({ version: "0.2.0" });
          if (path === "/provider") return Promise.resolve({ all: [
            // Generic provider with source=custom but no real credentials — NOT configured
            { id: "groq", name: "Groq", source: "custom", options: {}, models: { "llama-3": { id: "llama-3" } } },
          ]});
          if (path === "/provider/auth") return Promise.resolve({});
          if (path === "/project/current") return Promise.resolve({ name: "proj" });
          return Promise.resolve({});
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_setup")!;
      const result = await handler({});
      const text = result.content[0].text;
      // source=custom with empty options = NOT configured
      expect(text).toContain("No providers configured yet");
      expect(text).toContain("You need to configure a provider first");
    });

    it("handles providers returned as { all: [...] } object format", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/global/health") return Promise.resolve({ version: "0.2.0" });
          if (path === "/provider") return Promise.resolve({ all: [
            { id: "anthropic", name: "Anthropic", source: "custom", options: { apiKey: "", headers: { "anthropic-beta": "test" } }, models: { "claude-3": { id: "claude-3" } } },
          ]});
          if (path === "/provider/auth") return Promise.resolve({});
          if (path === "/project/current") return Promise.resolve({ name: "proj" });
          return Promise.resolve({});
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_setup")!;
      const result = await handler({});
      const text = result.content[0].text;
      // Should parse { all: [...] } format correctly
      expect(text).toContain("1 available");
      expect(text).toContain("anthropic");
    });

    it("reports unreachable server", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
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
          { id: "anthropic", source: "env", models: [{ id: "claude-3" }, { id: "claude-4" }] },
          { id: "opencode", source: "custom", options: { apiKey: "public" }, models: [{ id: "gpt-4" }] },
          { id: "google", source: "config", models: [] },
          { id: "groq", source: "custom", options: {}, models: [] },  // source=custom with empty options = NOT configured
        ]),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerProviderTools(mockServer, mockClient);

      const handler = tools.get("opencode_provider_list")!;
      const result = await handler({});
      const text = result.content[0].text;
      // Should be compact with configured first — no model IDs dumped
      expect(text).toContain("**Configured:**");
      expect(text).toContain("anthropic: 2 models");
      expect(text).toContain("opencode: 1 model");  // source=custom with apiKey="public" IS configured
      expect(text).toContain("google: 0 models");
      expect(text).toContain("3 configured");
      expect(text).toContain("**Not configured:**");
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
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
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
        source: "env",
        models: [
          { id: "claude-3", name: "Claude 3" },
          { id: "claude-4", name: "Claude 4" },
        ],
      },
      { id: "openai", source: "config", models: [{ id: "gpt-4" }] },
    ];

    it("lists models for a configured provider", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue(providerData),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerProviderTools(mockServer, mockClient);

      const handler = tools.get("opencode_provider_models")!;
      const result = await handler({ providerId: "anthropic" });
      const text = result.content[0].text;
      expect(text).toContain("anthropic");
      expect(text).toContain("configured");
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
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerProviderTools(mockServer, mockClient);

      const handler = tools.get("opencode_provider_models")!;
      const result = await handler({ providerId: "nonexistent" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
      expect(result.content[0].text).toContain("anthropic");
    });

    it("shows configured for source=custom with apiKey (N4 fix)", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue([
          { id: "opencode", source: "custom", options: { apiKey: "public" }, models: [{ id: "model-1" }] },
        ]),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerProviderTools(mockServer, mockClient);

      const handler = tools.get("opencode_provider_models")!;
      const result = await handler({ providerId: "opencode" });
      const text = result.content[0].text;
      // source=custom with apiKey="public" IS configured
      expect(text).toContain("configured");
      expect(text).not.toContain("NOT CONFIGURED");
    });

    it("shows NOT CONFIGURED for source=custom with empty options", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue([
          { id: "groq", source: "custom", options: {}, models: [{ id: "llama-3" }] },
        ]),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerProviderTools(mockServer, mockClient);

      const handler = tools.get("opencode_provider_models")!;
      const result = await handler({ providerId: "groq" });
      const text = result.content[0].text;
      expect(text).toContain("NOT CONFIGURED");
    });

    it("shows configured for anthropic with OAuth headers heuristic", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue([
          { id: "anthropic", source: "custom", options: { apiKey: "", headers: { "anthropic-beta": "test" } }, models: [{ id: "claude-3" }] },
        ]),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerProviderTools(mockServer, mockClient);

      const handler = tools.get("opencode_provider_models")!;
      const result = await handler({ providerId: "anthropic" });
      const text = result.content[0].text;
      // anthropic with OAuth headers heuristic = configured
      expect(text).toContain("configured");
      expect(text).not.toContain("NOT CONFIGURED");
    });

    it("shows NOT CONFIGURED status for provider with no source", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue([
          { id: "groq", models: [{ id: "llama-3" }] },
        ]),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerProviderTools(mockServer, mockClient);

      const handler = tools.get("opencode_provider_models")!;
      const result = await handler({ providerId: "groq" });
      const text = result.content[0].text;
      expect(text).toContain("NOT CONFIGURED");
    });

    it("detects source=config as configured", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue([
          { id: "google", source: "config", models: { "gemini-2.5-flash": { id: "gemini-2.5-flash" } } },
        ]),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerProviderTools(mockServer, mockClient);

      const handler = tools.get("opencode_provider_models")!;
      const result = await handler({ providerId: "google" });
      const text = result.content[0].text;
      expect(text).toContain("configured");
      expect(text).not.toContain("NOT CONFIGURED");
      expect(text).toContain("gemini-2.5-flash");
    });
  });

  describe("opencode_file_list", () => {
    it("defaults path to '.' when not provided", async () => {
      const getMock = vi.fn().mockResolvedValue([
        { name: "src", type: "directory" },
        { name: "package.json", type: "file" },
      ]);
      const mockClient = createMockClient({ get: getMock });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerFileTools(mockServer, mockClient);

      const handler = tools.get("opencode_file_list")!;
      await handler({});
      // Should pass path="." even when path is not provided
      expect(getMock).toHaveBeenCalledWith("/file", { path: "." }, undefined);
    });

    it("uses provided path", async () => {
      const getMock = vi.fn().mockResolvedValue([]);
      const mockClient = createMockClient({ get: getMock });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerFileTools(mockServer, mockClient);

      const handler = tools.get("opencode_file_list")!;
      await handler({ path: "src" });
      expect(getMock).toHaveBeenCalledWith("/file", { path: "src" }, undefined);
    });
  });

  describe("opencode_find_text", () => {
    it("handles path as object without [object Object]", async () => {
      const getMock = vi.fn().mockResolvedValue([
        { path: { path: "src/index.ts", name: "index.ts" }, line_number: 10, lines: "const x = 1;" },
      ]);
      const mockClient = createMockClient({ get: getMock });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerFileTools(mockServer, mockClient);

      const handler = tools.get("opencode_find_text")!;
      const result = await handler({ pattern: "const x" });
      const text = result.content[0].text;
      expect(text).not.toContain("[object Object]");
      expect(text).toContain("src/index.ts");
      expect(text).toContain(":10");
    });

    it("handles path as string normally", async () => {
      const getMock = vi.fn().mockResolvedValue([
        { path: "src/main.ts", line_number: 5, lines: "import { foo } from './bar';" },
      ]);
      const mockClient = createMockClient({ get: getMock });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerFileTools(mockServer, mockClient);

      const handler = tools.get("opencode_find_text")!;
      const result = await handler({ pattern: "import" });
      const text = result.content[0].text;
      expect(text).toContain("src/main.ts:5");
    });
  });

  describe("opencode_find_symbol (N2 fix)", () => {
    it("returns friendly message for empty results instead of raw []", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue([]),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerFileTools(mockServer, mockClient);

      const handler = tools.get("opencode_find_symbol")!;
      const result = await handler({ query: "nonexistent" });
      const text = result.content[0].text;
      expect(text).toContain("No symbols found matching: nonexistent");
      expect(text).not.toContain("[]");
    });

    it("formats symbol results as a list", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue([
          { name: "MyClass", kind: "class", location: "src/main.ts", line: 10 },
          { name: "myFunction", kind: "function", path: "src/utils.ts", lineNumber: 25 },
        ]),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerFileTools(mockServer, mockClient);

      const handler = tools.get("opencode_find_symbol")!;
      const result = await handler({ query: "my" });
      const text = result.content[0].text;
      expect(text).toContain("2 symbol(s)");
      expect(text).toContain("MyClass (class)");
      expect(text).toContain("src/main.ts:10");
      expect(text).toContain("myFunction (function)");
      expect(text).toContain("src/utils.ts:25");
    });
  });

  describe("opencode_session_status (N3 fix)", () => {
    it("returns 'All sessions idle' for empty status object", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue({}),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerSessionTools(mockServer, mockClient);

      const handler = tools.get("opencode_session_status")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("All sessions idle");
      expect(text).not.toContain("{}");
    });

    it("formats non-empty status as a list", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue({ "session-1": "running", "session-2": "idle" }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerSessionTools(mockServer, mockClient);

      const handler = tools.get("opencode_session_status")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("Session Status (2)");
      expect(text).toContain("session-1: running");
      expect(text).toContain("session-2: idle");
    });
  });

  describe("opencode_provider_models error (N6 fix)", () => {
    it("truncates provider list in error message to first 10", async () => {
      // Create 20 providers
      const providers = Array.from({ length: 20 }, (_, i) => ({
        id: `provider-${i}`,
        source: "env",
        models: [],
      }));
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue(providers),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerProviderTools(mockServer, mockClient);

      const handler = tools.get("opencode_provider_models")!;
      const result = await handler({ providerId: "nonexistent" });
      const text = result.content[0].text;
      expect(text).toContain("not found");
      expect(text).toContain("provider-0");
      expect(text).toContain("provider-9");
      expect(text).not.toContain("provider-10");
      expect(text).toContain("... and 10 more");
      expect(text).toContain("opencode_provider_list");
    });
  });

  describe("opencode_provider_list (N5 fix — source detection)", () => {
    it("detects source=api as configured and source=custom with credentials", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue([
          // anthropic with OAuth headers = configured (heuristic)
          { id: "anthropic", source: "custom", options: { apiKey: "", headers: { "anthropic-beta": "test" } }, models: [{ id: "claude-3" }] },
          { id: "zai-coding", source: "api", models: [] },
          { id: "groq", source: "custom", options: {}, models: [] },  // source=custom, empty options = NOT configured
        ]),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerProviderTools(mockServer, mockClient);

      const handler = tools.get("opencode_provider_list")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("2 configured");
      expect(text).toContain("**Configured:**");
      expect(text).toContain("anthropic: 1 model");
      expect(text).toContain("zai-coding: 0 models");
    });
  });

  describe("opencode_config_providers (compact)", () => {
    it("returns compact summary instead of full model specs", async () => {
      // API returns { providers: [...], default: { providerId: modelId } }
      const getMock = vi.fn().mockResolvedValue({
        providers: [
          { id: "anthropic", name: "Anthropic", models: { "claude-3": {}, "claude-4": {} } },
          { id: "openai", name: "OpenAI", models: { "gpt-4": {} } },
        ],
        default: { anthropic: "claude-3", openai: "gpt-4" },
      });
      const mockClient = createMockClient({ get: getMock });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerConfigTools(mockServer, mockClient);

      const handler = tools.get("opencode_config_providers")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("anthropic");
      expect(text).toContain("2 models");
      expect(text).toContain("default: claude-3");
      expect(text).toContain("openai");
      expect(text).toContain("1 model");
      expect(text).toContain("opencode_provider_models");
    });
  });

  describe("directory parameter propagation", () => {
    it("passes directory to client.get in opencode_health", async () => {
      const getMock = vi.fn().mockResolvedValue({ status: "ok" });
      const mockClient = createMockClient({ get: getMock });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
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
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
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
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerGlobalTools(mockServer, mockClient);

      const handler = tools.get("opencode_health")!;
      await handler({});
      expect(getMock).toHaveBeenCalledWith("/global/health", undefined, undefined);
    });
  });

  describe("opencode_message_send (R5-B1 fix)", () => {
    it("warns when response is empty (null)", async () => {
      const mockClient = createMockClient({
        post: vi.fn().mockResolvedValueOnce(null),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerMessageTools(mockServer, mockClient);

      const handler = tools.get("opencode_message_send")!;
      const result = await handler({ sessionId: "s1", text: "hello" });
      expect(result.content[0].text).toContain("WARNING");
      expect(result.content[0].text).toContain("empty response");
    });

    it("warns when response has no text content", async () => {
      const mockClient = createMockClient({
        post: vi.fn().mockResolvedValueOnce({ parts: [] }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerMessageTools(mockServer, mockClient);

      const handler = tools.get("opencode_message_send")!;
      const result = await handler({ sessionId: "s1", text: "hello" });
      expect(result.content[0].text).toContain("WARNING");
      expect(result.content[0].text).toContain("no text content");
    });

    it("does not warn for valid response with text", async () => {
      const mockClient = createMockClient({
        post: vi.fn().mockResolvedValueOnce({
          info: { id: "m1", role: "assistant" },
          parts: [{ type: "text", text: "Here is the answer" }],
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerMessageTools(mockServer, mockClient);

      const handler = tools.get("opencode_message_send")!;
      const result = await handler({ sessionId: "s1", text: "hello" });
      expect(result.content[0].text).toContain("Here is the answer");
      expect(result.content[0].text).not.toContain("WARNING");
    });

    it("returns 'Empty response.' when formatted output is empty string", async () => {
      const mockClient = createMockClient({
        post: vi.fn().mockResolvedValueOnce(null),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerMessageTools(mockServer, mockClient);

      const handler = tools.get("opencode_message_send")!;
      const result = await handler({ sessionId: "s1", text: "hello" });
      // Should have the WARNING but also not be completely empty
      expect(result.content[0].text.length).toBeGreaterThan(0);
    });
  });

  describe("opencode_session_share (R5-B2 fix)", () => {
    it("formats output with share URL instead of raw JSON", async () => {
      const mockClient = createMockClient({
        post: vi.fn().mockResolvedValueOnce({
          id: "session-1",
          title: "My Session",
          shareUrl: "https://opncd.ai/share/abc123",
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerSessionTools(mockServer, mockClient);

      const handler = tools.get("opencode_session_share")!;
      const result = await handler({ id: "session-1" });
      const text = result.content[0].text;
      expect(text).toContain("Session shared.");
      expect(text).toContain("https://opncd.ai/share/abc123");
      expect(text).toContain("session-1");
      // Should NOT be raw JSON with curly braces
      expect(text).not.toMatch(/^\{/);
    });

    it("handles share URL in nested share object", async () => {
      const mockClient = createMockClient({
        post: vi.fn().mockResolvedValueOnce({
          id: "session-2",
          share: { url: "https://opncd.ai/share/xyz789" },
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerSessionTools(mockServer, mockClient);

      const handler = tools.get("opencode_session_share")!;
      const result = await handler({ id: "session-2" });
      expect(result.content[0].text).toContain("https://opncd.ai/share/xyz789");
    });

    it("shows confirmation even without share URL", async () => {
      const mockClient = createMockClient({
        post: vi.fn().mockResolvedValueOnce({ id: "session-3" }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerSessionTools(mockServer, mockClient);

      const handler = tools.get("opencode_session_share")!;
      const result = await handler({ id: "session-3" });
      expect(result.content[0].text).toContain("Session shared.");
    });
  });

  describe("opencode_session_unshare (R5-B3 fix)", () => {
    it("returns confirmation message instead of raw JSON", async () => {
      const mockClient = createMockClient({
        delete: vi.fn().mockResolvedValueOnce(undefined),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerSessionTools(mockServer, mockClient);

      const handler = tools.get("opencode_session_unshare")!;
      const result = await handler({ id: "session-1" });
      const text = result.content[0].text;
      expect(text).toContain("Session session-1 unshared.");
      // Should NOT be raw JSON
      expect(text).not.toMatch(/^\{/);
      expect(text).not.toContain("undefined");
    });
  });

  describe("opencode_session_init (R5-B4 fix)", () => {
    it("has timeout warning in description", () => {
      const { tools } = captureTools(registerSessionTools);
      const tool = tools.get("opencode_session_init")!;
      expect(tool.description).toContain("long-running");
    });
  });

  describe("opencode_session_summarize (R5-B5 fix)", () => {
    it("has timeout warning in description", () => {
      const { tools } = captureTools(registerSessionTools);
      const tool = tools.get("opencode_session_summarize")!;
      expect(tool.description).toContain("long-running");
    });
  });

  // ─── New features ───────────────────────────────────────────────────

  describe("opencode_provider_test", () => {
    it("reports success when provider returns valid response", async () => {
      const postMock = vi.fn()
        .mockResolvedValueOnce({ id: "test-session" }) // create session
        .mockResolvedValueOnce({ // send message
          info: { id: "m1", role: "assistant" },
          parts: [{ type: "text", text: "Hello" }],
        });
      const deleteMock = vi.fn().mockResolvedValue(undefined);
      const mockClient = createMockClient({ post: postMock, delete: deleteMock });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_provider_test")!;
      const result = await handler({ providerId: "anthropic" });
      const text = result.content[0].text;
      expect(text).toContain("anthropic");
      expect(text).toContain("is working");
      expect(text).toContain("Hello");
      // Should clean up the test session
      expect(deleteMock).toHaveBeenCalled();
    });

    it("reports failure when provider returns empty response", async () => {
      const postMock = vi.fn()
        .mockResolvedValueOnce({ id: "test-session" })
        .mockResolvedValueOnce(null); // empty response
      const deleteMock = vi.fn().mockResolvedValue(undefined);
      const mockClient = createMockClient({ post: postMock, delete: deleteMock });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_provider_test")!;
      const result = await handler({ providerId: "badprovider" });
      const text = result.content[0].text;
      expect(text).toContain("FAILED");
      expect(text).toContain("badprovider");
      expect(result.isError).toBe(true);
      // Should still clean up
      expect(deleteMock).toHaveBeenCalled();
    });

    it("cleans up test session even on API error", async () => {
      const postMock = vi.fn()
        .mockResolvedValueOnce({ id: "test-session" })
        .mockRejectedValueOnce(new Error("API timeout"));
      const deleteMock = vi.fn().mockResolvedValue(undefined);
      const mockClient = createMockClient({ post: postMock, delete: deleteMock });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_provider_test")!;
      const result = await handler({ providerId: "anthropic" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("API timeout");
      // Should attempt cleanup
      expect(deleteMock).toHaveBeenCalledWith("/session/test-session", undefined, undefined);
    });
  });

  describe("opencode_session_search", () => {
    const sessions = [
      { id: "s1", title: "Fix login bug" },
      { id: "s2", title: "Add dark mode feature" },
      { id: "s3", title: "Refactor login component" },
      { id: "s4", title: "Update README" },
    ];

    it("finds sessions matching keyword in title", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue(sessions),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerSessionTools(mockServer, mockClient);

      const handler = tools.get("opencode_session_search")!;
      const result = await handler({ query: "login" });
      const text = result.content[0].text;
      expect(text).toContain("2/4");
      expect(text).toContain("Fix login bug");
      expect(text).toContain("Refactor login component");
      expect(text).not.toContain("dark mode");
      expect(text).not.toContain("README");
    });

    it("performs case-insensitive search", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue(sessions),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerSessionTools(mockServer, mockClient);

      const handler = tools.get("opencode_session_search")!;
      const result = await handler({ query: "LOGIN" });
      const text = result.content[0].text;
      expect(text).toContain("2/4");
      expect(text).toContain("Fix login bug");
    });

    it("searches by session ID too", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue(sessions),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerSessionTools(mockServer, mockClient);

      const handler = tools.get("opencode_session_search")!;
      const result = await handler({ query: "s2" });
      const text = result.content[0].text;
      expect(text).toContain("1/4");
      expect(text).toContain("dark mode");
    });

    it("returns friendly message when no matches", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue(sessions),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerSessionTools(mockServer, mockClient);

      const handler = tools.get("opencode_session_search")!;
      const result = await handler({ query: "nonexistent" });
      const text = result.content[0].text;
      expect(text).toContain('No sessions matching: "nonexistent"');
      expect(text).toContain("Total sessions: 4");
    });

    it("returns 'No sessions found.' when session list is empty", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue([]),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerSessionTools(mockServer, mockClient);

      const handler = tools.get("opencode_session_search")!;
      const result = await handler({ query: "anything" });
      expect(result.content[0].text).toContain("No sessions found.");
    });
  });

  // ─── Permission tools ────────────────────────────────────────────────
  describe("opencode_permission_list", () => {
    it("returns pending permission requests with details", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue([
          {
            id: "perm_1",
            sessionID: "ses_abc",
            permission: "bash",
            patterns: ["npm test"],
            always: ["npm *"],
            tool: { name: "bash" },
          },
          {
            id: "perm_2",
            sessionID: "ses_def",
            permission: "edit",
            patterns: ["/etc/hosts"],
            always: [],
          },
        ]),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerSessionTools(mockServer, mockClient);

      const handler = tools.get("opencode_permission_list")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("Pending Permission Requests (2)");
      expect(text).toContain("bash");
      expect(text).toContain("perm_1");
      expect(text).toContain("ses_abc");
      expect(text).toContain("npm test");
      expect(text).toContain("npm *");
      expect(text).toContain("edit");
      expect(text).toContain("perm_2");
      expect(result.isError).toBeUndefined();
    });

    it("returns friendly message when no pending requests", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue([]),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerSessionTools(mockServer, mockClient);

      const handler = tools.get("opencode_permission_list")!;
      const result = await handler({});
      expect(result.content[0].text).toBe("No pending permission requests.");
    });
  });

  describe("opencode_session_permission", () => {
    it("sends reply via new API endpoint", async () => {
      const mockClient = createMockClient({
        post: vi.fn().mockResolvedValue({}),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerSessionTools(mockServer, mockClient);

      const handler = tools.get("opencode_session_permission")!;
      const result = await handler({
        id: "ses_abc",
        permissionID: "perm_1",
        reply: "always",
      });
      expect(result.content[0].text).toContain("approved");
      expect(result.content[0].text).toContain("always");
      // Should call the new endpoint first
      expect((mockClient as any).post).toHaveBeenCalledWith(
        "/permission/perm_1/reply",
        { reply: "always" },
        { directory: undefined },
      );
    });

    it("shows rejected for reject reply", async () => {
      const mockClient = createMockClient({
        post: vi.fn().mockResolvedValue({}),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerSessionTools(mockServer, mockClient);

      const handler = tools.get("opencode_session_permission")!;
      const result = await handler({
        id: "ses_abc",
        permissionID: "perm_1",
        reply: "reject",
      });
      expect(result.content[0].text).toContain("rejected");
    });

    it("falls back to deprecated endpoint when new API fails", async () => {
      let callCount = 0;
      const mockClient = createMockClient({
        post: vi.fn().mockImplementation((path: string) => {
          callCount++;
          if (path.startsWith("/permission/")) {
            return Promise.reject(new Error("404 not found"));
          }
          return Promise.resolve({});
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerSessionTools(mockServer, mockClient);

      const handler = tools.get("opencode_session_permission")!;
      const result = await handler({
        id: "ses_abc",
        permissionID: "perm_1",
        reply: "once",
      });
      expect(result.content[0].text).toContain("approved");
      // Should have tried new endpoint first, then deprecated
      expect((mockClient as any).post).toHaveBeenCalledTimes(2);
    });
  });

  describe("opencode_sessions_overview (v1.6.0 — resolveSessionStatus)", () => {
    it("resolves status objects instead of showing [object Object]", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/session") return Promise.resolve([
            { id: "s1", title: "Fix bug" },
            { id: "s2", title: "Add feature" },
          ]);
          if (path === "/session/status") return Promise.resolve({
            s1: { state: "running" },
            s2: { state: "idle" },
          });
          return Promise.resolve({});
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_sessions_overview")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("[running] Fix bug");
      expect(text).toContain("[idle] Add feature");
      expect(text).not.toContain("[object Object]");
    });

    it("handles string status values normally", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/session") return Promise.resolve([
            { id: "s1", title: "Session A" },
          ]);
          if (path === "/session/status") return Promise.resolve({
            s1: "running",
          });
          return Promise.resolve({});
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_sessions_overview")!;
      const result = await handler({});
      expect(result.content[0].text).toContain("[running] Session A");
    });

    it("falls back to idle for null/undefined status", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/session") return Promise.resolve([
            { id: "s1", title: "Orphan session" },
          ]);
          if (path === "/session/status") return Promise.resolve({});
          return Promise.resolve({});
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_sessions_overview")!;
      const result = await handler({});
      expect(result.content[0].text).toContain("[idle] Orphan session");
    });

    it("returns 'No sessions found.' when empty", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/session") return Promise.resolve([]);
          if (path === "/session/status") return Promise.resolve({});
          return Promise.resolve({});
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_sessions_overview")!;
      const result = await handler({});
      expect(result.content[0].text).toContain("No sessions found.");
    });

    it("shows parent tag for child sessions", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/session") return Promise.resolve([
            { id: "child-1", title: "Sub-task", parentID: "parent-1" },
          ]);
          if (path === "/session/status") return Promise.resolve({ "child-1": "idle" });
          return Promise.resolve({});
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_sessions_overview")!;
      const result = await handler({});
      expect(result.content[0].text).toContain("(child of parent-1)");
    });
  });

  describe("opencode_session_status (v1.6.0 — object status resolution)", () => {
    it("resolves object statuses with { state } field", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue({
          "session-1": { state: "running" },
          "session-2": { state: "idle" },
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerSessionTools(mockServer, mockClient);

      const handler = tools.get("opencode_session_status")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("session-1: running");
      expect(text).toContain("session-2: idle");
      expect(text).not.toContain("[object Object]");
    });
  });

  describe("opencode_wait (v1.6.0 — status resolution + timeout message)", () => {
    it("detects completion from object status { state: 'idle' }", async () => {
      const getMock = vi.fn().mockImplementation((path: string) => {
        if (path === "/session/status") return Promise.resolve({
          "s1": { state: "idle" },
        });
        if (path.includes("/message")) return Promise.resolve([
          { info: { id: "m1", role: "assistant" }, parts: [{ type: "text", text: "Done!" }] },
        ]);
        return Promise.resolve({});
      });
      const mockClient = createMockClient({ get: getMock });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_wait")!;
      const result = await handler({ sessionId: "s1", timeoutSeconds: 5, pollIntervalMs: 50 });
      const text = result.content[0].text;
      expect(text).toContain("Session completed");
      expect(text).toContain("Done!");
      expect(result.isError).toBeUndefined();
    });

    it("detects error from object status { state: 'error' }", async () => {
      const getMock = vi.fn().mockResolvedValue({
        "s1": { state: "error" },
      });
      const mockClient = createMockClient({ get: getMock });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_wait")!;
      const result = await handler({ sessionId: "s1", timeoutSeconds: 5, pollIntervalMs: 50 });
      expect(result.content[0].text).toContain("error status");
      expect(result.isError).toBe(true);
    });

    it("times out with actionable suggestions", async () => {
      const getMock = vi.fn().mockResolvedValue({
        "s1": { state: "running" },
      });
      const mockClient = createMockClient({ get: getMock });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_wait")!;
      const result = await handler({ sessionId: "s1", timeoutSeconds: 1, pollIntervalMs: 200 });
      const text = result.content[0].text;
      expect(text).toContain("Timeout");
      expect(text).toContain("opencode_conversation");
      expect(text).toContain("opencode_session_abort");
      expect(result.isError).toBe(true);
    });

    it("completes when string status is 'idle'", async () => {
      const getMock = vi.fn().mockImplementation((path: string) => {
        if (path === "/session/status") return Promise.resolve({ "s1": "idle" });
        if (path.includes("/message")) return Promise.resolve([
          { info: { id: "m1", role: "assistant" }, parts: [{ type: "text", text: "Result" }] },
        ]);
        return Promise.resolve({});
      });
      const mockClient = createMockClient({ get: getMock });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_wait")!;
      const result = await handler({ sessionId: "s1", timeoutSeconds: 5, pollIntervalMs: 50 });
      expect(result.content[0].text).toContain("Session completed");
    });

    it("returns 'no messages' when completed but message list is empty", async () => {
      const getMock = vi.fn().mockImplementation((path: string) => {
        if (path === "/session/status") return Promise.resolve({ "s1": "completed" });
        if (path.includes("/message")) return Promise.resolve([]);
        return Promise.resolve({});
      });
      const mockClient = createMockClient({ get: getMock });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_wait")!;
      const result = await handler({ sessionId: "s1", timeoutSeconds: 5, pollIntervalMs: 50 });
      expect(result.content[0].text).toContain("no messages");
    });
  });

  describe("opencode_run", () => {
    it("creates session, sends prompt, and polls until idle", async () => {
      let pollCount = 0;
      const mockClient = createMockClient({
        post: vi.fn().mockImplementation((path: string) => {
          if (path === "/session") return Promise.resolve({ id: "ses-run-1" });
          return Promise.resolve({ parts: [{ type: "text", text: "Done building!" }] });
        }),
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/session/status") {
            pollCount++;
            // First poll: running, second poll: idle
            return Promise.resolve({ "ses-run-1": pollCount >= 2 ? "idle" : "running" });
          }
          if (path.includes("/message")) return Promise.resolve([{ parts: [{ type: "text", text: "All tasks completed." }] }]);
          if (path.includes("/todo")) return Promise.resolve([
            { status: "completed", content: "Set up project" },
            { status: "completed", content: "Write tests" },
          ]);
          return Promise.resolve({});
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_run")!;
      const result = await handler({ prompt: "Build app", providerID: "anthropic", modelID: "claude-opus-4-6" });
      expect(result.content[0].text).toContain("ses-run-1");
      expect(result.content[0].text).toContain("completed");
      expect(result.content[0].text).toContain("2/2");
    });

    it("returns error status when session errors", async () => {
      const mockClient = createMockClient({
        post: vi.fn().mockImplementation((path: string) => {
          if (path === "/session") return Promise.resolve({ id: "ses-err" });
          return Promise.resolve({});
        }),
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/session/status") return Promise.resolve({ "ses-err": "error" });
          return Promise.resolve({});
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_run")!;
      const result = await handler({ prompt: "Bad task", maxDurationSeconds: 1 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("error");
    });

    it("reuses existing session when sessionId provided", async () => {
      const mockClient = createMockClient({
        post: vi.fn().mockResolvedValue({}),
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/session/status") return Promise.resolve({ "existing-ses": "idle" });
          if (path.includes("/message")) return Promise.resolve([{ parts: [{ type: "text", text: "Done" }] }]);
          if (path.includes("/todo")) return Promise.resolve([]);
          return Promise.resolve({});
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_run")!;
      const result = await handler({ prompt: "Continue work", sessionId: "existing-ses" });
      // Should NOT call POST /session to create a new one
      const postMock = mockClient.post as ReturnType<typeof vi.fn>;
      const sessionCreateCalls = postMock.mock.calls.filter((c: unknown[]) => c[0] === "/session");
      expect(sessionCreateCalls.length).toBe(0);
      expect(result.content[0].text).toContain("existing-ses");
    });
  });

  describe("opencode_fire", () => {
    it("creates session and returns immediately with monitoring instructions", async () => {
      const mockClient = createMockClient({
        post: vi.fn().mockImplementation((path: string) => {
          if (path === "/session") return Promise.resolve({ id: "ses-fire-1" });
          return Promise.resolve({});
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_fire")!;
      const result = await handler({ prompt: "Build everything", providerID: "anthropic", modelID: "claude-opus-4-6" });
      expect(result.content[0].text).toContain("ses-fire-1");
      expect(result.content[0].text).toContain("dispatched");
      expect(result.content[0].text).toContain("opencode_check");
    });

    it("reuses existing session when sessionId provided", async () => {
      const mockClient = createMockClient({
        post: vi.fn().mockResolvedValue({}),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_fire")!;
      const result = await handler({ prompt: "More work", sessionId: "ses-existing" });
      const postMock = mockClient.post as ReturnType<typeof vi.fn>;
      const sessionCreateCalls = postMock.mock.calls.filter((c: unknown[]) => c[0] === "/session");
      expect(sessionCreateCalls.length).toBe(0);
      expect(result.content[0].text).toContain("ses-existing");
    });
  });

  describe("opencode_check", () => {
    it("returns compact progress report with status and todos", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/session/status") return Promise.resolve({ "ses-chk": { state: "running" } });
          if (path.includes("/todo")) return Promise.resolve([
            { status: "completed", content: "Setup" },
            { status: "in_progress", content: "Build UI" },
            { status: "pending", content: "Write tests" },
          ]);
          if (path.includes("/diff")) return Promise.resolve([{ path: "src/App.tsx" }, { path: "src/index.ts" }]);
          if (path === "/session/ses-chk") return Promise.resolve({ title: "Build App", id: "ses-chk" });
          return Promise.resolve({});
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_check")!;
      const result = await handler({ sessionId: "ses-chk" });
      const text = result.content[0].text;
      expect(text).toContain("Build App");
      expect(text).toContain("running");
      expect(text).toContain("1/3 completed");
      expect(text).toContain("1 in progress");
      expect(text).toContain("Build UI"); // current task
      expect(text).toContain("Files changed: 2");
    });

    it("shows completion message when session is idle", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/session/status") return Promise.resolve({ "ses-done": "idle" });
          if (path.includes("/todo")) return Promise.resolve([]);
          if (path.includes("/diff")) return Promise.resolve([]);
          if (path === "/session/ses-done") return Promise.resolve({ title: "Finished", id: "ses-done" });
          return Promise.resolve({});
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_check")!;
      const result = await handler({ sessionId: "ses-done" });
      const text = result.content[0].text;
      expect(text).toContain("idle");
      expect(text).toContain("Done!");
      expect(text).toContain("opencode_review_changes");
    });

    it("includes last message when detailed=true", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/session/status") return Promise.resolve({ "ses-d": "idle" });
          if (path.includes("/todo")) return Promise.resolve([]);
          if (path.includes("/message")) return Promise.resolve([{ parts: [{ type: "text", text: "Build complete! All tests pass." }] }]);
          if (path.includes("/diff")) return Promise.resolve([]);
          if (path === "/session/ses-d") return Promise.resolve({ title: "Detail test", id: "ses-d" });
          return Promise.resolve({});
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_check")!;
      const result = await handler({ sessionId: "ses-d", detailed: true });
      const text = result.content[0].text;
      expect(text).toContain("Build complete!");
      expect(text).toContain("Last message");
    });
  });

  describe("opencode_status", () => {
    it("returns combined dashboard with all sections", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/global/health") return Promise.resolve({ version: "1.1.53" });
          if (path === "/provider") return Promise.resolve({ all: [
            { id: "anthropic", source: "env", models: [] },
            { id: "groq", source: "custom", options: {}, models: [] },
          ]});
          if (path === "/session") return Promise.resolve([{ id: "s1" }, { id: "s2" }, { id: "s3" }]);
          if (path === "/vcs") return Promise.resolve({ branch: "main", dirty: false });
          return Promise.resolve({});
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_status")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("## Status");
      expect(text).toContain("healthy");
      expect(text).toContain("1.1.53");
      expect(text).toContain("1 configured / 2 total");
      expect(text).toContain("Sessions: 3");
      expect(text).toContain("Branch: main (clean)");
    });

    it("handles partial failures gracefully", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/global/health") return Promise.resolve({ version: "1.0.0" });
          return Promise.reject(new Error("not available"));
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_status")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("healthy");
      // Other sections should just be missing, not cause errors
      expect(result.isError).toBeUndefined();
    });

    it("shows UNREACHABLE when health check fails", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_status")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("UNREACHABLE");
    });

    it("shows dirty branch status", async () => {
      const mockClient = createMockClient({
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/global/health") return Promise.resolve({ version: "1.0.0" });
          if (path === "/vcs") return Promise.resolve({ branch: "feature-x", dirty: true });
          return Promise.reject(new Error("skip"));
        }),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);

      const handler = tools.get("opencode_status")!;
      const result = await handler({});
      expect(result.content[0].text).toContain("Branch: feature-x (dirty)");
    });
  });

  // ─── Directory validation: early fail before .catch(() => null) ──────
  describe("early directory validation in Promise.all tools", () => {
    // These tools use Promise.all with .catch(() => null) which previously
    // swallowed directory validation errors. The fix validates directory
    // BEFORE the Promise.all so the error reaches toolError().

    function setupTools() {
      const mockClient = createMockClient({
        get: vi.fn().mockResolvedValue({}),
      });
      const tools = new Map<string, Function>();
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          tools.set(args[0] as string, args[args.length - 1] as Function);
        }),
      } as unknown as McpServer;
      registerWorkflowTools(mockServer, mockClient);
      return { tools, client: mockClient };
    }

    it("opencode_status returns directory error for non-existent path", async () => {
      const { tools, client } = setupTools();
      const handler = tools.get("opencode_status")!;
      const result = await handler({ directory: "/this/does/not/exist/at/all" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("does not exist");
      // Should NOT show UNREACHABLE — that was the bug
      expect(result.content[0].text).not.toContain("UNREACHABLE");
      // client.get should never be called
      expect((client as any).get).not.toHaveBeenCalled();
    });

    it("opencode_status returns directory error for relative path", async () => {
      const { tools, client } = setupTools();
      const handler = tools.get("opencode_status")!;
      // resolve("./relative") produces an absolute path, so this will be
      // a "does not exist" error rather than "not absolute". That's fine —
      // the point is we get a clear error, not UNREACHABLE.
      const result = await handler({ directory: "./nonexistent-dir" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("does not exist");
      expect(result.content[0].text).not.toContain("UNREACHABLE");
    });

    it("opencode_context returns directory error for non-existent path", async () => {
      const { tools, client } = setupTools();
      const handler = tools.get("opencode_context")!;
      const result = await handler({ directory: "/no/such/directory" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("does not exist");
      expect((client as any).get).not.toHaveBeenCalled();
    });

    it("opencode_check returns directory error for non-existent path", async () => {
      const { tools, client } = setupTools();
      const handler = tools.get("opencode_check")!;
      const result = await handler({
        sessionId: "test-session-id",
        directory: "/no/such/directory",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("does not exist");
      expect((client as any).get).not.toHaveBeenCalled();
    });

    it("opencode_status works with valid directory (no false positives)", async () => {
      const { tools } = setupTools();
      const handler = tools.get("opencode_status")!;
      // /tmp always exists
      const result = await handler({ directory: "/tmp" });
      expect(result.isError).toBeUndefined();
    });

    it("opencode_status works with undefined directory (no-op)", async () => {
      const { tools } = setupTools();
      const handler = tools.get("opencode_status")!;
      const result = await handler({});
      expect(result.isError).toBeUndefined();
    });
  });
});
