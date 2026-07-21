import { createOpencodeClient, OpencodeClient as NativeClient } from "@opencode-ai/sdk";
import { normalizeDirectory } from "./helpers.js";
import { ensureServer, isServerRunning } from "./server-manager.js";

export interface OpenCodeClientOptions {
  baseUrl: string;
  username?: string;
  password?: string;
  autoServe?: boolean;
}

export class OpenCodeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(message);
    this.name = "OpenCodeError";
  }

  get isTransient(): boolean {
    return (
      this.status === 429 ||
      this.status === 502 ||
      this.status === 503 ||
      this.status === 504
    );
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 500;
const MAX_RECONNECT_ATTEMPTS = 3;

/**
 * Methods that are safe to replay. Per HTTP semantics GET/HEAD/PUT/DELETE are
 * idempotent; POST and PATCH are not.
 *
 * This distinction matters because several OpenCode endpoints create state:
 * `POST /session` creates a session and `POST /session/:id/message` appends a
 * prompt. Replaying either one after a network error or an abort duplicates it,
 * because the request may well have been delivered and be executing server-side
 * while the client gave up waiting. That is exactly how a single long-running
 * prompt ends up in a session four times (three loop attempts plus one
 * reconnect replay).
 */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE"]);

function isIdempotent(method: string): boolean {
  return IDEMPOTENT_METHODS.has(method.toUpperCase());
}

/**
 * An abort is never safe to replay, even for an idempotent method: the caller's
 * own deadline expired, so retrying only stacks concurrent work on the server.
 */
function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}

function isConnectionError(err: Error): boolean {
  const msg = err.message?.toLowerCase() || "";
  return (
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("ehostunreach") ||
    msg.includes("fetch failed") ||
    msg.includes("network error") ||
    msg.includes("socket hang up")
  );
}

function buildBasicAuthHeader(username?: string, password?: string): string | undefined {
  if (!password) return undefined;
  const user = username ?? "opencode";
  return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
}

export class OpenCodeClient {
  public api: NativeClient;
  private baseUrl: string;
  private autoServe: boolean;
  private reconnectAttempts = 0;
  private username?: string;
  private password?: string;

  constructor(options: OpenCodeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.autoServe = options.autoServe ?? false;
    this.username = options.username;
    this.password = options.password;

    this.api = this.buildSdkClient();
  }

  /**
   * Rebuild the SDK client against the current `baseUrl` + auth state. Used
   * by the constructor and by the reconnect path when `ensureServer()`
   * surfaces a different URL than the one we were aiming at.
   */
  private buildSdkClient(): NativeClient {
    const headers: Record<string, string> = {};
    const authHeader = buildBasicAuthHeader(this.username, this.password);
    if (authHeader) {
      headers["Authorization"] = authHeader;
    }
    return createOpencodeClient({ baseUrl: this.baseUrl, headers });
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    opts?: {
      query?: Record<string, string>;
      body?: unknown;
      timeout?: number;
      directory?: string;
    },
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }

