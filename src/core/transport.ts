// Octokit transport adapter (research decision: reuse behind adapter).
// Owns: error classification (§5/§22), rate-limit state (§21), bounded
// retry with backoff+jitter for transient READS only, ETag pass-through,
// AbortSignal respect. Fetch is injectable for deterministic tests.
// Credentials never appear in errors or events (G7).

import { Octokit } from "@octokit/core";
import { gitHubError } from "./errors.ts";
import type { GitHubError, RateLimitState } from "./types.ts";

export interface TransportResponse {
  status: number;
  data: unknown;
  etag: string | null;
  headers: Record<string, string>;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Full API path, e.g. /repos/{owner}/{repo}/pulls/42 */
  path: string;
  body?: Record<string, unknown>;
  etag?: string;
  signal?: AbortSignal;
  /** Reads may retry; mutations must NOT auto-retry (G1/G2). */
  allowRetry?: boolean;
}

export interface TransportStats {
  requests: number;
  retries: number;
}

const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 300;

function parseRateLimit(headers: Record<string, string>): RateLimitState | null {
  const remaining = headers["x-ratelimit-remaining"];
  if (remaining === undefined) return null;
  return {
    limit: headers["x-ratelimit-limit"] ? Number(headers["x-ratelimit-limit"]) : null,
    remaining: Number(remaining),
    reset: headers["x-ratelimit-reset"] ? Number(headers["x-ratelimit-reset"]) * 1000 : null,
    resource: headers["x-ratelimit-resource"],
  };
}

function classifyStatus(status: number): GitHubError {
  switch (status) {
    case 401:
      return gitHubError("NOT_AUTHENTICATED", "GitHub rejected the credentials (401)", { status });
    case 403: {
      // 403 doubles as rate-limit exhaustion; differentiated by headers upstream.
      return gitHubError("PERMISSION_DENIED", "GitHub denied the request (403)", {
        status,
        retryable: false,
      });
    }
    case 404:
      return gitHubError("NOT_FOUND", "resource not found (404)", { status });
    case 422:
      return gitHubError("GITHUB_ERROR", "GitHub rejected the payload (422)", { status });
    default:
      if (status === 429 || RETRYABLE_STATUS.has(status)) {
        return gitHubError("NETWORK_ERROR", `transient GitHub response (${status})`, {
          status,
          retryable: true,
        });
      }
      return gitHubError("GITHUB_ERROR", `GitHub error (${status})`, { status });
  }
}

export class GitHubTransport {
  private readonly octokit: Octokit;
  private readonly tokenPresent: boolean;
  private rateLimitState: RateLimitState | null = null;
  readonly stats: TransportStats = { requests: 0, retries: 0 };
  private readonly jitter: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts?: {
    token?: string;
    fetchImpl?: typeof fetch;
    /** Deterministic jitter source for tests. */
    jitter?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }) {
    const token = opts?.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    this.tokenPresent = typeof token === "string" && token.length > 0;
    this.octokit = new Octokit({
      auth: token ?? undefined,
      request: opts?.fetchImpl ? { fetch: opts.fetchImpl } : undefined,
    });
    this.jitter = opts?.jitter ?? Math.random;
    this.sleep = opts?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get authenticated(): boolean {
    return this.tokenPresent;
  }

  get rateLimit(): RateLimitState | null {
    return this.rateLimitState;
  }

  /** One request with bounded retry for transient READ failures. */
  async request(opts: RequestOptions): Promise<TransportResponse> {
    if (!this.tokenPresent) {
      // Fail fast and deterministically: no credential, no network attempt.
      throw gitHubError("NOT_AUTHENTICATED", "no GitHub token (set GH_TOKEN)", { status: 401 });
    }
    const isRead = (opts.method ?? "GET") === "GET";
    const maxAttempts = opts.allowRetry !== false && isRead ? MAX_ATTEMPTS : 1;
    let lastError: GitHubError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (opts.signal?.aborted) {
        throw gitHubError("NETWORK_ERROR", "aborted before request", { retryable: false });
      }
      this.stats.requests++;
      try {
        const response = await this.octokit.request(opts.method ?? "GET /{path}", {
          path: opts.path.replace(/^\//, ""),
          ...(opts.body ? { ...opts.body } : {}),
          headers: {
            Accept: "application/vnd.github+json",
            ...(opts.etag ? { "If-None-Match": opts.etag } : {}),
          },
          request: { signal: opts.signal },
        });
        const headers = response.headers as Record<string, string>;
        const rl = parseRateLimit(headers);
        if (rl) this.rateLimitState = rl;
        return {
          status: response.status,
          data: response.data,
          etag: (headers.etag as string | undefined) ?? null,
          headers,
        };
      } catch (error) {
        lastError = this.normalizeError(error);
        if (!lastError.retryable || attempt === maxAttempts) throw lastError;
        this.stats.retries++;
        const backoff =
          BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(this.jitter() * BASE_BACKOFF_MS);
        await this.sleep(backoff);
      }
    }
    throw lastError ?? gitHubError("NETWORK_ERROR", "request failed", { retryable: true });
  }

  /** Convert octokit/cause errors into our taxonomy; strip any token text. */
  private normalizeError(error: unknown): GitHubError {
    const err = error as {
      status?: number;
      message?: string;
      name?: string;
      cause?: { code?: string };
      response?: { headers?: Record<string, string> };
    };
    if (err?.name === "AbortError" || /abort/i.test(err?.message ?? "")) {
      return gitHubError("NETWORK_ERROR", "request aborted", { retryable: false });
    }
    if (typeof err?.status === "number") {
      const classified = classifyStatus(err.status);
      // 403 with rate-limit headers exhausted → RATE_LIMITED, retryable at reset
      if (err.status === 403) {
        const rl = parseRateLimit((err.response?.headers ?? {}) as Record<string, string>);
        if (rl?.remaining === 0) {
          const limited = gitHubError("RATE_LIMITED", "GitHub rate limit exhausted", {
            status: 403,
          });
          limited.rateLimit = rl;
          return limited;
        }
      }
      if (err.status === 429) {
        const limited = gitHubError("RATE_LIMITED", "GitHub rate limited (429)", {
          status: 429,
          retryable: true,
        });
        return limited;
      }
      return classified;
    }
    if (
      err?.cause?.code === "ENOTFOUND" ||
      err?.cause?.code === "ECONNREFUSED" ||
      err?.name === "TypeError"
    ) {
      return gitHubError("NETWORK_ERROR", "network failure reaching GitHub", { retryable: true });
    }
    const message = (err?.message ?? "unknown error").replace(/gh[pos]_[A-Za-z0-9_]+/g, "[token]");
    return gitHubError("NETWORK_ERROR", `transport failure: ${message}`, { retryable: true });
  }
}
