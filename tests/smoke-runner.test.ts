import { describe, expect, it, vi } from "vitest";
import { FIXTURE_MARKER, runSmoke, smokeEnvironment, smokeOptions } from "../scripts/mcp-smoke-test.mjs";

const result = (text = "fixture response", structuredContent?: Record<string, unknown>) => ({
  content: [{ type: "text", text }], ...(structuredContent ? { structuredContent } : {}),
});
const directory = "/disposable/smoke-fixture";
function fakeClient(overrides: Record<string, unknown> = {}) {
  const replies: Record<string, unknown> = {
    opencode_health: result("Status: healthy\nVersion: fixture"),
    opencode_file_list: result("README.md"),
    opencode_file_read: result(FIXTURE_MARKER),
    opencode_find_file: result("README.md"),
    opencode_find_text: result(`README.md:1 ${FIXTURE_MARKER}`),
    opencode_session_create: result("created", { sessionId: "ses_owned" }),
    opencode_wait: result("Status: completed", { status: "completed" }),
    opencode_run: result("Status: completed", { status: "completed" }),
    ...overrides,
  };
  return {
    listTools: vi.fn().mockResolvedValue({ tools: [
      "opencode_health", "opencode_session_create", "opencode_session_delete", "opencode_session_share",
      "opencode_auth_set", "opencode_fire", "opencode_run", "opencode_wait", "opencode_check", "opencode_project_init",
    ].map((name) => ({ name })) }),
    callTool: vi.fn(async ({ name }: { name: string }) => {
      if (replies[name] instanceof Error) throw replies[name];
      return replies[name] ?? result();
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}
const names = (client: ReturnType<typeof fakeClient>) => client.callTool.mock.calls.map(([call]) => call.name);

describe("isolated smoke runner", () => {
  it("does no inference by default and marks untested capabilities SKIP", async () => {
    const client = fakeClient();
    const report = await runSmoke({ client, directory });
    expect(report.exitCode).toBe(0);
    for (const name of ["opencode_fire", "opencode_run", "opencode_wait", "opencode_auth_set", "opencode_session_share"]) {
      expect(names(client)).not.toContain(name);
      expect(report.results).toContainEqual(expect.objectContaining({ name, status: "SKIP" }));
    }
    expect(names(client)).toContain("opencode_project_init");
    expect(client.callTool).toHaveBeenCalledWith({ name: "opencode_session_delete", arguments: { id: "ses_owned", directory } }, undefined, expect.any(Object));
    expect(client.close).toHaveBeenCalledOnce();
  });

  it.each([
    { ...result("ID: ses_existing"), isError: true },
    result("Existing sessions: [ses_existing]"),
    result("ID: ses_owned\nID: ses_existing"),
    result("ID: ses_existing", { sessionId: "invalid/path" }),
  ])("never selects or mutates another session when creation fails", async (createReply) => {
    const client = fakeClient({ opencode_session_create: createReply });
    const report = await runSmoke({ client, directory });
    expect(report.exitCode).toBe(1);
    for (const name of ["opencode_session_list", "opencode_session_delete", "opencode_session_abort", "opencode_session_update", "opencode_session_share", "opencode_fire"]) {
      expect(names(client)).not.toContain(name);
    }
  });

  it("accepts an anchored legacy ID only from a successful creation response", async () => {
    const client = fakeClient({ opencode_session_create: result("Session created.\n\nID: ses_legacy\nTitle: fixture") });
    expect((await runSmoke({ client, directory })).exitCode).toBe(0);
    expect(client.callTool).toHaveBeenCalledWith({ name: "opencode_session_delete", arguments: { id: "ses_legacy", directory } }, undefined, expect.any(Object));
  });

  it("treats backend isError as failure and still cleans up its owned session", async () => {
    const client = fakeClient({ opencode_session_get: { ...result("synthetic backend failure"), isError: true } });
    const report = await runSmoke({ client, directory });
    expect(report.exitCode).toBe(1);
    expect(report.results).toContainEqual(expect.objectContaining({ name: "opencode_session_get", status: "FAIL" }));
    expect(names(client)).toContain("opencode_session_delete");
    expect(JSON.stringify(report)).not.toContain("synthetic backend failure");
  });

  it("fails fixture assertions even when the server returns successful empty results", async () => {
    const client = fakeClient({ opencode_find_file: result("No files found") });
    const report = await runSmoke({ client, directory });
    expect(report.exitCode).toBe(1);
    expect(report.results).toContainEqual(expect.objectContaining({ name: "opencode_find_file", status: "FAIL" }));
  });

  it("dispatches explicitly selected inference serially and aborts owned work before deletion", async () => {
    const client = fakeClient();
    const report = await runSmoke({ client, directory, inference: true, providerID: "fixture-provider", modelID: "fixture-model" });
    expect(report.exitCode).toBe(0);
    const calls = names(client);
    expect(calls.indexOf("opencode_fire")).toBeLessThan(calls.indexOf("opencode_wait"));
    expect(calls.indexOf("opencode_wait")).toBeLessThan(calls.indexOf("opencode_run"));
    expect(calls.indexOf("opencode_session_abort")).toBeLessThan(calls.indexOf("opencode_session_delete"));
    for (const name of ["opencode_fire", "opencode_run"]) {
      expect(client.callTool).toHaveBeenCalledWith(expect.objectContaining({ name, arguments: expect.objectContaining({ sessionId: "ses_owned", providerID: "fixture-provider", modelID: "fixture-model", directory }) }), undefined, expect.any(Object));
    }
  });

  it("does not dispatch a second prompt when waiting times out", async () => {
    const client = fakeClient({ opencode_wait: result("Status: still running", { status: "running" }) });
    const report = await runSmoke({ client, directory, inference: true, providerID: "fixture", modelID: "model" });
    expect(report.exitCode).toBe(1);
    expect(names(client)).not.toContain("opencode_run");
    expect(names(client)).toContain("opencode_session_abort");
    expect(names(client)).toContain("opencode_session_delete");
  });

  it("reports cleanup failure and always closes the client", async () => {
    const client = fakeClient({ opencode_session_delete: new Error("synthetic failure") });
    expect((await runSmoke({ client, directory })).exitCode).toBe(1);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("does no fixture operations after unhealthy-server preflight", async () => {
    const client = fakeClient({ opencode_health: result("Status: unhealthy") });
    expect((await runSmoke({ client, directory })).exitCode).toBe(1);
    expect(names(client)).toEqual(["opencode_health"]);
  });

  it("fails malformed tool pagination and closes the client", async () => {
    const client = fakeClient();
    client.listTools.mockResolvedValue({ tools: [], nextCursor: "repeat" });
    expect((await runSmoke({ client, directory })).exitCode).toBe(1);
    expect(client.listTools).toHaveBeenCalledTimes(2);
    expect(client.close).toHaveBeenCalledOnce();
  });
});

describe("smoke options", () => {
  it("requires explicit inference opt-in even when model defaults exist", () => {
    expect(smokeOptions([], { OPENCODE_TEST_PROVIDER: "fixture", OPENCODE_TEST_MODEL: "model" }).inference).toBe(false);
    expect(() => smokeOptions(["--inference"], {})).toThrow("requires");
    expect(smokeOptions(["--inference", "--provider", "fixture", "--model", "model"], {})).toEqual(expect.objectContaining({ inference: true, providerID: "fixture", modelID: "model" }));
  });

  it("forwards auth but does not inherit automatic startup or unrelated credentials", () => {
    const env = smokeEnvironment({ baseUrl: "http://localhost:4096" }, {
      OPENCODE_SERVER_USERNAME: "fixture-user", OPENCODE_SERVER_PASSWORD: "fixture-password", OPENCODE_AUTO_SERVE: "true", UNRELATED_SECRET: "not-forwarded",
    });
    expect(env).toEqual({ OPENCODE_BASE_URL: "http://localhost:4096", OPENCODE_SERVER_USERNAME: "fixture-user", OPENCODE_SERVER_PASSWORD: "fixture-password", OPENCODE_AUTO_SERVE: "false" });
  });

  it("rejects embedded credentials, remote fixture ambiguity, and unknown options", () => {
    expect(() => smokeOptions(["--base-url", "http://user:fixture@localhost:4096"], {})).toThrow("credentials");
    expect(() => smokeOptions(["--base-url", "https://example.com"], {})).toThrow("disposable");
    expect(() => smokeOptions(["--model"], {})).toThrow("Missing");
    expect(() => smokeOptions(["--unexpected"], {})).toThrow("Unknown");
  });
});
