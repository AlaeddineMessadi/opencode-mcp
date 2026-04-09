import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isServerRunning,
  findBinary,
  getInstalledVersion,
  getInstallInstructions,
  startServer,
  stopServer,
  ensureServer,
} from "../src/server-manager.js";

// ─── Mock child_process ──────────────────────────────────────────────────

vi.mock("node:child_process", () => {
  const execFileMock = vi.fn();
  const spawnMock = vi.fn();
  return {
    execFile: execFileMock,
    spawn: spawnMock,
  };
});

import { execFile, spawn } from "node:child_process";
const execFileMock = vi.mocked(execFile);
const spawnMock = vi.mocked(spawn);

// ─── Helpers ─────────────────────────────────────────────────────────────

let fetchMock: ReturnType<typeof vi.fn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

function mockFetchHealthy(version = "1.1.53") {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ healthy: true, version }),
  } as unknown as Response);
}

function mockFetchDown() {
  fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
}

function mockFetchUnhealthy() {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ healthy: false }),
  } as unknown as Response);
}

function mockFetchNotOk() {
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status: 500,
    text: async () => "Internal Server Error",
  } as unknown as Response);
}

/**
 * Helper: make execFile behave like a promisified call.
 * Vitest mocks the raw `execFile`, but our code uses `promisify(execFile)`,
 * which calls `execFile(cmd, args, callback)`.
 */
function mockExecFileSuccess(stdout: string) {
  execFileMock.mockImplementationOnce(
    (_cmd: unknown, _args: unknown, callback: unknown) => {
      if (typeof callback === "function") {
        (callback as (err: Error | null, result: { stdout: string; stderr: string }) => void)(
          null,
          { stdout, stderr: "" },
        );
      }
      return {} as any;
    },
  );
}

function mockExecFileError(message = "not found") {
  execFileMock.mockImplementationOnce(
    (_cmd: unknown, _args: unknown, callback: unknown) => {
      if (typeof callback === "function") {
        (callback as (err: Error | null) => void)(new Error(message));
      }
      return {} as any;
    },
  );
}

// ─── Setup / Teardown ────────────────────────────────────────────────────

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  stopServer();
});

// ─── isServerRunning ─────────────────────────────────────────────────────

describe("isServerRunning", () => {
  it("returns healthy=true with version when server responds", async () => {
    mockFetchHealthy("1.2.0");
    const result = await isServerRunning("http://127.0.0.1:4096");
    expect(result).toEqual({ healthy: true, version: "1.2.0" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4096/global/health",
      expect.objectContaining({ 
        method: "GET",
        headers: {}
      }),
    );
  });

  it("includes authorization header when password is provided", async () => {
    mockFetchHealthy("1.2.0");
    const result = await isServerRunning("http://127.0.0.1:4096", "admin", "secret123");
    expect(result).toEqual({ healthy: true, version: "1.2.0" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4096/global/health",
      expect.objectContaining({ 
        method: "GET",
        headers: {
          "Authorization": "Basic YWRtaW46c2VjcmV0MTIz"
        }
      }),
    );
  });

  it("uses default username 'opencode' when password provided without username", async () => {
    mockFetchHealthy("1.2.0");
    const result = await isServerRunning("http://127.0.0.1:4096", undefined, "secret123");
    expect(result).toEqual({ healthy: true, version: "1.2.0" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4096/global/health",
      expect.objectContaining({ 
        method: "GET",
        headers: {
          "Authorization": "Basic b3BlbmNvZGU6c2VjcmV0MTIz"
        }
      }),
    );
  });

  it("returns healthy=false when server is down", async () => {
    mockFetchDown();
    const result = await isServerRunning("http://127.0.0.1:4096");
    expect(result).toEqual({ healthy: false });
  });

  it("returns healthy=false when response is not ok", async () => {
    mockFetchNotOk();
    const result = await isServerRunning("http://127.0.0.1:4096");
    expect(result).toEqual({ healthy: false });
  });

  it("returns healthy=false when body says not healthy", async () => {
    mockFetchUnhealthy();
    const result = await isServerRunning("http://127.0.0.1:4096");
    expect(result).toEqual({ healthy: false, version: undefined });
  });

  it("strips trailing slash from base URL", async () => {
    mockFetchHealthy();
    await isServerRunning("http://127.0.0.1:4096/");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4096/global/health",
      expect.objectContaining({ 
        method: "GET",
        headers: {}
      }),
    );
  });

  it("handles version missing from response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ healthy: true }),
    } as unknown as Response);
    const result = await isServerRunning("http://127.0.0.1:4096");
    expect(result).toEqual({ healthy: true, version: undefined });
  });
});

