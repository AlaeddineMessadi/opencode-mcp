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
    const authorization = "Basic " + Buffer.from("opencode:fixture-password").toString("base64");
    http = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== authorization) { res.statusCode = 401; res.end('{"_tag":"UnauthorizedError"}'); return; }
      if (new URL(req.url!, "http://fixture").pathname !== "/api/info") { res.statusCode = 404; res.end("{}"); return; }
      // OpenCode 2.x ServerInfo; an unhealthy server answers with a 5xx.
      if (!healthy) { res.statusCode = 503; res.end('{"_tag":"Unavailable"}'); return; }
      res.end(JSON.stringify({ version: "2.1.2", pid: process.pid, urls: [], paths: { tmp: "/tmp" } }));
    });
    await new Promise<void>((resolve) => http!.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url))], {
      env: { ...process.env, OPENCODE_BASE_URL: baseUrl, OPENCODE_AUTO_SERVE: "false",
        OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: "fixture-password" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    let log = "";
    await new Promise<void>((resolve, reject) => {
      child!.stderr!.on("data", (chunk) => {
        log += chunk;
        if (log.includes("opencode-mcp v4.0.0 started (")) resolve();
      });
      child!.once("error", reject);
      child!.once("exit", () => reject(new Error(`Premature exit: ${log}`)));
    });
    child.stdin!.end();
    const [code] = await exited;
    expect(code).toBe(0);
    // Disconnect must leave externally owned servers alive.
    const probe = await fetch(baseUrl + "/api/info", { headers: { authorization } });
    expect(probe.status).toBe(healthy ? 200 : 503);
  }, 5000);
});
