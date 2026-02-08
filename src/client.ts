/**
 * HTTP client wrapper for the OpenCode server API.
 *
 * Features:
 *  - Basic auth support
 *  - Automatic retry with exponential backoff for transient errors
 *  - Proper 204 No Content handling on all methods
 *  - SSE streaming support
 *  - Error categorization (transient vs permanent)
 */

export interface OpenCodeClientOptions {
  baseUrl: string;
  username?: string;
  password?: string;
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

export class OpenCodeClient {
  private baseUrl: string;
  private authHeader?: string;

  constructor(options: OpenCodeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    if (options.password) {
      const username = options.username ?? "opencode";
      this.authHeader =
        "Basic " +
        Buffer.from(`${username}:${options.password}`).toString("base64");
    }
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private buildUrl(path: string, query?: Record<string, string>): string {
    const url = new URL(path, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, value);
        }
      }
    }
    return url.toString();
  }

  private headers(accept?: string, directory?: string): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: accept ?? "application/json",
    };
    if (this.authHeader) {
      h["Authorization"] = this.authHeader;
    }
    if (directory) {
      h["x-opencode-directory"] = directory;
    }
    return h;
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
    const url = this.buildUrl(path, opts?.query);
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }

      try {
        const controller = new AbortController();
        const timeoutId = opts?.timeout
          ? setTimeout(() => controller.abort(), opts.timeout)
          : undefined;

        const res = await fetch(url, {
          method,
          headers: this.headers(undefined, opts?.directory),
          body:
            opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: controller.signal,
        });

        if (timeoutId) clearTimeout(timeoutId);

        if (!res.ok) {
          const text = await res.text();
          const err = new OpenCodeError(
            `${method} ${path} failed (${res.status}): ${text}`,
            res.status,
            method,
            path,
            text,
          );
          if (err.isTransient && attempt < MAX_RETRIES) {
            lastError = err;
            continue;
          }
          throw err;
        }

        // Handle 204 No Content
        if (res.status === 204) {
          return undefined as T;
        }

        const contentType = res.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          return (await res.json()) as T;
        }
        // Return text for non-JSON responses
        return (await res.text()) as unknown as T;
      } catch (e) {
        if (e instanceof OpenCodeError) throw e;
        lastError = e as Error;
        if (attempt >= MAX_RETRIES) break;
      }
    }

    throw lastError ?? new Error(`${method} ${path} failed after retries`);
  }

  async get<T = unknown>(
    path: string,
    query?: Record<string, string>,
    directory?: string,
  ): Promise<T> {
    return this.request<T>("GET", path, { query, directory });
  }

  async post<T = unknown>(
    path: string,
    body?: unknown,
    opts?: { timeout?: number; directory?: string },
  ): Promise<T> {
    return this.request<T>("POST", path, {
      body,
      timeout: opts?.timeout,
      directory: opts?.directory,
    });
  }

  async patch<T = unknown>(
    path: string,
    body?: unknown,
    directory?: string,
  ): Promise<T> {
    return this.request<T>("PATCH", path, { body, directory });
  }

  async put<T = unknown>(
    path: string,
    body?: unknown,
    directory?: string,
  ): Promise<T> {
    return this.request<T>("PUT", path, { body, directory });
  }

  async delete<T = unknown>(
    path: string,
    query?: Record<string, string>,
    directory?: string,
  ): Promise<T> {
    return this.request<T>("DELETE", path, { query, directory });
  }

  /**
   * Subscribe to SSE events. Returns an async iterable of parsed events.
   * The caller should break out of the loop when done.
   */
  async *subscribeSSE(
    path: string,
  ): AsyncGenerator<{ event: string; data: string }, void, undefined> {
    const url = this.buildUrl(path);
    const res = await fetch(url, {
      method: "GET",
      headers: {
        ...this.headers("text/event-stream"),
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new OpenCodeError(
        `SSE ${path} failed (${res.status}): ${text}`,
        res.status,
        "GET",
        path,
        text,
      );
    }

    if (!res.body) {
      throw new Error("No response body for SSE stream");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";
    let currentData = "";

    try {
      while (true) {
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
      reader.releaseLock();
    }
  }
}