// ─── findBinary ──────────────────────────────────────────────────────────

describe("findBinary", () => {
  it("returns binary path when found", async () => {
    mockExecFileSuccess("/usr/local/bin/opencode\n");
    const result = await findBinary();
    expect(result).toBe("/usr/local/bin/opencode");
  });

  it("returns null when binary not found", async () => {
    mockExecFileError("not found");
    const result = await findBinary();
    expect(result).toBeNull();
  });

  it("returns first path when multiple results (Windows)", async () => {
    mockExecFileSuccess("C:\\Program Files\\opencode\\opencode.exe\nC:\\Users\\bin\\opencode.exe\n");
    const result = await findBinary();
    expect(result).toBe("C:\\Program Files\\opencode\\opencode.exe");
  });

  it("returns null for empty output", async () => {
    mockExecFileSuccess("");
    const result = await findBinary();
    expect(result).toBeNull();
  });
});

// ─── getInstalledVersion ─────────────────────────────────────────────────

describe("getInstalledVersion", () => {
  it("returns version string", async () => {
    mockExecFileSuccess("1.1.53\n");
    const result = await getInstalledVersion("/usr/local/bin/opencode");
    expect(result).toBe("1.1.53");
  });

  it("returns null when command fails", async () => {
    mockExecFileError("command not found");
    const result = await getInstalledVersion("/usr/local/bin/opencode");
    expect(result).toBeNull();
  });

  it("returns null for empty output", async () => {
    mockExecFileSuccess("");
    const result = await getInstalledVersion("/usr/local/bin/opencode");
    expect(result).toBeNull();
  });
});

// ─── getInstallInstructions ──────────────────────────────────────────────

describe("getInstallInstructions", () => {
  it("includes all install methods", () => {
    const instructions = getInstallInstructions();
    expect(instructions).toContain("npm i -g opencode-ai");
    expect(instructions).toContain("curl -fsSL https://opencode.ai/install | bash");
    expect(instructions).toContain("brew install sst/tap/opencode");
    expect(instructions).toContain("OPENCODE_AUTO_SERVE=false");
  });
});

// ─── ensureServer ────────────────────────────────────────────────────────

describe("ensureServer", () => {
  it("returns immediately when server is already running", async () => {
    mockFetchHealthy("1.2.0");
    const result = await ensureServer({
      baseUrl: "http://127.0.0.1:4096",
    });
    expect(result).toEqual({
      running: true,
      version: "1.2.0",
      managedByUs: false,
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("already running"),
    );
  });

  it("includes authorization header when checking server with auth", async () => {
    mockFetchHealthy("1.2.0");
    const result = await ensureServer({
      baseUrl: "http://127.0.0.1:4096",
      username: "admin",
      password: "secret123",
    });
    expect(result).toEqual({
      running: true,
      version: "1.2.0",
      managedByUs: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4096/global/health",
      expect.objectContaining({ 
        method: "GET",
        headers: {
          "Authorization": "Basic YWRtaW46c2VjcmV0MTIz"
        }
      }),
    );
  });

  it("uses authorization headers during auto-start health polling", async () => {
    const expectedAuth = "Basic YWRtaW46c2VjcmV0MTIz";
    const fakeChild = createFakeChild();
    spawnMock.mockReturnValueOnce(fakeChild as any);

    let healthCheckCalls = 0;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      healthCheckCalls += 1;

      if (healthCheckCalls === 1) {
        throw new Error("ECONNREFUSED");
      }

      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers.Authorization !== expectedAuth) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ healthy: false }),
        } as unknown as Response;
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ healthy: true, version: "1.1.53" }),
      } as unknown as Response;
    });

    mockExecFileSuccess("/usr/local/bin/opencode\n");
    mockExecFileSuccess("1.1.53\n");

    const result = await ensureServer({
      baseUrl: "http://127.0.0.1:4096",
      startupTimeoutMs: 1_000,
      username: "admin",
      password: "secret123",
    });

    expect(result).toEqual({
      running: true,
      version: "1.1.53",
      managedByUs: true,
    });
    for (const [, init] of fetchMock.mock.calls.slice(1)) {
      expect(init).toEqual(
        expect.objectContaining({
          headers: {
            Authorization: expectedAuth,
          },
        }),
      );
    }
  });

  it("throws when auto-serve is disabled and server is not running", async () => {
    mockFetchDown();
    await expect(
      ensureServer({
        baseUrl: "http://127.0.0.1:4096",
        autoServe: false,
      }),
    ).rejects.toThrow("OPENCODE_AUTO_SERVE=false");
  });

  it("throws with install instructions when binary not found", async () => {
    mockFetchDown(); // server not running
    mockExecFileError("not found"); // binary not found
    await expect(
      ensureServer({
        baseUrl: "http://127.0.0.1:4096",
      }),
    ).rejects.toThrow("npm i -g opencode-ai");
  });

  it("logs binary path when found", async () => {
    // Server not running
    mockFetchDown();
    // Binary found
    mockExecFileSuccess("/usr/local/bin/opencode\n");
    // Version check
    mockExecFileSuccess("1.1.53\n");

    // Now startServer will be called — mock spawn to create a fake child
    const fakeChild = createFakeChild();
    spawnMock.mockReturnValueOnce(fakeChild as any);

    // Health poll after spawn: first fail, then succeed
    mockFetchDown();
    mockFetchHealthy("1.1.53");
    // Version check after healthy
    mockFetchHealthy("1.1.53");

    const result = await ensureServer({
      baseUrl: "http://127.0.0.1:4096",
      startupTimeoutMs: 5_000,
    });

    expect(result.running).toBe(true);
    expect(result.managedByUs).toBe(true);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("/usr/local/bin/opencode"),
    );
  });
});

