import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

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
  /**
   * Overrides the identifier that scopes this instance's OpenChamber
   * `dedupeKey` (`OPENCODE_OPENCHAMBER_CLIENT_ID`). Set this when two MCP
   * instances must intentionally share one client record, e.g. across
   * restarts; otherwise a random one is generated per process.
   */
  clientId?: string;
}

const LOGIN_TIMEOUT_MS = 15_000;
/** How long a refused sign-in is reported again when OpenChamber gives no better hint. */
const LOGIN_COOLDOWN_MS = 60_000;

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
  /**
   * The last sign-in OpenChamber refused. Every tool call and client retry
   * would otherwise post the password again. OpenChamber locks out the client
   * IP, UI included, for 15 minutes after 10 failures with less than 5 minutes
   * between them.
   */
  private failure?: { error: Error; until: number };

  /**
   * Identifies this MCP instance to OpenChamber. Stable for the lifetime of
   * the provider (and thus reused for every renewal), but unique per
   * instance so a second independent MCP instance on the same host cannot
   * replace this one's client record: OpenChamber (1.12 and later) revokes
   * the previous client record whenever a login reuses a `dedupeKey` (see
   * https://github.com/openchamber/openchamber/blob/v1.24.2/packages/web/
   * server/lib/client-auth/remote-clients.js), so a key derived
   * only from `hostname()` let a second MCP process silently invalidate the
   * first one's cached token. Override with `OPENCODE_OPENCHAMBER_CLIENT_ID`
   * when two instances must intentionally share one client record, e.g.
   * across restarts of a supervised process that should keep one slot.
   */
  private readonly instanceId: string;

  constructor(private readonly options: AuthOptions, private readonly baseUrl: string) {
    this.token = options.openchamberPassword ? undefined : options.token || undefined;
    this.instanceId = options.clientId || `${process.pid}-${randomUUID()}`;
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
    if (this.failure && Date.now() < this.failure.until) return Promise.reject(this.failure.error);
    this.login ??= this.requestClientToken().then(
      (token) => { this.failure = undefined; this.token = token; return token; },
      (error) => {
        // Network errors and 5xx never reached OpenChamber's limiter, so the next call retries.
        if (error instanceof LoginRejected) this.failure = { error, until: Date.now() + error.cooldownMs };
        throw error;
      },
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
          // Scoped to this instance, not just this host: see `instanceId` above.
          dedupeKey: `opencode-mcp:${host}:${this.instanceId}`,
        }),
        signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`OpenChamber login to ${origin} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (res.status === 429) {
      const waitMs = retryAfterMs(res.headers.get("retry-after"));
      throw new LoginRejected(`OpenChamber login to ${origin} is rate limited; retry after ${Math.ceil(waitMs / 1000)}s`, waitMs);
    }
    if (res.status === 401) {
      // The password comes from the environment, so retrying before a restart can only add failures.
      throw new LoginRejected(
        `OpenChamber login to ${origin} was rejected; check OPENCODE_OPENCHAMBER_PASSWORD and restart opencode-mcp`,
        Infinity,
      );
    }
    if (res.status >= 500) throw new Error(`OpenChamber login to ${origin} failed (${res.status})`);
    if (!res.ok) throw new LoginRejected(`OpenChamber login to ${origin} failed (${res.status})`);
    const body = await res.json().catch(() => undefined) as { clientToken?: unknown } | undefined;
    if (typeof body?.clientToken !== "string" || !body.clientToken) {
      throw new LoginRejected(
        `OpenChamber at ${origin} did not issue a client token; upgrade OpenChamber or set OPENCODE_SERVER_TOKEN`,
        Infinity,
      );
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

/** A sign-in OpenChamber answered and refused, so repeating it within `cooldownMs` would fail the same way. */
class LoginRejected extends Error {
  constructor(message: string, readonly cooldownMs = LOGIN_COOLDOWN_MS) {
    super(message);
  }
}

/** Parses `Retry-After` (seconds or an HTTP date); missing, invalid or past values fall back to the default cooldown. */
export function retryAfterMs(value: string | null): number {
  if (!value) return LOGIN_COOLDOWN_MS;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? ms : LOGIN_COOLDOWN_MS;
}

function withAuthorization(request: Request, header: string | undefined): Request {
  if (!header) return request;
  const headers = new Headers(request.headers);
  headers.set("Authorization", header);
  return new Request(request, { headers });
}
