import type { BackendIdentity, BackendKind } from "./backends/contracts.js";
import { createOpencodeClient, OpencodeClient as NativeClient } from "@opencode-ai/sdk";
import { normalizeDirectory } from "./helpers.js";
import { ensureServer, isServerRunning } from "./server-manager.js";
import { createRequestContext, abortableSleep, throwIfAborted, withAbort, type RequestOptions } from "./async.js";
export type { RequestOptions } from "./async.js";

export interface OpenCodeClientOptions {
  baseUrl: string;
  username?: string;
  password?: string;
  autoServe?: boolean;
  backend?: BackendKind;
  identity?: BackendIdentity;
  unavailableReason?: string;
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

/** The server may have accepted a write whose response was lost. */
export class OpenCodeSubmissionError extends Error {
  readonly submissionOutcome = "unknown" as const;
  constructor(public readonly method: string, public readonly path: string, cause: unknown) {
    super(`${method} ${path}: submission outcome unknown; the server may have accepted this operation. Check its session before retrying. ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "OpenCodeSubmissionError";
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

function buildBasicAuthHeader(username?: string, password?: string): string | undefined {
  if (!password) return undefined;
  const user = username ?? "opencode";
  return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
}

export class OpenCodeClient {
  public api: NativeClient;
  readonly backendIdentity: BackendIdentity;
  private readonly unavailableReason?: string;
  readonly connectionHeaders: Record<string, string>;
  private baseUrl: string;
  private autoServe: boolean;
  private reconnectAttempts = 0;
  private username?: string;
  private password?: string;

  constructor(options: OpenCodeClientOptions) {
    this.unavailableReason = options.unavailableReason;
    this.backendIdentity = options.identity ?? { kind: options.backend ?? "v1", connectionSource: "explicit", ...(options.unavailableReason ? { resolved: false as const } : {}), processOwnership: "external", survivesDisconnect: true };
    const authorization = buildBasicAuthHeader(options.username, options.password);
    this.connectionHeaders = authorization ? { Authorization: authorization } : {};
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

  assertBackendAvailable(): void { if (this.unavailableReason) throw Object.assign(new Error(this.unavailableReason), { code: "BACKEND_UNAVAILABLE" }); }

  getBackendIdentity(): BackendIdentity { return this.backendIdentity; }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    opts: RequestOptions & { query?: Record<string, string>; body?: unknown; directory?: string } = {},
  ): Promise<T> {
    this.assertBackendAvailable();
    // Validate before submission. A malformed local argument cannot be an
    // ambiguous remote mutation and must never trigger retries.
    const normalized = normalizeDirectory(opts.directory);
    const headers: Record<string, string> = normalized ? { "x-opencode-directory": normalized } : {};
    const context = createRequestContext(opts);
    const readOnly = method === "GET";
    let lastError: Error | undefined;
    let submitted = false;
    try {
      for (let attempt = 0; attempt <= (readOnly ? MAX_RETRIES : 0); attempt++) {
        throwIfAborted(context.signal);
        if (attempt > 0) await abortableSleep(BASE_DELAY_MS * Math.pow(2, attempt - 1), context.signal);
        try {
          const apiClient = (this.api as any)._client;
          submitted = true;
          const res = await withAbort(apiClient[method.toLowerCase()]({
            url: path, query: opts.query,
            ...(method !== "GET" && method !== "DELETE" ? { body: opts.body } : {}),
            headers, signal: context.signal,
          }), context.signal) as any;
          // The SDK may return an error object after fetch was aborted.
          throwIfAborted(context.signal);
          if (res.error || (res.response && !res.response.ok && res.response.status >= 400)) {
            const status = res.response?.status || 500;
            const bodyStr = typeof res.error === "string" ? res.error : JSON.stringify(res.error ?? {});
            throw new OpenCodeError(`${method} ${path} failed (${status}): ${bodyStr}`, status, method, path, bodyStr);
          }
          this.reconnectAttempts = 0;
          return res.data as T;
        } catch (e) {
          // Writes may already have been accepted. No generic HTTP status,
          // disconnect or timeout proves it is safe to send them a second time.
          if (!readOnly) {
            if (e instanceof OpenCodeError) throw e;
            throw new OpenCodeSubmissionError(method, path, e);
          }
          throwIfAborted(context.signal);
          lastError = e instanceof Error ? e : new Error(String(e));
          if (e instanceof OpenCodeError && !e.isTransient) throw e;
          if (!(e instanceof OpenCodeError) && !isConnectionError(lastError)) throw e;
        }
      }

      if (this.autoServe && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS && lastError && isConnectionError(lastError)) {
        this.reconnectAttempts++;
        console.error(`Connection failed (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}), attempting server reconnection...`);
        try {
          const status = await withAbort(isServerRunning(this.baseUrl, this.username, this.password), context.signal);
          if (!status.healthy) {
            throwIfAborted(context.signal);
            const ensured = await withAbort(ensureServer({
              baseUrl: this.baseUrl, autoServe: true, username: this.username, password: this.password,
            }), context.signal);
            if (ensured.url) {
              const nextUrl = ensured.url.replace(/\/$/, "");
              if (nextUrl !== this.baseUrl) {
                this.baseUrl = nextUrl;
                this.api = this.buildSdkClient();
              }
            }
          }
          return await this.request<T>(method, path, { ...opts, signal: context.signal, deadline: context.deadline });
        } catch (e) {
          throwIfAborted(context.signal);
          console.error(`Server reconnection failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      throw lastError ?? new Error(`${method} ${path} failed after retries`);
    } catch (error) {
      // Preflight cancellation has no submission ambiguity.
      if (!readOnly && submitted && !(error instanceof OpenCodeError) && !(error instanceof OpenCodeSubmissionError)) {
        throw new OpenCodeSubmissionError(method, path, error);
      }
      throw error;
    } finally {
      context.dispose();
    }
  }

