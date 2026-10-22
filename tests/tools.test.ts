import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCodeClient, OpenCodeError } from "../src/client.js";
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
  const tools = new Map<string, { description: string; schema: unknown; handler: Function }>();
  const mockServer = {
    tool: vi.fn((...args: unknown[]) => {
      // Handle both 4-arg (name, desc, schema, handler) and
      // 5-arg (name, desc, schema, annotations, handler) forms
      const name = args[0] as string;
      const description = args[1] as string;
      const schema = args[2];
      const handler = args[args.length - 1] as Function;
      tools.set(name, { description, schema, handler });
    }),
  } as unknown as McpServer;
  const mockClient = createMockClient();
  registerFn(mockServer, mockClient);
  return { tools, server: mockServer, client: mockClient };
}

/** Register tools against a given client and return name → handler. */
function handlersFor(
  registerFn: (server: McpServer, client: OpenCodeClient) => void,
  client: OpenCodeClient,
) {
  const tools = new Map<string, Function>();
  const mockServer = {
    tool: vi.fn((...args: unknown[]) => {
      tools.set(args[0] as string, args[args.length - 1] as Function);
    }),
  } as unknown as McpServer;
  registerFn(mockServer, client);
  return tools;
}

// ─── OpenCode 2.x fixtures ───────────────────────────────────────────────
// Shapes follow the OpenCode 2.1.2 OpenAPI spec (components/schemas). The
// real client unwraps `{ data, location? }` envelopes, so the mocked client
// returns the inner payloads.

const T0 = 1_792_670_525_000;

/** Session.Message.User */
function userMessage(id: string, text = "prompt", created = T0) {
  return { id, time: { created }, type: "user", text };
}

/** Session.Message.Assistant */
function assistantMessage(
  id: string,
  content: unknown[],
  created = T0 + 100,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    time: { created, completed: created + 50 },
    type: "assistant",
    agent: "build",
    model: { id: "claude-sonnet-4", providerID: "anthropic" },
    content,
    finish: "stop",
    ...extra,
  };
}

/** Session.Message.Idle — closes a turn. */
function idleMessage(
  id: string,
  outcome: "succeeded" | "failed" | "interrupted" = "succeeded",
  created = T0 + 200,
  error?: { type: string; message: string },
) {
  return { id, time: { created }, type: "idle", outcome, ...(error ? { error } : {}) };
}

/** Session.Inbox.User — the response of POST /api/session/{id}/prompt. */
function promptAck(id: string, sessionID: string, text = "prompt") {
  return { id, sessionID, time: { created: T0 }, type: "user", payload: { text }, delivery: "queue" };
}

/** Session.Info */
function sessionInfo(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    projectID: "prj_test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: T0, updated: T0 },
    location: { directory: "/home/user/project" },
    ...extra,
  };
}

/** Provider.Info */
function providerInfo(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    integrationID: id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    activation: "auto",
    package: "@opencode/ai/providers/openai-compatible",
    ...extra,
  };
}

/** Credential.Entry */
function credentialEntry(integrationID: string, active = true, value: Record<string, unknown> = { type: "key", key: "test-key" }) {
  return { id: `cred_${integrationID}`, integrationID, label: "API key", active, value };
}

/** Model.Info (trimmed to the fields the tools read). */
function modelInfo(providerID: string, id: string, extra: Record<string, unknown> = {}) {
  return { id, modelID: id, providerID, name: id, status: "active", enabled: true, variants: [], ...extra };
}

const textPart = (text: string) => ({ type: "text", text });

/** GET /api/session/{id}/message returns messages newest-first. */
const newestFirst = (messages: unknown[]) => [...messages].reverse();

/**
 * GET mock routed by exact path. Unknown paths reject so a tool reading the
 * wrong endpoint fails loudly (tools that tolerate failures `.catch()` it).
 */
function routes(table: Record<string, unknown>) {
  return vi.fn(async (path: string) => {
    if (Object.prototype.hasOwnProperty.call(table, path)) {
      const value = table[path];
      if (value instanceof Error) throw value;
      return value;
    }
    throw new Error(`unexpected GET ${path}`);
  });
}

/**
 * Client for the v2 prompt flow used by ask/reply/provider_test/message_send:
 * POST /api/session → POST /prompt (queued user message) → POST wait →
 * GET /message (newest-first).
 */
