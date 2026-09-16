import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

describe("MCP process lifecycle", () => {
  let http: Server | undefined;
  let child: ChildProcess | undefined;
  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
    if (http) {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http!.close(() => resolve()));
    }
  });

  it.each([true, false])("exits on stdin EOF with healthy server = %s", async (healthy) => {
    http = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ healthy, version: "fixture" }));
    });
    await new Promise<void>((resolve) => http!.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url))], {
      env: { ...process.env, OPENCODE_BASE_URL: baseUrl, OPENCODE_AUTO_SERVE: "false" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    let log = "";
    await new Promise<void>((resolve, reject) => {
      child!.stderr!.on("data", (chunk) => {
        log += chunk;
        if (log.includes("opencode-mcp v3.0.0 started (")) resolve();
      });
      child!.once("error", reject);
      child!.once("exit", () => reject(new Error(`Premature exit: ${log}`)));
    });
    child.stdin!.end();
    const [code] = await exited;
    expect(code).toBe(0);
    // Disconnect must leave externally owned servers alive.
    expect((await fetch(baseUrl + "/global/health")).ok).toBe(true);
  }, 5000);
});