      try {
        const headers: Record<string, string> = {};
        const normalized = normalizeDirectory(opts?.directory);
        if (normalized) {
          // The OpenCode server treats this header as a literal absolute
          // filesystem path. Do NOT URI-encode it — `encodeURIComponent`
          // would turn `/tmp/proj` into `%2Ftmp%2Fproj` and break project
          // scoping for every tool that passes a `directory`.
          headers["x-opencode-directory"] = normalized;
        }

        const apiClient = (this.api as any)._client;
        const controller = opts?.timeout ? new AbortController() : undefined;
        const timer = controller && opts?.timeout ? setTimeout(() => controller.abort(), opts.timeout) : undefined;
        const signal = controller?.signal;
        
        let res;
        try {
          switch (method.toUpperCase()) {
            case 'GET':
              res = await apiClient.get({ url: path, query: opts?.query, headers, signal });
              break;
            case 'POST':
              res = await apiClient.post({ url: path, query: opts?.query, body: opts?.body as any, headers, signal });
              break;
            case 'PATCH':
              res = await apiClient.patch({ url: path, query: opts?.query, body: opts?.body as any, headers, signal });
              break;
            case 'PUT':
              res = await apiClient.put({ url: path, query: opts?.query, body: opts?.body as any, headers, signal });
              break;
            case 'DELETE':
              res = await apiClient.delete({ url: path, query: opts?.query, headers, signal });
              break;
            default:
              throw new Error(`Unsupported method ${method}`);
          }
        } finally {
          if (timer) clearTimeout(timer);
        }

        if (res.error) {
          const status = res.response?.status || 500;
          const bodyStr = typeof res.error === 'string' ? res.error : JSON.stringify(res.error);
          const err = new OpenCodeError(`${method} ${path} failed (${status}): ${bodyStr}`, status, method, path, bodyStr);
          // A non-idempotent request may only be replayed on statuses that prove
          // the server rejected it before doing any work. 502/504 come from a
          // gateway and cannot rule out that the upstream already ran the
          // request, so replaying them would duplicate a session or a prompt.
          const replayable = isIdempotent(method)
            ? err.isTransient
            : status === 429 || status === 503;
          if (replayable && attempt < MAX_RETRIES) {
            lastError = err;
            continue;
          }
          throw err;
        }

        // Successful round-trip — replenish the reconnect budget so a
        // long-lived client doesn't permanently exhaust auto-healing.
        this.reconnectAttempts = 0;
        return res.data as T;
      } catch (e) {
        if (e instanceof OpenCodeError) throw e;
        lastError = e as Error;
        // Network failure or abort: we cannot tell whether the server received
        // and started the request. Replaying a POST/PATCH here is what duplicates
        // prompts, and replaying anything after our own abort just piles work on
        // a server that is still busy with the first attempt.
        if (isAbortError(e) || !isIdempotent(method)) break;
        if (attempt >= MAX_RETRIES) break;
      }
    }

    // The reconnect path below replays the whole request, retry loop included.
    // For a non-idempotent method that is a second chance to duplicate work, so
    // it is limited to methods that are safe to repeat. A dropped POST surfaces
    // as an error the caller can decide about instead.
    if (
      this.autoServe &&
      isIdempotent(method) &&
      this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS &&
      lastError &&
      isConnectionError(lastError)
    ) {
      this.reconnectAttempts++;
      console.error(
        `Connection failed (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}), attempting server reconnection...`,
      );
      try {
        const status = await isServerRunning(
          this.baseUrl,
          this.username,
          this.password,
        );
        if (!status.healthy) {
          const ensured = await ensureServer({
            baseUrl: this.baseUrl,
            autoServe: true,
            username: this.username,
            password: this.password,
          });
          // If `ensureServer()` chose a different URL (e.g. the managed
          // SDK server bound to an alternative port), rebuild the SDK
          // client so the retry targets the live endpoint instead of the
          // dead one we were originally probing.
          if (ensured.url) {
            const normalized = ensured.url.replace(/\/$/, "");
            if (normalized !== this.baseUrl) {
              this.baseUrl = normalized;
              this.api = this.buildSdkClient();
            }
          }
        }
        return this.request<T>(method, path, opts);
      } catch (reconnectErr) {
        console.error(`Server reconnection failed: ${reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr)}`);
      }
    }

    throw lastError ?? new Error(`${method} ${path} failed after retries`);
  }

  async get<T = unknown>(path: string, query?: Record<string, string>, directory?: string): Promise<T> {
    return this.request<T>("GET", path, { query, directory });
  }

  async post<T = unknown>(path: string, body?: unknown, opts?: { timeout?: number; directory?: string }): Promise<T> {
    return this.request<T>("POST", path, { body, timeout: opts?.timeout, directory: opts?.directory });
  }

  async patch<T = unknown>(path: string, body?: unknown, directory?: string): Promise<T> {
    return this.request<T>("PATCH", path, { body, directory });
  }

  async put<T = unknown>(path: string, body?: unknown, directory?: string): Promise<T> {
    return this.request<T>("PUT", path, { body, directory });
  }

  async delete<T = unknown>(path: string, query?: Record<string, string>, directory?: string): Promise<T> {
    return this.request<T>("DELETE", path, { query, directory });
  }

  async *subscribeSSE(path: string, opts?: { signal?: AbortSignal }): AsyncGenerator<{ event: string; data: string }, void, undefined> {
    const url = new URL(path, this.baseUrl).toString();
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
    };
    const authHeader = buildBasicAuthHeader(this.username, this.password);
    if (authHeader) {
      headers["Authorization"] = authHeader;
    }

    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: opts?.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new OpenCodeError(`SSE ${path} failed (${res.status}): ${text}`, res.status, "GET", path, text);
    }

    if (!res.body) throw new Error("No response body for SSE stream");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";
    let currentData = "";

    const abortHandler = () => { try { void reader.cancel().catch(() => {}); } catch {} };
    if (opts?.signal) {
      if (opts.signal.aborted) abortHandler();
      else opts.signal.addEventListener("abort", abortHandler, { once: true });
    }

    try {
      while (true) {
        if (opts?.signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const rawLines = buffer.split("\n");
        buffer = rawLines.pop() ?? "";

        for (const rawLine of rawLines) {
          // SSE per RFC 8895 allows CRLF line endings. Splitting on
          // "\n" leaves a trailing "\r" on each line, which breaks
          // both event-name comparisons (event becomes "message\r")
          // and the blank-line dispatcher (a "blank" CRLF line is
          // "\r", not ""). Strip the trailing CR before processing.
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            currentData = line.slice(5).trim();
          } else if (line === "") {
            if (currentData) {
              yield { event: currentEvent || "message", data: currentData };
              currentEvent = "";
              currentData = "";
            }
          }
        }
      }
    } finally {
      if (opts?.signal) {
        try { opts.signal.removeEventListener("abort", abortHandler); } catch {}
      }
      reader.releaseLock();
    }
  }
}