function promptFlowClient(opts: {
  sessionId?: string;
  ack?: unknown;
  turn?: unknown[];
  get?: (path: string) => unknown;
  delete?: ReturnType<typeof vi.fn>;
} = {}) {
  const sessionId = opts.sessionId ?? "ses_1";
  const ack = opts.ack === undefined ? promptAck("msg_user", sessionId) : opts.ack;
  const turn = opts.turn ?? [
    userMessage("msg_user"),
    assistantMessage("msg_asst", [textPart("Here is the answer")]),
    idleMessage("msg_idle"),
  ];
  return createMockClient({
    post: vi.fn(async (path: string) => {
      if (path === "/api/session") return sessionInfo(sessionId);
      if (path.endsWith("/prompt")) return ack;
      return undefined; // wait, model switch
    }),
    get: vi.fn(async (path: string) => {
      const custom = opts.get?.(path);
      if (custom !== undefined) return custom;
      if (path.endsWith("/message")) return newestFirst(turn);
      throw new Error(`unexpected GET ${path}`);
    }),
    ...(opts.delete ? { delete: opts.delete } : {}),
  });
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
    it("registers 16 session tools", () => {
      const { tools } = captureTools(registerSessionTools);
      expect(tools.size).toBe(16);
      expect(tools.has("opencode_session_list")).toBe(true);
      expect(tools.has("opencode_session_create")).toBe(true);
      expect(tools.has("opencode_session_delete")).toBe(true);
      expect(tools.has("opencode_session_diff")).toBe(true);
      expect(tools.has("opencode_session_fork")).toBe(true);
      expect(tools.has("opencode_session_abort")).toBe(true);
      expect(tools.has("opencode_permission_list")).toBe(true);
      expect(tools.has("opencode_session_permission")).toBe(true);
      // OpenCode 2.x has no share/unshare/init routes.
      expect(tools.has("opencode_session_share")).toBe(false);
      expect(tools.has("opencode_session_unshare")).toBe(false);
      expect(tools.has("opencode_session_init")).toBe(false);
    });
  });

  describe("registerMessageTools", () => {
    it("does not expose model or variant parameters on shell execution", () => {
      // v2 POST /api/session/{id}/shell accepts only { id?, command }.
      const { tools } = captureTools(registerMessageTools);
      const shell = tools.get("opencode_shell_execute")!;
      const schema = shell.schema as Record<string, unknown>;
      expect(schema).toHaveProperty("command");
      expect(schema).not.toHaveProperty("providerID");
      expect(schema).not.toHaveProperty("modelID");
      expect(schema).not.toHaveProperty("variant");
    });
  });

  describe("registerFileTools", () => {
    it("registers 5 file tools", () => {
      const { tools } = captureTools(registerFileTools);
      expect(tools.size).toBe(5);
      expect(tools.has("opencode_find_text")).toBe(true);
      expect(tools.has("opencode_find_file")).toBe(true);
      expect(tools.has("opencode_file_list")).toBe(true);
      expect(tools.has("opencode_file_read")).toBe(true);
      expect(tools.has("opencode_file_status")).toBe(true);
      // OpenCode 2.x has no symbol search route.
      expect(tools.has("opencode_find_symbol")).toBe(false);
    });
  });

  describe("registerProjectTools", () => {
    it("registers 3 project tools", () => {
      const { tools } = captureTools(registerProjectTools);
      expect(tools.size).toBe(3);
      expect(tools.has("opencode_project_list")).toBe(true);
      expect(tools.has("opencode_project_init")).toBe(true);
      expect(tools.has("opencode_project_current")).toBe(true);
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
        get: vi.fn().mockResolvedValue({ version: "2.1.2", pid: 42, urls: ["http://127.0.0.1:4096"], paths: { tmp: "/tmp" } }),
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
      expect(result.content[0].text).toContain("2.1.2");
      expect(result.content[0].text).toContain("http://127.0.0.1:4096");
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
      mockClient = promptFlowClient();
      handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_ask")!;
    });

    it("creates session, sends prompt, waits, and returns the answer", async () => {
      const result = await handler({ prompt: "What is this project?" });
      expect(result.content[0].text).toContain("ses_1");
      expect(result.content[0].text).toContain("Here is the answer");
      const paths = (mockClient.post as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
      expect(paths).toEqual([
        "/api/session",
        "/api/session/ses_1/prompt",
        "/api/experimental/session/ses_1/wait",
      ]);
      expect(mockClient.get).toHaveBeenCalledWith("/api/session/ses_1/message", { limit: "100" }, undefined, {});
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

    it("binds the model to the new session when providerID and modelID are set", async () => {
      await handler({
        prompt: "test",
        providerID: "anthropic",
        modelID: "claude-3",
      });
      const calls = (mockClient.post as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][1].model).toEqual({ id: "claude-3", providerID: "anthropic" });
      // v2 prompts do not carry a model.
      expect(calls[1][1]).not.toHaveProperty("model");
    });

    it("sends variant inside the session model ref", async () => {
      await handler({
        prompt: "test",
        providerID: "openai",
        modelID: "gpt-5.4",
        variant: "xhigh",
      });
      const calls = (mockClient.post as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][1].model).toEqual({ id: "gpt-5.4", providerID: "openai", variant: "xhigh" });
      expect(calls[1][1]).not.toHaveProperty("variant");
      expect(calls[1][1]).not.toHaveProperty("model");
    });

    it("includes agent when set", async () => {
      await handler({ prompt: "test", agent: "build" });
      const [path, body] = (mockClient.post as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(path).toBe("/api/session/ses_1/prompt");
      expect(body).toEqual({ text: "test", agent: "build" });
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
      // The turn produced neither an assistant message nor an idle marker.
      const emptyClient = promptFlowClient({ sessionId: "ses_2", turn: [userMessage("msg_user")] });
      const askHandler = handlersFor(registerWorkflowTools, emptyClient).get("opencode_ask")!;
      const result = await askHandler({ prompt: "test" });
      expect(result.content[0].text).toContain("WARNING");
      expect(result.content[0].text).toContain("empty response");
    });

    it("warns when response has no text content", async () => {
      const noTextClient = promptFlowClient({
        sessionId: "ses_3",
        turn: [userMessage("msg_user"), assistantMessage("msg_asst", []), idleMessage("msg_idle")],
      });
      const askHandler = handlersFor(registerWorkflowTools, noTextClient).get("opencode_ask")!;
      const result = await askHandler({ prompt: "test" });
      expect(result.content[0].text).toContain("WARNING");
      expect(result.content[0].text).toContain("no text content");
    });

    it("flags a failed run from the idle marker", async () => {
      const failedClient = promptFlowClient({
        turn: [
          userMessage("msg_user"),
          idleMessage("msg_idle", "failed", T0 + 200, { type: "ProviderAuthError", message: "Invalid API key" }),
        ],
      });
      const askHandler = handlersFor(registerWorkflowTools, failedClient).get("opencode_ask")!;
      const result = await askHandler({ prompt: "test" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("WARNING");
      expect(result.content[0].text).toContain("Invalid API key");
    });

    it("ignores messages from earlier turns", async () => {
      const client = promptFlowClient({
        turn: [
          userMessage("msg_old", "old", T0 - 1000),
          assistantMessage("msg_old_asst", [textPart("Old answer")], T0 - 900),
          idleMessage("msg_old_idle", "succeeded", T0 - 800),
          userMessage("msg_user"),
          assistantMessage("msg_asst", [textPart("New answer")]),
          idleMessage("msg_idle"),
        ],
      });
      const askHandler = handlersFor(registerWorkflowTools, client).get("opencode_ask")!;
      const result = await askHandler({ prompt: "test" });
      expect(result.content[0].text).toContain("New answer");
      expect(result.content[0].text).not.toContain("Old answer");
    });

    it("does not warn for valid response", async () => {
      const result = await handler({ prompt: "What is this project?" });
      expect(result.content[0].text).not.toContain("WARNING");
      expect(result.isError).toBeFalsy();
    });
  });

  describe("opencode_reply", () => {
    it("warns when reply response is empty", async () => {
      const emptyClient = promptFlowClient({ ack: null, turn: [] });
      const handler = handlersFor(registerWorkflowTools, emptyClient).get("opencode_reply")!;
      const result = await handler({ sessionId: "s1", prompt: "follow up" });
      expect(result.content[0].text).toContain("WARNING");
      expect(result.content[0].text).toContain("empty response");
    });

    it("does not warn for valid reply", async () => {
      const goodClient = promptFlowClient({
        sessionId: "s1",
        turn: [userMessage("msg_user"), assistantMessage("m2", [textPart("Sure, here you go")]), idleMessage("msg_idle")],
      });
      const handler = handlersFor(registerWorkflowTools, goodClient).get("opencode_reply")!;
      const result = await handler({ sessionId: "s1", prompt: "follow up" });
      expect(result.content[0].text).toContain("Sure, here you go");
      expect(result.content[0].text).not.toContain("WARNING");
      // Replies must not create a session.
      const paths = (goodClient.post as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
      expect(paths).not.toContain("/api/session");
    });

    it("switches the session model (with variant) before prompting", async () => {
      const mockClient = promptFlowClient({ sessionId: "s1" });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_reply")!;
      await handler({
        sessionId: "s1",
        prompt: "follow up",
        providerID: "openai",
        modelID: "gpt-5.4",
        variant: "low",
      });
      const calls = (mockClient.post as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][0]).toBe("/api/session/s1/model");
      expect(calls[0][1]).toEqual({ model: { id: "gpt-5.4", providerID: "openai", variant: "low" } });
      expect(calls[1][0]).toBe("/api/session/s1/prompt");
      expect(calls[1][1]).toEqual({ text: "follow up" });
    });

    it("applies a variant to the session's current model when no model is given", async () => {
      const mockClient = promptFlowClient({
        sessionId: "s1",
        get: (path) => path === "/api/session/s1"
          ? sessionInfo("s1", { model: { id: "gpt-5.4", providerID: "openai" } })
          : undefined,
      });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_reply")!;
      await handler({ sessionId: "s1", prompt: "follow up", variant: "high" });
      expect(mockClient.post).toHaveBeenCalledWith(
        "/api/session/s1/model",
        { model: { id: "gpt-5.4", providerID: "openai", variant: "high" } },
        { directory: undefined },
      );
    });
  });

  describe("opencode_context", () => {
    it("fetches all context data in parallel", async () => {
      const mockClient = createMockClient({
        get: routes({
          "/api/location": {
            directory: "/home/dev/my-project",
            project: { id: "prj_abc123", directory: "/home/dev/my-project", canonical: "/home/dev/my-project" },
          },
          "/api/vcs": { provider: "git", branch: { current: "main", default: "main" } },
          "/api/config": [{ type: "document", path: "/home/dev/my-project/opencode.json", info: { theme: "dark" } }],
          "/api/agent": [
            { id: "build", name: "build", description: "Build agent", mode: "primary", hidden: false, request: {}, permissions: [] },
            { id: "title", name: "title", description: "Title generator", mode: "subagent", hidden: true, request: {}, permissions: [] },
          ],
        }),
      });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_context")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("prj_abc123");
      expect(text).toContain("/home/dev/my-project");
      expect(text).toContain("Branch: main");
      expect(text).toContain("opencode.json");
      expect(text).toContain("Agents (1)");
      expect(text).toContain("build: Build agent [primary]");
      expect(text).not.toContain("Title generator");
    });

    it("handles partial failures gracefully", async () => {
      const mockClient = createMockClient({
        get: routes({
          "/api/location": { directory: "/srv/proj", project: { id: "prj_1", directory: "/srv/proj", canonical: "/srv/proj" } },
        }),
      });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_context")!;
      const result = await handler({});
      // Should not error out — partial results are ok
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("/srv/proj");
      expect(result.content[0].text).not.toContain("## VCS");
    });
  });

  describe("opencode_setup", () => {
    it("shows 'Ready to use' for providers with an active credential and context-dependent next steps", async () => {
      const mockClient = createMockClient({
        get: routes({
          "/api/info": { version: "2.1.2", pid: 1, urls: [], paths: { tmp: "/tmp" } },
          "/api/provider": [
            providerInfo("huggingface", { name: "Hugging Face" }),
            providerInfo("openai", { name: "OpenAI" }),
            providerInfo("anthropic", { name: "Anthropic" }),
          ],
          "/api/credential": [credentialEntry("huggingface")],
          "/api/integration": [
            {
              id: "openai", name: "OpenAI", connections: [],
              methods: [{ type: "key" }, { type: "env", names: ["OPENAI_API_KEY"] }, { id: "chatgpt-browser", type: "oauth", label: "Sign in with ChatGPT" }],
            },
            { id: "anthropic", name: "Anthropic", connections: [], methods: [{ type: "key" }, { type: "env", names: ["ANTHROPIC_API_KEY"] }] },
          ],
          "/api/model": [modelInfo("huggingface", "meta-llama"), modelInfo("anthropic", "claude-sonnet-4")],
          "/api/location": { directory: "/home/user/my-app", project: { id: "my-app", directory: "/home/user/my-app", canonical: "/home/user/my-app" } },
        }),
      });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_setup")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("healthy");
      expect(text).toContain("2.1.2");
      expect(text).toContain("Ready to use");
      expect(text).toContain("huggingface (Hugging Face): 1 models");
      expect(text).toContain("Quick setup options");
      expect(text).toContain("Sign in with ChatGPT");
      expect(text).toContain("OPENAI_API_KEY");
      expect(text).toContain("ANTHROPIC_API_KEY");
      expect(text).toContain("my-app");
      // Has a ready provider (huggingface), so next steps should say "ready to go"
      expect(text).toContain("ready to go");
      expect(text).toContain("Next Steps");
    });

    it("shows 'No providers configured' and setup guidance when none have credentials", async () => {
      const mockClient = createMockClient({
        get: routes({
          "/api/info": { version: "2.1.2" },
          "/api/provider": [providerInfo("google", { name: "Google" })],
          "/api/credential": [],
          "/api/integration": [],
          "/api/model": [modelInfo("google", "gemini-2.5-flash")],
          "/api/location": { directory: "/srv/proj", project: { id: "proj", directory: "/srv/proj", canonical: "/srv/proj" } },
        }),
      });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_setup")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("No providers configured yet");
      expect(text).toContain("+1 more providers available");
      // Next steps should guide to configure a provider
      expect(text).toContain("You need to configure a provider first");
      expect(text).toContain("opencode_auth_set");
    });

    it("detects an active OAuth credential as configured", async () => {
      const mockClient = createMockClient({
        get: routes({
          "/api/info": { version: "2.1.2" },
          "/api/provider": [providerInfo("anthropic", { name: "Anthropic" })],
          "/api/credential": [credentialEntry("anthropic", true, { type: "oauth", methodID: "claude-pro", refresh: "r", access: "a", expires: 0 })],
          "/api/integration": [],
          "/api/model": [modelInfo("anthropic", "claude-3")],
          "/api/location": { directory: "/srv/proj", project: { id: "proj", directory: "/srv/proj", canonical: "/srv/proj" } },
        }),
      });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_setup")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("Ready to use");
      expect(text).toContain("anthropic (Anthropic): 1 models");
      expect(text).toContain("ready to go");
    });

    it("does NOT treat an inactive credential or empty apiKey as configured", async () => {
      const mockClient = createMockClient({
        get: routes({
          "/api/info": { version: "2.1.2" },
          "/api/provider": [
            providerInfo("groq", { name: "Groq", settings: { apiKey: "" } }),
            providerInfo("mistral", { name: "Mistral" }),
          ],
          "/api/credential": [credentialEntry("mistral", false)],
          "/api/integration": [],
          "/api/model": [],
          "/api/location": { directory: "/srv/proj", project: { id: "proj", directory: "/srv/proj", canonical: "/srv/proj" } },
        }),
      });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_setup")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("No providers configured yet");
      expect(text).toContain("You need to configure a provider first");
    });

    it("treats a provider with settings.apiKey as configured", async () => {
      const mockClient = createMockClient({
        get: routes({
          "/api/info": { version: "2.1.2" },
          "/api/provider": [providerInfo("opencode", { name: "OpenCode", activation: "enabled", settings: { apiKey: "public" } })],
          "/api/credential": [],
          "/api/integration": [],
          "/api/model": [modelInfo("opencode", "big-pickle")],
          "/api/location": new Error("no location"),
        }),
      });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_setup")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("1 available");
      expect(text).toContain("opencode (OpenCode): 1 models");
      expect(text).toContain("No project context available");
      // No project → suggest passing a directory
      expect(text).toContain("Pass a `directory` parameter");
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
        get: routes({
          "/api/provider": [
            providerInfo("anthropic"),
            providerInfo("opencode", { activation: "enabled", settings: { apiKey: "public" } }),
            providerInfo("google"),
            providerInfo("groq"), // no credential, no apiKey = NOT configured
          ],
          "/api/credential": [credentialEntry("anthropic"), credentialEntry("google")],
        }),
      });
      const handler = handlersFor(registerProviderTools, mockClient).get("opencode_provider_list")!;
      const result = await handler({});
      const text = result.content[0].text;
      // Should be compact with configured first — no model IDs dumped
      expect(text).toContain("**Configured:**");
      expect(text).toContain("- anthropic [auto]");
      expect(text).toContain("- opencode [enabled]"); // settings.apiKey="public" IS configured
      expect(text).toContain("- google [auto]");
      expect(text).toContain("3 configured / 4 total");
      expect(text).toContain("**Not configured:**");
      expect(text).toContain("- groq");
      expect(text).toContain("opencode_provider_models");
      // Must NOT fetch or dump models
      expect(mockClient.get).not.toHaveBeenCalledWith("/api/model", undefined, undefined);
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
    const providers = [providerInfo("anthropic"), providerInfo("openai")];
    const models = [
      modelInfo("anthropic", "claude-3", { name: "Claude 3" }),
      modelInfo("anthropic", "claude-4", { name: "Claude 4" }),
      modelInfo("openai", "gpt-4"),
    ];

    it("lists models for a provider", async () => {
      const mockClient = createMockClient({
        get: routes({ "/api/model": models, "/api/provider": providers }),
      });
      const handler = handlersFor(registerProviderTools, mockClient).get("opencode_provider_models")!;
      const result = await handler({ providerId: "anthropic" });
      const text = result.content[0].text;
      expect(text).toContain("## anthropic — 2 models");
      expect(text).toContain("claude-3 — Claude 3");
      expect(text).toContain("claude-4 — Claude 4");
      // Should NOT contain other provider models
      expect(text).not.toContain("gpt-4");
    });

    it("returns error for unknown provider", async () => {
      const mockClient = createMockClient({
        get: routes({ "/api/model": models, "/api/provider": providers }),
      });
      const handler = handlersFor(registerProviderTools, mockClient).get("opencode_provider_models")!;
      const result = await handler({ providerId: "nonexistent" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
      expect(result.content[0].text).toContain("anthropic");
    });

    it("truncates long model lists to the limit", async () => {
      const mockClient = createMockClient({
        get: routes({ "/api/model": models, "/api/provider": providers }),
      });
      const handler = handlersFor(registerProviderTools, mockClient).get("opencode_provider_models")!;
      const result = await handler({ providerId: "anthropic", limit: 1 });
      const text = result.content[0].text;
      expect(text).toContain("claude-3");
      expect(text).not.toContain("claude-4");
      expect(text).toContain("... and 1 more");
    });

    it("reports a known provider without models", async () => {
      const mockClient = createMockClient({
        get: routes({ "/api/model": [], "/api/provider": providers }),
      });
      const handler = handlersFor(registerProviderTools, mockClient).get("opencode_provider_models")!;
      const result = await handler({ providerId: "openai" });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Provider "openai" has no models available.');
    });
  });

  describe("opencode_file_list", () => {
    it("omits path when not provided (server defaults to the location directory)", async () => {
      const getMock = vi.fn().mockResolvedValue([
        { path: "src", type: "directory" },
        { path: "package.json", type: "file" },
      ]);
      const mockClient = createMockClient({ get: getMock });
      const handler = handlersFor(registerFileTools, mockClient).get("opencode_file_list")!;
      const result = await handler({});
      expect(getMock).toHaveBeenCalledWith("/api/fs/list", {}, undefined);
      expect(result.content[0].text).toContain("[DIR] src");
      expect(result.content[0].text).toContain("package.json");
    });

    it("uses provided path", async () => {
      const getMock = vi.fn().mockResolvedValue([]);
      const mockClient = createMockClient({ get: getMock });
      const handler = handlersFor(registerFileTools, mockClient).get("opencode_file_list")!;
      const result = await handler({ path: "src" });
      expect(getMock).toHaveBeenCalledWith("/api/fs/list", { path: "src" }, undefined);
      expect(result.content[0].text).toBe("Empty directory.");
    });
  });

  describe("opencode_find_text", () => {
    it("formats FileSystem.Entry results without [object Object]", async () => {
      const getMock = vi.fn().mockResolvedValue([
        { path: "src/index.ts", type: "file" },
        { path: "src/tools", type: "directory" },
      ]);
      const mockClient = createMockClient({ get: getMock });
      const handler = handlersFor(registerFileTools, mockClient).get("opencode_find_text")!;
      const result = await handler({ pattern: "src" });
      const text = result.content[0].text;
      expect(getMock).toHaveBeenCalledWith("/api/fs/find", { query: "src" }, undefined);
      expect(text).not.toContain("[object Object]");
      expect(text).toContain("2 match(es)");
      expect(text).toContain("src/index.ts");
      expect(text).toContain("[DIR] src/tools");
    });

    it("returns friendly message for empty results", async () => {
      const mockClient = createMockClient({ get: vi.fn().mockResolvedValue([]) });
      const handler = handlersFor(registerFileTools, mockClient).get("opencode_find_text")!;
      const result = await handler({ pattern: "nothing" });
      expect(result.content[0].text).toBe("No matches found for pattern: nothing");
      expect(result.content[0].text).not.toContain("[]");
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

    it("formats running sessions and last outcomes as a list", async () => {
      const mockClient = createMockClient({
        get: routes({
          "/api/session/active": { "ses_1": { type: "running" } },
          "/api/session": [
            sessionInfo("ses_1", { title: "Building" }),
            sessionInfo("ses_2", { title: "Done task", outcome: "succeeded" }),
            sessionInfo("ses_3"), // never ran: no outcome, not listed
          ],
        }),
      });
      const handler = handlersFor(registerSessionTools, mockClient).get("opencode_session_status")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("## Session Status");
      expect(text).toContain("ses_1: running (Building)");
      expect(text).toContain("ses_2: succeeded (Done task)");
      expect(text).not.toContain("ses_3");
      expect(result.structuredContent.data.running).toEqual(["ses_1"]);
    });
  });

  describe("opencode_provider_models error (N6 fix)", () => {
    it("truncates provider list in error message to first 10", async () => {
      // Create 20 providers
      const providers = Array.from({ length: 20 }, (_, i) => providerInfo(`provider-${i}`));
      const mockClient = createMockClient({
        get: routes({ "/api/model": [], "/api/provider": providers }),
      });
      const handler = handlersFor(registerProviderTools, mockClient).get("opencode_provider_models")!;
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

  describe("opencode_provider_list (N5 fix — credential detection)", () => {
    it("matches credentials by integrationID and ignores inactive ones", async () => {
      const mockClient = createMockClient({
        get: routes({
          "/api/provider": [
            providerInfo("anthropic"),
            // provider ID differs from its integration ID
            providerInfo("zai-coding", { integrationID: "zai" }),
            providerInfo("groq"),
          ],
          "/api/credential": [
            credentialEntry("anthropic", true, { type: "oauth", methodID: "claude-pro", refresh: "r", access: "a", expires: 0 }),
            credentialEntry("zai"),
            credentialEntry("groq", false), // inactive = NOT configured
          ],
        }),
      });
      const handler = handlersFor(registerProviderTools, mockClient).get("opencode_provider_list")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("2 configured / 3 total");
      expect(text).toContain("**Configured:**");
      expect(text).toContain("- anthropic");
      expect(text).toContain("- zai-coding");
      expect(text).toContain("**Not configured:** 1 more providers available");
    });
  });

  describe("opencode_config_providers (compact)", () => {
    it("returns compact summary instead of full model specs", async () => {
      const mockClient = createMockClient({
        get: routes({
          "/api/provider": [
            providerInfo("anthropic", { name: "Anthropic", activation: "enabled" }),
            providerInfo("openai", { name: "OpenAI" }),
          ],
          "/api/model": [
            modelInfo("anthropic", "claude-3"),
            modelInfo("anthropic", "claude-4"),
            modelInfo("openai", "gpt-4"),
          ],
          "/api/model/default": modelInfo("anthropic", "claude-3"),
        }),
      });
      const handler = handlersFor(registerConfigTools, mockClient).get("opencode_config_providers")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("Configured Providers (2)");
      expect(text).toContain("anthropic (Anthropic [enabled]): 2 models");
      expect(text).toContain("openai (OpenAI [auto]): 1 model");
      expect(text).toContain("Default model: anthropic/claude-3");
      expect(text).toContain("opencode_provider_models");
    });
  });

  describe("directory parameter propagation", () => {
    it("passes directory to client.get in opencode_health", async () => {
      const getMock = vi.fn().mockResolvedValue({ version: "2.1.2" });
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
      expect(getMock).toHaveBeenCalledWith("/api/info", undefined, "/home/user/project-a");
    });

    it("binds the session location and scopes the turn requests in opencode_ask", async () => {
      const mockClient = promptFlowClient({ sessionId: "s1" });
      const postMock = mockClient.post as ReturnType<typeof vi.fn>;
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_ask")!;
      await handler({ prompt: "hello", directory: "/srv/web-app" });
      // v2 binds a new session to its location through the request body.
      expect(postMock.mock.calls[0][0]).toBe("/api/session");
      expect(postMock.mock.calls[0][1].location).toEqual({ directory: "/srv/web-app" });
      // Prompt and wait are scoped with the x-opencode-directory header.
      expect(postMock.mock.calls[1][2]).toEqual({ directory: "/srv/web-app" });
      expect(postMock.mock.calls[2][2]).toEqual(expect.objectContaining({ directory: "/srv/web-app" }));
      expect(mockClient.get).toHaveBeenCalledWith("/api/session/s1/message", { limit: "100" }, "/srv/web-app", {});
    });

    it("passes undefined directory when not provided", async () => {
      const getMock = vi.fn().mockResolvedValue({ version: "2.1.2" });
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
      expect(getMock).toHaveBeenCalledWith("/api/info", undefined, undefined);
    });
  });

  describe("opencode_message_send (R5-B1 fix)", () => {
    it("warns when response is empty (null)", async () => {
      const mockClient = promptFlowClient({ sessionId: "s1", ack: null, turn: [] });
      const handler = handlersFor(registerMessageTools, mockClient).get("opencode_message_send")!;
      const result = await handler({ sessionId: "s1", text: "hello" });
      expect(result.content[0].text).toContain("WARNING");
      expect(result.content[0].text).toContain("empty response");
    });

    it("warns when response has no text content", async () => {
      const mockClient = promptFlowClient({
        sessionId: "s1",
        turn: [userMessage("msg_user"), assistantMessage("msg_asst", []), idleMessage("msg_idle")],
      });
      const handler = handlersFor(registerMessageTools, mockClient).get("opencode_message_send")!;
      const result = await handler({ sessionId: "s1", text: "hello" });
      expect(result.content[0].text).toContain("WARNING");
      expect(result.content[0].text).toContain("no text content");
    });

    it("does not warn for valid response with text", async () => {
      const mockClient = promptFlowClient({ sessionId: "s1" });
      const handler = handlersFor(registerMessageTools, mockClient).get("opencode_message_send")!;
      const result = await handler({ sessionId: "s1", text: "hello" });
      expect(result.content[0].text).toContain("Here is the answer");
      expect(result.content[0].text).not.toContain("WARNING");
      const paths = (mockClient.post as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
      expect(paths).toEqual(["/api/session/s1/prompt", "/api/experimental/session/s1/wait"]);
    });

    it("flags a failed run from the idle marker", async () => {
      const mockClient = promptFlowClient({
        sessionId: "s1",
        turn: [
          userMessage("msg_user"),
          idleMessage("msg_idle", "failed", T0 + 200, { type: "ProviderAuthError", message: "Invalid API key" }),
        ],
      });
      const handler = handlersFor(registerMessageTools, mockClient).get("opencode_message_send")!;
      const result = await handler({ sessionId: "s1", text: "hello" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("The run failed");
      expect(result.content[0].text).toContain("Invalid API key");
    });

    it("uses the idle marker of the current turn, not an earlier failed turn", async () => {
      const mockClient = promptFlowClient({
        sessionId: "s1",
        turn: [
          userMessage("msg_old"),
          idleMessage("msg_old_idle", "failed", T0 + 50, { type: "ProviderAuthError", message: "Invalid API key" }),
          userMessage("msg_user"),
          assistantMessage("msg_asst", [textPart("Here is the answer")]),
          idleMessage("msg_idle"),
        ],
      });
      const handler = handlersFor(registerMessageTools, mockClient).get("opencode_message_send")!;
      const result = await handler({ sessionId: "s1", text: "hello" });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("Here is the answer");
      expect(result.content[0].text).not.toContain("The run failed");
    });

    it("switches the session model (with variant) before prompting", async () => {
      const mockClient = promptFlowClient({ sessionId: "s1" });
      const handler = handlersFor(registerMessageTools, mockClient).get("opencode_message_send")!;
      await handler({
        sessionId: "s1",
        text: "hello",
        providerID: "openai",
        modelID: "gpt-5.4",
        variant: "xhigh",
      });
      const calls = (mockClient.post as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0]).toEqual([
        "/api/session/s1/model",
        { model: { id: "gpt-5.4", providerID: "openai", variant: "xhigh" } },
        { directory: undefined },
      ]);
      expect(calls[1][0]).toBe("/api/session/s1/prompt");
      expect(calls[1][1]).toEqual({ text: "hello" });
    });

    it("returns 'Empty response.' when formatted output is empty string", async () => {
      const mockClient = promptFlowClient({ sessionId: "s1", ack: null, turn: [] });
      const handler = handlersFor(registerMessageTools, mockClient).get("opencode_message_send")!;
      const result = await handler({ sessionId: "s1", text: "hello" });
      // Should have the WARNING but also not be completely empty
      expect(result.content[0].text.length).toBeGreaterThan(0);
    });
  });

  describe("opencode_session_summarize (R5-B5 fix)", () => {
    it("has timeout warning in description", () => {
      const { tools } = captureTools(registerSessionTools);
      const tool = tools.get("opencode_session_summarize")!;
      expect(tool.description).toContain("long-running");
    });

    it("starts compaction via the v2 compact route", async () => {
      const mockClient = createMockClient();
      const handler = handlersFor(registerSessionTools, mockClient).get("opencode_session_summarize")!;
      const result = await handler({ id: "ses_1" });
      expect(mockClient.post).toHaveBeenCalledWith("/api/session/ses_1/compact", {}, { directory: undefined });
      expect(result.content[0].text).toContain("compaction started");
    });
  });

  // ─── New features ───────────────────────────────────────────────────

  describe("opencode_provider_test", () => {
    it("reports success when provider returns valid response", async () => {
      const deleteMock = vi.fn().mockResolvedValue(undefined);
      const mockClient = promptFlowClient({
        sessionId: "test-session",
        turn: [userMessage("msg_user"), assistantMessage("msg_asst", [textPart("Hello")]), idleMessage("msg_idle")],
        delete: deleteMock,
      });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_provider_test")!;
      const result = await handler({ providerId: "anthropic", modelID: "test-model" });
      const text = result.content[0].text;
      expect(text).toContain("anthropic");
      expect(text).toContain("is working");
      expect(text).toContain("Hello");
      // The test session is created with the model under test
      const [, body] = (mockClient.post as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(body.model).toEqual({ id: "test-model", providerID: "anthropic" });
      // Should clean up the test session
      expect(deleteMock).toHaveBeenCalledWith("/api/session/test-session", undefined, undefined);
    });

    it("reports failure when provider returns empty response", async () => {
      const deleteMock = vi.fn().mockResolvedValue(undefined);
      const mockClient = promptFlowClient({
        sessionId: "test-session",
        turn: [userMessage("msg_user")],
        delete: deleteMock,
      });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_provider_test")!;
      const result = await handler({ providerId: "badprovider", modelID: "test-model" });
      const text = result.content[0].text;
      expect(text).toContain("FAILED");
      expect(text).toContain("badprovider");
      expect(result.isError).toBe(true);
      // Should still clean up
      expect(deleteMock).toHaveBeenCalled();
    });

    it("reports failure when the run fails", async () => {
      const mockClient = promptFlowClient({
        sessionId: "test-session",
        turn: [
          userMessage("msg_user"),
          idleMessage("msg_idle", "failed", T0 + 200, { type: "ProviderAuthError", message: "Invalid API key" }),
        ],
      });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_provider_test")!;
      const result = await handler({ providerId: "anthropic", modelID: "test-model" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("FAILED");
      expect(result.content[0].text).toContain("Invalid API key");
    });

    it("discovers the provider's default model when modelID is omitted", async () => {
      const mockClient = promptFlowClient({
        sessionId: "test-session",
        get: (path) => {
          if (path === "/api/model") return [modelInfo("anthropic", "claude-haiku"), modelInfo("anthropic", "claude-sonnet"), modelInfo("openai", "gpt-4")];
          if (path === "/api/model/default") return modelInfo("anthropic", "claude-sonnet");
          return undefined;
        },
      });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_provider_test")!;
      const result = await handler({ providerId: "anthropic" });
      expect(result.content[0].text).toContain("is working");
      const [, body] = (mockClient.post as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(body.model).toEqual({ id: "claude-sonnet", providerID: "anthropic" });
    });

    it("errors when no model can be discovered for the provider", async () => {
      const mockClient = promptFlowClient({
        get: (path) => (path === "/api/model" ? [modelInfo("openai", "gpt-4")] : path === "/api/model/default" ? null : undefined),
      });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_provider_test")!;
      const result = await handler({ providerId: "anthropic" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No model discovered for provider "anthropic"');
      expect(mockClient.post).not.toHaveBeenCalled();
    });

    it("cleans up test session even on API error", async () => {
      const postMock = vi.fn()
        .mockResolvedValueOnce(sessionInfo("test-session"))
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
      const result = await handler({ providerId: "anthropic", modelID: "test-model" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("API timeout");
      // Should attempt cleanup
      expect(deleteMock).toHaveBeenCalledWith("/api/session/test-session", undefined, undefined);
    });
  });

  describe("opencode_session_search", () => {
    const sessions = [
      sessionInfo("s1", { title: "Fix login bug" }),
      sessionInfo("s2", { title: "Add dark mode feature" }),
      sessionInfo("s3", { title: "Refactor login component" }),
      sessionInfo("s4", { title: "Update README" }),
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
      expect(mockClient.get).toHaveBeenCalledWith("/api/session", undefined, undefined);
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
      // Permission.Request: { id, sessionID, action, resources, save?, message? }
      const getMock = vi.fn().mockResolvedValue([
        {
          id: "per_1",
          sessionID: "ses_abc",
          action: "bash",
          resources: ["npm test"],
          save: ["npm *"],
          message: "Run the test suite",
        },
        {
          id: "per_2",
          sessionID: "ses_def",
          action: "edit",
          resources: ["/etc/hosts", "/etc/resolv.conf"],
        },
      ]);
      const mockClient = createMockClient({ get: getMock });
      const handler = handlersFor(registerSessionTools, mockClient).get("opencode_permission_list")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(getMock).toHaveBeenCalledWith("/api/permission/request", undefined, undefined);
      expect(text).toContain("Pending Permission Requests (2)");
      expect(text).toContain("**bash** [per_1] (session: ses_abc)");
      expect(text).toContain("Resources: npm test");
      expect(text).toContain("Run the test suite");
      expect(text).toContain("**edit** [per_2] (session: ses_def)");
      expect(text).toContain("Resources: /etc/hosts, /etc/resolv.conf");
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
    it("sends the decision to the session-scoped reply endpoint", async () => {
      const mockClient = createMockClient({
        post: vi.fn().mockResolvedValue(undefined),
      });
      const handler = handlersFor(registerSessionTools, mockClient).get("opencode_session_permission")!;
      const result = await handler({
        id: "ses_abc",
        permissionID: "per_1",
        reply: "always",
      });
      expect(result.content[0].text).toContain("approved");
      expect(result.content[0].text).toContain("always");
      expect((mockClient as any).post).toHaveBeenCalledWith(
        "/api/session/ses_abc/permission/per_1/reply",
        { decision: "always" },
        { directory: undefined },
      );
    });

    it("forwards an optional message with the decision", async () => {
      const mockClient = createMockClient({
        post: vi.fn().mockResolvedValue(undefined),
      });
      const handler = handlersFor(registerSessionTools, mockClient).get("opencode_session_permission")!;
      await handler({ id: "ses_abc", permissionID: "per_1", reply: "reject", message: "Not allowed", directory: "/srv/app" });
      expect((mockClient as any).post).toHaveBeenCalledWith(
        "/api/session/ses_abc/permission/per_1/reply",
        { decision: "reject", message: "Not allowed" },
        { directory: "/srv/app" },
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
        permissionID: "per_1",
        reply: "reject",
      });
      expect(result.content[0].text).toContain("rejected");
    });

    it("returns an error (no legacy fallback) when the reply fails", async () => {
      const mockClient = createMockClient({
        post: vi.fn().mockRejectedValue(new OpenCodeError("POST failed (404)", 404, "POST", "/api/session/ses_abc/permission/per_1/reply", "{}")),
      });
      const handler = handlersFor(registerSessionTools, mockClient).get("opencode_session_permission")!;
      const result = await handler({ id: "ses_abc", permissionID: "per_1", reply: "once" });
      expect(result.isError).toBe(true);
      expect((mockClient as any).post).toHaveBeenCalledTimes(1);
    });
  });

  describe("opencode_sessions_overview (resolveSessionStatus)", () => {
    it("marks sessions in the active map as running and others as idle", async () => {
      const mockClient = createMockClient({
        get: routes({
          "/api/session": [
            sessionInfo("s1", { title: "Fix bug" }),
            sessionInfo("s2", { title: "Add feature" }),
          ],
          // SessionActive values are objects: { type: "running" }
          "/api/session/active": { s1: { type: "running" } },
        }),
      });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_sessions_overview")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("## Sessions (2)");
      expect(text).toContain("[running] Fix bug");
      expect(text).toContain("[idle] Add feature");
      expect(text).not.toContain("[object Object]");
    });

    it("falls back to idle when the active endpoint fails", async () => {
      const mockClient = createMockClient({
        get: routes({
          "/api/session": [sessionInfo("s1", { title: "Session A" })],
          "/api/session/active": new Error("not available"),
        }),
      });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_sessions_overview")!;
      const result = await handler({});
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("[idle] Session A");
    });

    it("falls back to idle for sessions missing from the active map", async () => {
      const mockClient = createMockClient({
        get: routes({
          "/api/session": [sessionInfo("s1", { title: "Orphan session" })],
          "/api/session/active": {},
        }),
      });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_sessions_overview")!;
      const result = await handler({});
      expect(result.content[0].text).toContain("[idle] Orphan session");
    });

    it("returns 'No sessions found.' when empty", async () => {
      const mockClient = createMockClient({
        get: routes({ "/api/session": [], "/api/session/active": {} }),
      });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_sessions_overview")!;
      const result = await handler({});
      expect(result.content[0].text).toContain("No sessions found.");
    });

    it("shows parent tag for child sessions", async () => {
      const mockClient = createMockClient({
        get: routes({
          "/api/session": [sessionInfo("child-1", { title: "Sub-task", parentID: "parent-1" })],
          "/api/session/active": {},
        }),
      });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_sessions_overview")!;
      const result = await handler({});
      expect(result.content[0].text).toContain("(child of parent-1)");
    });
  });

  describe("opencode_session_status (last outcome)", () => {
    it("reports failed and interrupted outcomes for idle sessions", async () => {
      const mockClient = createMockClient({
        get: routes({
          "/api/session/active": {},
          "/api/session": [
            sessionInfo("session-1", { outcome: "failed" }),
            sessionInfo("session-2", { outcome: "interrupted" }),
          ],
        }),
      });
      const handler = handlersFor(registerSessionTools, mockClient).get("opencode_session_status")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("session-1: failed");
      expect(text).toContain("session-2: interrupted");
      expect(text).not.toContain("[object Object]");
    });
  });

  describe("opencode_wait (status resolution + timeout message)", () => {
    /** GET routes for observeSession on session s1. */
    function waitClient(messages: unknown[], active: Record<string, unknown> = {}) {
      return createMockClient({
        get: routes({
          "/api/session/active": active,
          "/api/session/s1": sessionInfo("s1"),
          "/api/session/s1/message": newestFirst(messages),
          "/api/form": [],
          "/api/permission/request": [],
        }),
      });
    }

    it("detects completion from the idle marker closing the turn", async () => {
      const mockClient = waitClient([
        userMessage("m0"),
        assistantMessage("m1", [textPart("Done!")]),
        idleMessage("m2"),
      ]);
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_wait")!;
      const result = await handler({ sessionId: "s1", timeoutSeconds: 5, pollIntervalMs: 50 });
      const text = result.content[0].text;
      expect(text).toContain("Session completed");
      expect(text).toContain("Done!");
      expect(result.structuredContent.status).toBe("completed");
      expect(result.isError).toBeUndefined();
    });

    it("detects error from an idle marker with outcome 'failed'", async () => {
      const mockClient = waitClient([
        userMessage("m0"),
        idleMessage("m1", "failed", T0 + 200, { type: "ProviderAuthError", message: "Invalid API key" }),
      ]);
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_wait")!;
      const result = await handler({ sessionId: "s1", timeoutSeconds: 5, pollIntervalMs: 50 });
      expect(result.structuredContent.status).toBe("failed");
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid API key");
    });

    it("reports an interrupted turn as cancelled", async () => {
      const mockClient = waitClient([userMessage("m0"), idleMessage("m1", "interrupted")]);
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_wait")!;
      const result = await handler({ sessionId: "s1", timeoutSeconds: 5, pollIntervalMs: 50 });
      expect(result.structuredContent.status).toBe("cancelled");
    });

    it("times out with actionable suggestions", async () => {
      const mockClient = waitClient(
        [userMessage("m0"), assistantMessage("m1", [textPart("partial")])],
        { s1: { type: "running" } },
      );
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_wait")!;
      const result = await handler({ sessionId: "s1", timeoutSeconds: 0.05, pollIntervalMs: 10 });
      const text = result.content[0].text;
      expect(text).toContain("Timeout");
      expect(text).toContain("opencode_conversation");
      expect(text).toContain("opencode_session_abort");
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent.status).toBe("running");
      expect(result.structuredContent.timedOut).toBe(true);
    });

    it("returns input_required when a form is pending for the session", async () => {
      const mockClient = createMockClient({
        get: routes({
          "/api/session/active": { s1: { type: "running" } },
          "/api/session/s1": sessionInfo("s1"),
          "/api/session/s1/message": newestFirst([userMessage("m0")]),
          "/api/form": [{ id: "frm_1", sessionID: "s1", title: "Pick one", fields: [] }, { id: "frm_2", sessionID: "other", fields: [] }],
          "/api/permission/request": [],
        }),
      });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_wait")!;
      const result = await handler({ sessionId: "s1", timeoutSeconds: 5, pollIntervalMs: 50 });
      expect(result.structuredContent.status).toBe("input_required");
      expect(result.structuredContent.inputs.map((i: { id: string }) => i.id)).toEqual(["frm_1"]);
    });

    it("does not claim completion when no idle marker exists", async () => {
      const mockClient = waitClient([]);
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_wait")!;
      const result = await handler({ sessionId: "s1", timeoutSeconds: 0.05, pollIntervalMs: 10 });
      expect(result.structuredContent.status).not.toBe("completed");
      expect(result.structuredContent.timedOut).toBe(true);
      expect(result.isError).toBeUndefined();
    });
  });

  describe("opencode_run", () => {
    it("creates session, sends prompt, and polls until idle", async () => {
      let polls = 0;
      let submittedMessageId = "";
      const mockClient = createMockClient({
        post: vi.fn().mockImplementation(async (path: string, body: any) => {
          if (path === "/api/session") return sessionInfo("ses-run-1");
          if (path === "/api/session/ses-run-1/prompt") {
            submittedMessageId = body.id;
            return promptAck(body.id, "ses-run-1", body.text);
          }
          throw new Error(`unexpected POST ${path}`);
        }),
        get: vi.fn().mockImplementation(async (path: string) => {
          if (path === "/api/session/active") {
            polls++;
            // First poll: running, second poll: idle
            return polls >= 2 ? {} : { "ses-run-1": { type: "running" } };
          }
          if (path === "/api/session/ses-run-1") return sessionInfo("ses-run-1");
          if (path === "/api/session/ses-run-1/message") {
            const turn: unknown[] = [userMessage(submittedMessageId, "Build app")];
            if (polls >= 2) {
              turn.push(assistantMessage("msg_answer", [textPart("All tasks completed.")]), idleMessage("msg_idle"));
            }
            return newestFirst(turn);
          }
          if (path === "/api/form" || path === "/api/permission/request") return [];
          throw new Error(`unexpected GET ${path}`);
        }),
      });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_run")!;
      const result = await handler({ prompt: "Build app", providerID: "anthropic", modelID: "claude-opus-4-6" });
      expect(result.content[0].text).toContain("ses-run-1");
      expect(result.content[0].text).toContain("completed");
      expect(result.content[0].text).toContain("All tasks completed.");
      expect(result.structuredContent.status).toBe("completed");
      expect(result.structuredContent.messageId).toBe(submittedMessageId);
      expect(submittedMessageId).toMatch(/^msg_/);
      expect(polls).toBeGreaterThanOrEqual(2);
      // v2 binds the model to the session at creation time.
      const createCall = (mockClient.post as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(createCall[1].model).toEqual({ id: "claude-opus-4-6", providerID: "anthropic" });
    });

    it("returns error status when session errors", async () => {
      let submittedMessageId = "";
      const mockClient = createMockClient({
        post: vi.fn().mockImplementation(async (path: string, body: any) => {
          if (path === "/api/session") return sessionInfo("ses-err");
          submittedMessageId = body.id;
          return promptAck(body.id, "ses-err");
        }),
        get: vi.fn().mockImplementation(async (path: string) => {
          if (path === "/api/session/active") return {};
          if (path === "/api/session/ses-err") return sessionInfo("ses-err", { outcome: "failed" });
          if (path === "/api/session/ses-err/message") {
            return newestFirst([
              userMessage(submittedMessageId),
              idleMessage("msg_idle", "failed", T0 + 200, { type: "ProviderAuthError", message: "Invalid API key" }),
            ]);
          }
          return [];
        }),
      });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_run")!;
      const result = await handler({ prompt: "Bad task", maxDurationSeconds: 1 });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.status).toBe("failed");
      expect(result.content[0].text).toContain("Invalid API key");
    });

    it("reuses existing session when sessionId provided", async () => {
      let submittedMessageId = "";
      const mockClient = createMockClient({
        post: vi.fn().mockImplementation(async (path: string, body: any) => {
          if (path.endsWith("/prompt")) submittedMessageId = body.id;
          return undefined;
        }),
        get: vi.fn().mockImplementation(async (path: string) => {
          if (path === "/api/session/active") return {};
          if (path === "/api/session/existing-ses") return sessionInfo("existing-ses");
          if (path === "/api/session/existing-ses/message") {
            return newestFirst([
              userMessage(submittedMessageId),
              assistantMessage("msg_answer", [textPart("Done")]),
              idleMessage("msg_idle"),
            ]);
          }
          return [];
        }),
      });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_run")!;
      const result = await handler({ prompt: "Continue work", sessionId: "existing-ses" });
      // Should NOT call POST /api/session to create a new one
      const postMock = mockClient.post as ReturnType<typeof vi.fn>;
      const sessionCreateCalls = postMock.mock.calls.filter((c: unknown[]) => c[0] === "/api/session");
      expect(sessionCreateCalls.length).toBe(0);
      expect(postMock.mock.calls.map((c: unknown[]) => c[0])).toEqual(["/api/session/existing-ses/prompt"]);
      expect(result.content[0].text).toContain("existing-ses");
      expect(result.structuredContent.status).toBe("completed");
    });

    it("switches the model of a reused session instead of sending it with the prompt", async () => {
      const mockClient = createMockClient({ post: vi.fn().mockResolvedValue(undefined) });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_run")!;
      await handler({ prompt: "Continue", sessionId: "existing-ses", providerID: "openai", modelID: "gpt-5.4", variant: "low", maxDurationSeconds: 0 });
      const calls = (mockClient.post as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][0]).toBe("/api/session/existing-ses/model");
      expect(calls[0][1]).toEqual({ model: { id: "gpt-5.4", providerID: "openai", variant: "low" } });
      expect(calls[1][0]).toBe("/api/session/existing-ses/prompt");
      expect(calls[1][1]).not.toHaveProperty("model");
    });
  });

  describe("opencode_fire", () => {
    it("creates session and returns immediately with monitoring instructions", async () => {
      const mockClient = createMockClient({
        post: vi.fn().mockImplementation(async (path: string) => {
          if (path === "/api/session") return sessionInfo("ses-fire-1");
          return undefined;
        }),
      });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_fire")!;
      const result = await handler({ prompt: "Build everything", providerID: "anthropic", modelID: "claude-opus-4-6" });
      expect(result.content[0].text).toContain("ses-fire-1");
      expect(result.content[0].text).toContain("dispatched");
      expect(result.content[0].text).toContain("opencode_check");
      expect(result.structuredContent.status).toBe("accepted");
      // Dispatch does not observe the session.
      expect(mockClient.get).not.toHaveBeenCalled();
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
      const sessionCreateCalls = postMock.mock.calls.filter((c: unknown[]) => c[0] === "/api/session");
      expect(sessionCreateCalls.length).toBe(0);
      expect(result.content[0].text).toContain("ses-existing");
    });
  });

  describe("opencode_check", () => {
    function checkClient(sessionId: string, title: string, messages: unknown[], active: Record<string, unknown> = {}) {
      return createMockClient({
        get: routes({
          "/api/session/active": active,
          [`/api/session/${sessionId}`]: sessionInfo(sessionId, { title }),
          [`/api/session/${sessionId}/message`]: newestFirst(messages),
          "/api/form": [],
          "/api/permission/request": [],
        }),
      });
    }

    it("returns compact progress report with status and changed files", async () => {
      const mockClient = checkClient("ses-chk", "Build App", [
        userMessage("m0"),
        assistantMessage("m1", [textPart("Working on it")], T0 + 100, {
          snapshot: { start: "a", end: "b", files: ["src/App.tsx", "src/index.ts"] },
        }),
      ], { "ses-chk": { type: "running" } });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_check")!;
      const result = await handler({ sessionId: "ses-chk" });
      const text = result.content[0].text;
      expect(text).toContain("Build App");
      expect(text).toContain("Status: running");
      expect(text).toContain("Files changed: 2");
      // Compact mode does not echo the response text or patches
      expect(text).not.toContain("Working on it");
      expect(mockClient.get).not.toHaveBeenCalledWith(expect.stringContaining("/diff"), expect.anything(), expect.anything());
    });

    it("shows completion message when session is idle", async () => {
      const mockClient = checkClient("ses-done", "Finished", [
        userMessage("m0"),
        assistantMessage("m1", [textPart("Done")]),
        idleMessage("m2"),
      ]);
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_check")!;
      const result = await handler({ sessionId: "ses-done" });
      const text = result.content[0].text;
      expect(result.structuredContent.status).toBe("completed");
      expect(text).toContain("Done!");
      expect(text).toContain("opencode_review_changes");
    });

    it("includes last message when detailed=true", async () => {
      const mockClient = checkClient("ses-d", "Detail test", [
        userMessage("m0"),
        assistantMessage("m1", [textPart("Build complete! All tests pass.")]),
        idleMessage("m2"),
      ]);
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_check")!;
      const result = await handler({ sessionId: "ses-d", detailed: true });
      const text = result.content[0].text;
      expect(text).toContain("Build complete!");
      expect(text).toContain("Last message");
    });
  });

  describe("opencode_status", () => {
    it("returns combined dashboard with all sections", async () => {
      const mockClient = createMockClient({
        get: routes({
          "/api/info": { version: "2.1.2" },
          "/api/provider": [providerInfo("anthropic"), providerInfo("groq")],
          "/api/credential": [credentialEntry("anthropic")],
          "/api/session": [sessionInfo("s1"), sessionInfo("s2"), sessionInfo("s3")],
          "/api/vcs": { provider: "git", branch: { current: "main", default: "main" } },
        }),
      });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_status")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("## Status");
      expect(text).toContain("healthy");
      expect(text).toContain("2.1.2");
      expect(text).toContain("1 configured / 2 total");
      expect(text).toContain("Sessions: 3");
      expect(text).toContain("Branch: main");
    });

    it("handles partial failures gracefully", async () => {
      const mockClient = createMockClient({
        get: routes({ "/api/info": { version: "2.1.2" } }),
      });
      const handler = handlersFor(registerWorkflowTools, mockClient).get("opencode_status")!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain("healthy");
      // Other sections should just be missing, not cause errors
      expect(text).not.toContain("Providers:");
      expect(text).not.toContain("Branch:");
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

    it("opencode_status returns directory error for invalid control bytes", async () => {
      const { tools, client } = setupTools();
      const handler = tools.get("opencode_status")!;
      const result = await handler({ directory: "/bad\npath" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("NUL or CR/LF");
      // Should NOT show UNREACHABLE — that was the bug
      expect(result.content[0].text).not.toContain("UNREACHABLE");
      // client.get should never be called
      expect((client as any).get).not.toHaveBeenCalled();
    });

    it("opencode_status rejects header injection", async () => {
      const { tools, client } = setupTools();
      const handler = tools.get("opencode_status")!;
      const result = await handler({ directory: "/bad\rpath" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("NUL or CR/LF");
      expect(result.content[0].text).not.toContain("UNREACHABLE");
    });

    it("opencode_context returns directory error for invalid control bytes", async () => {
      const { tools, client } = setupTools();
      const handler = tools.get("opencode_context")!;
      const result = await handler({ directory: "/bad\npath" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("NUL or CR/LF");
      expect((client as any).get).not.toHaveBeenCalled();
    });

    it("opencode_check returns directory error for invalid control bytes", async () => {
      const { tools, client } = setupTools();
      const handler = tools.get("opencode_check")!;
      const result = await handler({
        sessionId: "test-session-id",
        directory: "/bad\npath",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("NUL or CR/LF");
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


describe("Issue #20: asynchronous workflow dispatch", () => {
  it.each(["opencode_fire", "opencode_run"])("%s dispatches without waiting for inference", async (name) => {
    const { tools, client } = captureTools(registerWorkflowTools);
    vi.mocked(client.post).mockImplementation(async (path) => {
      if (path === "/api/session") return sessionInfo("async-session");
      if (path === "/api/session/async-session/prompt") return promptAck("msg_x", "async-session", "Long task");
      throw new Error(`Unexpected blocking request: ${path}`);
    });
    const result = await tools.get(name)!.handler({
      prompt: "Long task", directory: "/tmp", providerID: "test", modelID: "model",
      variant: "high", agent: "build", maxDurationSeconds: 0,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain(name === "opencode_run" ? "still running" : "Task dispatched");
    expect(result.content[0].text).toContain("async-session");
    // The session is created with its model and location in the body.
    expect(client.post).toHaveBeenCalledWith("/api/session", {
      title: "MCP delegated task",
      model: { id: "model", providerID: "test", variant: "high" },
      location: { directory: "/tmp" },
    }, expect.objectContaining({ directory: "/tmp" }));
    // v2 prompts are queued and return immediately; no wait endpoint is used.
    expect(client.post).toHaveBeenLastCalledWith("/api/session/async-session/prompt", {
      id: expect.stringMatching(/^msg_/), text: "Long task", agent: "build",
    }, expect.objectContaining({ directory: "/tmp", signal: expect.any(AbortSignal), deadline: expect.any(Number) }));
  });

  it("reports dispatch failures rather than claiming a task is running", async () => {
    const { tools, client } = captureTools(registerWorkflowTools);
    vi.mocked(client.post).mockRejectedValue(new OpenCodeError("dispatch rejected", 400, "POST", "/api/session/existing/prompt", "invalid"));
    const result = await tools.get("opencode_fire")!.handler({ prompt: "Task", sessionId: "existing" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.status).toBe("failed");
    expect(result.content[0].text).toContain("rejected");
  });
});


describe("Issue #14: remote project directories", () => {
  it.each(["opencode_status", "opencode_context", "opencode_check"])("%s accepts a server-only path", async (name) => {
    const { tools, client } = captureTools(registerWorkflowTools);
    const directory = "/remote-only/project-issue-14";
    vi.mocked(client.get).mockImplementation(async (path) =>
      path === "/api/agent" || path === "/api/form" || path === "/api/permission/request" || path.endsWith("/message") ? [] : {});
    const result = await tools.get(name)!.handler({ directory, sessionId: "remote-session" });
    expect(result.isError).toBeUndefined();
    expect(vi.mocked(client.get).mock.calls.some(call => call[2] === directory)).toBe(true);
  });
});