  async get<T = unknown>(path: string, query?: Record<string, string>, directory?: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", path, { ...options, query, directory });
  }

  async post<T = unknown>(path: string, body?: unknown, opts?: RequestOptions & { directory?: string }): Promise<T> {
    return this.request<T>("POST", path, { ...opts, body });
  }

  async patch<T = unknown>(path: string, body?: unknown, directory?: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("PATCH", path, { ...options, body, directory });
  }

  async put<T = unknown>(path: string, body?: unknown, directory?: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("PUT", path, { ...options, body, directory });
  }

  async delete<T = unknown>(path: string, query?: Record<string, string>, directory?: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("DELETE", path, { ...options, query, directory });
  }

  async *subscribeSSE(path: string, opts: RequestOptions & { directory?: string } = {}): AsyncGenerator<{ event: string; data: string }, void, undefined> {
    this.assertBackendAvailable();
    const url = new URL(path, this.baseUrl).toString();
    const headers: Record<string, string> = { Accept: "text/event-stream", "Cache-Control": "no-cache" };
    const normalized = normalizeDirectory(opts.directory);
    if (normalized) headers["x-opencode-directory"] = normalized;
    const authHeader = buildBasicAuthHeader(this.username, this.password);
    if (authHeader) headers["Authorization"] = authHeader;
    const context = createRequestContext(opts, 30_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelReader = () => { void reader?.cancel().catch(() => {}); };
    try {
      throwIfAborted(context.signal);
      const res = await withAbort(fetch(url, { method: "GET", headers, signal: context.signal }), context.signal);
      if (!res.ok) {
        const text = await withAbort(res.text(), context.signal);
        throw new OpenCodeError(`SSE ${path} failed (${res.status}): ${text}`, res.status, "GET", path, text);
      }
      if (!res.body) throw new Error("No response body for SSE stream");
      reader = res.body.getReader();
      context.signal.addEventListener("abort", cancelReader, { once: true });
      const decoder = new TextDecoder();
      let buffer = "";
      let event = "";
      let data: string[] = [];
      while (true) {
        throwIfAborted(context.signal);
        const { done, value } = await withAbort(reader.read(), context.signal);
        throwIfAborted(context.signal);
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        // SSE accepts LF, CRLF and lone CR. Preserve CR across chunk boundaries
        // so a split CRLF is consumed as one separator.
        let match: RegExpExecArray | null;
        while ((match = /\r\n|\r|\n/.exec(buffer))) {
          if (!done && match[0] === "\r" && match.index === buffer.length - 1) break;
          const line = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          if (data.reduce((sum, item) => sum + item.length, 0) + line.length > 1_000_000) {
            throw new Error("SSE event exceeds the 1MB limit");
          }
          if (line === "") {
            if (data.length > 0) yield { event: event || "message", data: data.join("\n") };
            event = "";
            data = [];
          } else if (!line.startsWith(":")) {
            const separator = line.indexOf(":");
            const field = separator < 0 ? line : line.slice(0, separator);
            let content = separator < 0 ? "" : line.slice(separator + 1);
            if (content.startsWith(" ")) content = content.slice(1);
            if (field === "event") event = content;
            if (field === "data") data.push(content);
          }
        }
        // Ignore an unfinished event at EOF, as required by SSE framing.
        if (done) break;
        if (buffer.length + data.reduce((sum, line) => sum + line.length, 0) > 1_000_000) {
          throw new Error("SSE event exceeds the 1MB limit");
        }
      }
    } finally {
      context.signal.removeEventListener("abort", cancelReader);
      context.abort();
      // Cancel the underlying stream on maxEvents/early return as well as
      // errors. Releasing the reader lock alone leaves the HTTP stream open.
      if (reader) {
        // Cancellation itself may be asynchronous in a custom stream; do not
        // let cleanup extend the caller's deadline indefinitely.
        try { void reader.cancel().catch(() => {}); } catch { /* Preserve the stream error. */ }
        reader.releaseLock();
      }
      context.dispose();
    }
  }
}
