import { hostname } from "node:os";

export interface AuthOptions {
  /** HTTP Basic credentials for an OpenCode server started with OPENCODE_SERVER_PASSWORD. */
  username?: string;
  password?: string;
  /** Static bearer token, sent as `Authorization: Bearer <token>`. */
  token?: string;
  /** OpenChamber UI password, exchanged for a bearer client token. */
  openchamberPassword?: string;
  /** OpenChamber origin hosting `/auth/session`; defaults to the base URL's origin. */
  openchamberUrl?: string;
}

const LOGIN_TIMEOUT_MS = 15_000;

/**
 * Resolves the `Authorization` header for OpenCode requests.
 *
 * Precedence: OpenChamber login, then a static bearer token, then Basic auth.
 * An OpenChamber client token is obtained lazily, cached in memory only, and
 * renewed once when a request is rejected with 401.
 */
export class AuthProvider {
  private token?: string;
  private login?: Promise<string>;

  constructor(private readonly options: AuthOptions, private readonly baseUrl: string) {
    this.token = options.openchamberPassword ? undefined : options.token || undefined;
  }

  /** True when a rejected token can be renewed without user action. */
  get canRefresh(): boolean {
    return Boolean(this.options.openchamberPassword);
  }

  async getHeader(): Promise<string | undefined> {
    if (this.options.openchamberPassword) {
      return `Bearer ${this.token ?? await this.signIn()}`;
    }
    if (this.token) return `Bearer ${this.token}`;
    const { username, password } = this.options;
    if (!password) return undefined;
    return "Basic " + Buffer.from(`${username ?? "opencode"}:${password}`).toString("base64");
  }

  /**
   * Discard the rejected header and sign in again. Concurrent callers that
   * observed the same rejected header share one login.
   */
  async refresh(rejected: string | undefined): Promise<string | undefined> {
    if (!this.canRefresh) return undefined;
    if (rejected && rejected !== `Bearer ${this.token}` && this.token) return `Bearer ${this.token}`;
    this.token = undefined;
    return `Bearer ${await this.signIn()}`;
  }

  private signIn(): Promise<string> {
    this.login ??= this.requestClientToken().then(
      (token) => { this.token = token; return token; },
    ).finally(() => { this.login = undefined; });
    return this.login;
  }

  private async requestClientToken(): Promise<string> {
    const origin = new URL(this.options.openchamberUrl || this.baseUrl).origin;
    const host = hostname();
    let res: Response;
    try {
      res = await fetch(`${origin}/auth/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          password: this.options.openchamberPassword,
          issueClientToken: true,
          trustDevice: true,
          clientLabel: `opencode-mcp (${host})`,
          clientKind: "desktop",
          dedupeKey: `opencode-mcp:${host}`,
        }),
        signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`OpenChamber login to ${origin} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      throw new Error(`OpenChamber login to ${origin} is rate limited${retryAfter ? `; retry after ${retryAfter}s` : ""}`);
    }
    if (res.status === 401) {
      throw new Error(`OpenChamber login to ${origin} was rejected; check OPENCODE_OPENCHAMBER_PASSWORD`);
    }
    if (!res.ok) throw new Error(`OpenChamber login to ${origin} failed (${res.status})`);
    const body = await res.json().catch(() => undefined) as { clientToken?: unknown } | undefined;
    if (typeof body?.clientToken !== "string" || !body.clientToken) {
      throw new Error(`OpenChamber at ${origin} did not issue a client token; upgrade OpenChamber or set OPENCODE_SERVER_TOKEN`);
    }
    return body.clientToken;
  }

  /**
   * `fetch` that applies the current header and, for renewable credentials,
   * retries once after a 401. The rejected request never reached OpenCode, so
   * resending it cannot duplicate a write.
   */
  async fetch(request: Request): Promise<Response> {
    const header = await this.getHeader();
    const retry = this.canRefresh ? request.clone() : undefined;
    const response = await fetch(withAuthorization(request, header));
    if (response.status !== 401 || !retry) return response;
    const renewed = await this.refresh(header);
    if (!renewed) return response;
    await response.body?.cancel().catch(() => {});
    return fetch(withAuthorization(retry, renewed));
  }
}

function withAuthorization(request: Request, header: string | undefined): Request {
  if (!header) return request;
  const headers = new Headers(request.headers);
  headers.set("Authorization", header);
  return new Request(request, { headers });
}
