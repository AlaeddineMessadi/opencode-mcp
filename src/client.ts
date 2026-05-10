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

    const headers: Record<string, string> = {};
    if (options.password) {
      const username = options.username ?? "opencode";
      headers["Authorization"] = "Basic " + Buffer.from(`${username}:${options.password}`).toString("base64");
    }

    this.api = createOpencodeClient({
      baseUrl: this.baseUrl,
      headers
    });
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
          headers["x-opencode-directory"] = encodeURIComponent(normalized);
        }

        const apiClient = (this.api as any)._client;
        let res;
        switch (method.toUpperCase()) {
          case 'GET':
            res = await apiClient.get({ url: path, query: opts?.query, headers });
            break;
          case 'POST':
            res = await apiClient.post({ url: path, query: opts?.query, body: opts?.body as any, headers });
            break;
          case 'PATCH':
            res = await apiClient.patch({ url: path, query: opts?.query, body: opts?.body as any, headers });
            break;
          case 'PUT':
            res = await apiClient.put({ url: path, query: opts?.query, body: opts?.body as any, headers });
            break;
          case 'DELETE':
            res = await apiClient.delete({ url: path, query: opts?.query, headers });
            break;
          default:
            throw new Error(`Unsupported method ${method}`);
        }

        if (res.error) {
          const status = res.response?.status || 500;
          const bodyStr = typeof res.error === 'string' ? res.error : JSON.stringify(res.error);
          const err = new OpenCodeError(`${method} ${path} failed (${status}): ${bodyStr}`, status, method, path, bodyStr);
          if (err.isTransient && attempt < MAX_RETRIES) {
            lastError = err;
            continue;
          }
          throw err;
        }

        return res.data as T;
      } catch (e) {
        if (e instanceof OpenCodeError) throw e;
        lastError = e as Error;
        if (attempt >= MAX_RETRIES) break;
      }
    }

    if (
      this.autoServe &&
      this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS &&
      lastError &&
      isConnectionError(lastError)
    ) {
      this.reconnectAttempts++;
      console.error(
        `Connection failed (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}), attempting server reconnection...`,
      );
      try {
        const status = await isServerRunning(this.baseUrl);
        if (!status.healthy) {
          await ensureServer({ 
            baseUrl: this.baseUrl, 
            autoServe: true,
            username: this.username,
            password: this.password
          });
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
    if (this.password) {
      const username = this.username ?? "opencode";
      headers["Authorization"] = "Basic " + Buffer.from(`${username}:${this.password}`).toString("base64");
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
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
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