// ─── startServer ─────────────────────────────────────────────────────────

describe("startServer", () => {
  it("spawns opencode serve with correct port", async () => {
    const fakeChild = createFakeChild();
    spawnMock.mockReturnValueOnce(fakeChild as any);

    // Health poll succeeds immediately
    mockFetchHealthy("1.1.53");
    // Version check
    mockFetchHealthy("1.1.53");

    const result = await startServer(
      "/usr/local/bin/opencode",
      "http://127.0.0.1:4096",
      5_000,
    );

    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/local/bin/opencode",
      ["serve", "--port", "4096"],
      expect.objectContaining({
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      }),
    );
    expect(result.version).toBe("1.1.53");
  });

  it("passes custom hostname when not localhost", async () => {
    const fakeChild = createFakeChild();
    spawnMock.mockReturnValueOnce(fakeChild as any);

    mockFetchHealthy("1.1.53");
    mockFetchHealthy("1.1.53");

    await startServer(
      "/usr/local/bin/opencode",
      "http://192.168.1.100:5000",
      5_000,
    );

    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/local/bin/opencode",
      ["serve", "--port", "5000", "--hostname", "192.168.1.100"],
      expect.anything(),
    );
  });

  it("throws when server does not become healthy in time", async () => {
    const fakeChild = createFakeChild();
    spawnMock.mockReturnValueOnce(fakeChild as any);

    // All health checks fail
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      startServer(
        "/usr/local/bin/opencode",
        "http://127.0.0.1:4096",
        1_000, // short timeout
      ),
    ).rejects.toThrow("did not become healthy");
  });

  it("throws when child process exits with non-zero code", async () => {
    const fakeChild = createFakeChild();
    spawnMock.mockReturnValueOnce(fakeChild as any);

    // Simulate the child exiting with error before health check succeeds
    // We need to trigger the exit event asynchronously
    setTimeout(() => {
      const exitHandlers = fakeChild._listeners["exit"] ?? [];
      for (const handler of exitHandlers) handler(1);
    }, 100);

    // All health checks fail
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      startServer(
        "/usr/local/bin/opencode",
        "http://127.0.0.1:4096",
        3_000,
      ),
    ).rejects.toThrow(/exited with code 1|did not become healthy/);
  });
});

// ─── stopServer ──────────────────────────────────────────────────────────

describe("stopServer", () => {
  it("does not throw when no managed process exists", () => {
    expect(() => stopServer()).not.toThrow();
  });
});

// ─── Helpers for creating fake child processes ───────────────────────────

function createFakeChild() {
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  return {
    killed: false,
    pid: 12345,
    _listeners: listeners,
    stdout: {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        if (!listeners[`stdout:${event}`]) listeners[`stdout:${event}`] = [];
        listeners[`stdout:${event}`].push(handler);
      }),
    },
    stderr: {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        if (!listeners[`stderr:${event}`]) listeners[`stderr:${event}`] = [];
        listeners[`stderr:${event}`].push(handler);
      }),
    },
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    kill: vi.fn(function (this: { killed: boolean }) {
      this.killed = true;
    }),
  };
}
