import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";
import { OpenCodeClient } from "../src/client.js";
import { operate } from "../src/backends/adapter.js";
import { BackendCapabilityError } from "../src/backends/contracts.js";
import { registerProviderTools } from "../src/tools/provider.js";
import type { McpServer } from "../src/mcp-server.js";

// These tests use the installed V2 SDK transport against an isolated HTTP server.
// They do not authenticate to a real provider or claim a completed OAuth login.
type Call = { method: string; url: URL; body: Record<string, unknown> | undefined };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())); });
const provider = { id: "provider", name: "Provider", integrationID: "integration", activation: "enabled" };
const oauthMethod = { id: "oauth-primary", type: "oauth", label: "Sign in" };
const integration = { id: "integration", name: "Integration", connections: [], methods: [{ type: "key", label: "API key" }, oauthMethod] };
const authorization = { attemptID: "attempt-returned", url: "https://example.invalid/authorize", instructions: "Enter the authorization code", mode: "code", time: { created: 1, expires: 2 } };

async function fixture(options: {
  providers?: unknown[];
  integrations?: unknown[];
  intercept?: (call: Call, res: ServerResponse) => boolean;
} = {}) {
  const calls: Call[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    const call: Call = { method: req.method!, url: new URL(req.url!, "http://fixture.invalid"), body: raw ? JSON.parse(raw) : undefined };
    calls.push(call); res.setHeader("content-type", "application/json");
    if (options.intercept?.(call, res)) return;
    if (call.method === "GET" && call.url.pathname === "/api/provider") res.end(JSON.stringify({ data: options.providers ?? [provider] }));
    else if (call.method === "GET" && call.url.pathname === "/api/integration") res.end(JSON.stringify({ data: options.integrations ?? [integration] }));
    else if (call.method === "POST" && call.url.pathname === "/api/integration/integration/connect/oauth") res.end(JSON.stringify({ data: authorization }));
    else if (call.method === "POST") { res.statusCode = 204; res.end(); }
    else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const port = (server.address() as { port: number }).port;
  const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${port}`, backend: "v2" });
  const entries = new Map<string, { shape: z.ZodRawShape; handler: Function }>();
  registerProviderTools({ tool(name: string, _description: string, shape: z.ZodRawShape, ...rest: unknown[]) {
    entries.set(name, { shape, handler: rest.at(-1) as Function });
  } } as unknown as McpServer, client);
  const tool = (name: string, input: unknown) => { const entry = entries.get(name)!; return entry.handler(z.object(entry.shape).parse(input)); };
  return { client, calls, tool, entries, writes: () => calls.filter(call => call.method !== "GET") };
}

const authWrites = ["authorize", "callback", "setAuth"] as const;
function write(client: OpenCodeClient, operation: typeof authWrites[number], integrationId?: string) {
  const common = { providerId: "provider", directory: "/must-not-scope-global-auth" };
  if (operation === "authorize") return operate(client, "providers.authorize", { ...common, body: { methodId: "oauth-primary", integrationId } });
  if (operation === "callback") return operate(client, "providers.callback", { ...common, body: { attemptId: "attempt-returned", integrationId, code: "fixture-code" } });
  return operate(client, "providers.setAuth", { ...common, body: { type: "api", key: "fixture-key", integrationId } });
}

describe("V2 global provider authentication through the actual SDK HTTP transport", () => {
  it.each(authWrites)("keeps %s discovery and mutation global even with a directory argument", async operation => {
    const { client, calls, writes } = await fixture();
    await write(client, operation, "integration");
    expect(calls.slice(0, 2).map(call => call.url.pathname)).toEqual(["/api/provider", "/api/integration"]);
    expect(writes()).toHaveLength(1);
    expect(calls.every(call => call.url.search === "")).toBe(true);
    expect(calls.every(call => !call.body || !("location" in call.body) && !("directory" in call.body))).toBe(true);
    const expected = operation === "authorize" ? ["/api/integration/integration/connect/oauth", { methodID: "oauth-primary" }]
      : operation === "callback" ? ["/api/integration/integration/connect/oauth/attempt-returned/complete", { code: "fixture-code" }]
      : ["/api/integration/integration/connect/key", { key: "fixture-key" }];
    expect([writes()[0].url.pathname, writes()[0].body]).toEqual(expected);
  });

  it("exposes method IDs, integration IDs and typed forms through the public discovery tool", async () => {
    const form = [{ key: "tenant", type: "string", required: true }];
    const { tool, entries } = await fixture({ integrations: [{ ...integration, methods: [{ ...oauthMethod, form }] }] });
    const result = await tool("opencode_provider_auth_methods", {});
    expect(result.structuredContent.data.provider).toEqual([{ ...oauthMethod, form, integrationID: "integration" }]);
    for (const name of ["opencode_provider_oauth_authorize", "opencode_provider_oauth_callback", "opencode_auth_set"]) {
      expect(entries.get(name)!.shape).not.toHaveProperty("directory");
    }
  });

  it.each(authWrites)("rejects duplicate provider mappings before %s writes", async operation => {
    const { client, writes } = await fixture({ providers: [provider, { ...provider, integrationID: "other-integration" }] });
    await expect(write(client, operation)).rejects.toThrow("unambiguous");
    expect(writes()).toHaveLength(0);
  });

  it.each(authWrites)("rejects duplicate integration mappings before %s writes", async operation => {
    const { client, writes } = await fixture({ integrations: [integration, { ...integration, name: "Conflicting integration" }] });
    await expect(write(client, operation)).rejects.toThrow(/unambiguous|ambiguous/i);
    expect(writes()).toHaveLength(0);
  });

  it.each(authWrites)("rejects an explicit integration that contradicts the provider before %s writes", async operation => {
    const { client, calls, writes } = await fixture();
    await expect(write(client, operation, "other-integration")).rejects.toThrow("does not match");
    expect(calls).toHaveLength(1); expect(writes()).toHaveLength(0);
  });

  it.each([
    { label: "missing provider", providers: [], integrations: [integration] },
    { label: "missing provider integration ID", providers: [{ ...provider, integrationID: undefined }], integrations: [integration] },
    { label: "missing integration", providers: [provider], integrations: [] },
  ])("rejects $label instead of inferring an integration", async options => {
    const { client, writes } = await fixture(options);
    await expect(write(client, "authorize")).rejects.toThrow(); expect(writes()).toHaveLength(0);
  });

  it.each([401, 403])("stops discovery on authentication rejection %i without an auth write", async status => {
    const { client, calls, writes } = await fixture({ intercept: (_call, res) => { res.statusCode = status; res.end("{}"); return true; } });
    await expect(write(client, "authorize")).rejects.toMatchObject({ status });
    expect(calls).toHaveLength(1); expect(writes()).toHaveLength(0);
  });
});

describe("V2 OAuth method, typed answer and attempt contracts", () => {
  const form = [
    { key: "count", type: "integer", required: true, minimum: 1 },
    { key: "enabled", type: "boolean", required: true },
    { key: "region", type: "string", required: true, options: [{ value: "eu", label: "Europe" }] },
    { key: "scopes", type: "multiselect", required: true, options: [{ value: "read", label: "Read" }] },
  ];
  const withForm = { ...integration, methods: [{ type: "key" }, { ...oauthMethod, form }] };

  it("selects the explicit OAuth method ID and returns the exact attempt ID with typed values unchanged", async () => {
    const { tool, writes } = await fixture({ integrations: [withForm] });
    const values = { count: 2, enabled: false, region: "eu", scopes: ["read"] };
    const result = await tool("opencode_provider_oauth_authorize", { providerId: "provider", integrationId: "integration", method: 0, methodId: "oauth-primary", values });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.data).toMatchObject({ ...authorization, attemptId: "attempt-returned", integrationId: "integration", methodId: "oauth-primary" });
    expect(writes()[0].body).toEqual({ methodID: "oauth-primary", answer: values });
  });

  it.each([
    { count: "2", enabled: false, region: "eu", scopes: ["read"] },
    { count: 2.5, enabled: false, region: "eu", scopes: ["read"] },
    { count: 2, enabled: "false", region: "eu", scopes: ["read"] },
    { count: 2, enabled: false, region: "other", scopes: ["read"] },
    { count: 2, enabled: false, region: "eu", scopes: ["write"] },
    { count: 2, enabled: false, region: "eu", scopes: ["read"], unknown: "value" },
  ])("rejects invalid typed authorization values before submission: %j", async values => {
    const { client, writes } = await fixture({ integrations: [withForm] });
    await expect(operate(client, "providers.authorize", { providerId: "provider", body: { methodId: "oauth-primary", values } })).rejects.toThrow(/form field/);
    expect(writes()).toHaveLength(0);
  });

  it("does not infer missing required answers from form defaults", async () => {
    const { client, writes } = await fixture({ integrations: [{ ...integration, methods: [{ ...oauthMethod, form: [{ key: "consent", type: "boolean", required: true, default: true }] }] }] });
    await expect(operate(client, "providers.authorize", { providerId: "provider", body: { methodId: "oauth-primary" } })).rejects.toThrow("Missing required field");
    expect(writes()).toHaveLength(0);
  });

  it("accepts the published OAuth method index when no method ID is supplied", async () => {
    const { client, writes } = await fixture();
    await operate(client, "providers.authorize", { providerId: "provider", body: { method: 1 } });
    expect(writes()[0].body).toEqual({ methodID: "oauth-primary" });
  });

  it.each([{ method: 0 }, { method: 5 }, { methodId: "missing" }])("rejects a key or unknown OAuth method without submitting: %j", async body => {
    const { client, writes } = await fixture();
    await expect(operate(client, "providers.authorize", { providerId: "provider", body })).rejects.toThrow("Select an OAuth method");
    expect(writes()).toHaveLength(0);
  });

  it("requires callback attempt identity before any discovery or mutation", async () => {
    const { tool, calls } = await fixture();
    const result = await tool("opencode_provider_oauth_callback", { providerId: "provider", callbackData: { method: 1, code: "fixture-code" } });
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain("attemptId"); expect(calls).toHaveLength(0);
  });

  it("uses exactly the returned attempt in the public authorize/callback workflow", async () => {
    const { tool, writes } = await fixture();
    const started = await tool("opencode_provider_oauth_authorize", { providerId: "provider", methodId: "oauth-primary" });
    const { attemptId, integrationId } = started.structuredContent.data;
    const completed = await tool("opencode_provider_oauth_callback", { providerId: "provider", callbackData: { attemptId, integrationId, method: 99, code: "fixture-code" } });
    expect(completed.isError).not.toBe(true);
    expect(writes().map(call => call.url.pathname)).toEqual(["/api/integration/integration/connect/oauth", "/api/integration/integration/connect/oauth/attempt-returned/complete"]);
    expect(writes()[1].body).toEqual({ code: "fixture-code" });
  });

  it("does not fall back to a method index or retry when the exact attempt is rejected", async () => {
    const { client, writes } = await fixture({ intercept: (call, res) => {
      if (!call.url.pathname.endsWith("/complete")) return false;
      res.statusCode = 404; res.end(JSON.stringify({ _tag: "IntegrationAttemptNotFoundError", integrationID: "integration", attemptID: "attempt-missing", message: "Unknown attempt" })); return true;
    } });
    await expect(operate(client, "providers.callback", { providerId: "provider", body: { attemptId: "attempt-missing", method: 1 } })).rejects.toMatchObject({ status: 404 });
    expect(writes()).toHaveLength(1); expect(writes()[0].url.pathname).toBe("/api/integration/integration/connect/oauth/attempt-missing/complete");
  });

  it("rejects non-key integrations and non-API auth types without writing", async () => {
    const { client, calls, writes } = await fixture({ integrations: [{ ...integration, methods: [oauthMethod] }] });
    await expect(operate(client, "providers.setAuth", { providerId: "provider", body: { type: "oauth", key: "fixture-key" } })).rejects.toBeInstanceOf(BackendCapabilityError);
    expect(calls).toHaveLength(0);
    await expect(operate(client, "providers.setAuth", { providerId: "provider", body: { type: "api", key: "fixture-key" } })).rejects.toThrow("key authentication method");
    expect(writes()).toHaveLength(0);
  });
});
