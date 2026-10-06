// Public GitHub service exposure (CONTRACTS §12): pi-github-next is the
// SINGLE GitHub resource stack for the Agent Body ecosystem. Consumers
// (pi-ci-next) obtain the shared service over the Pi event bus — an
// in-process request/reply handshake. No sibling imports, no second
// Octokit instance, no duplicated auth/cache/rate-limit/retry/journal.
//
// Handshake: consumer emits `pinx.github.service` with a `serve` callback;
// the provider invokes it synchronously with the service handle. The
// consumer's promise resolves via that callback.

import type { GitHubResources } from "./resources.ts";
import type { GitHubTransport } from "./transport.ts";
import type { MutationEngine, MutationOutcome } from "./mutations.ts";
import type { GitHubError, MutationIntent, RateLimitState, ResourceRef } from "./types.ts";

/** Channel name shared by contract (versioned). */
export const GITHUB_SERVICE_CHANNEL = "pinx.github.service";

export interface GithubService {
  /** Read + project a resource through cache/conditional/singleflight. */
  read(
    ref: ResourceRef,
    opts?: { signal?: AbortSignal; withFiles?: boolean },
  ): Promise<{ projection: string; snapshotId: string; outcome: string; apiCalls: number }>;
  /** Raw transport request for CI-specific endpoints (workflows/runs/jobs/logs). */
  request(opts: {
    path: string;
    method?: "GET" | "POST";
    body?: Record<string, unknown>;
    signal?: AbortSignal;
    allowRetry?: boolean;
  }): Promise<{
    status: number;
    data: unknown;
    etag: string | null;
    headers: Record<string, string>;
  }>;
  /** Execute a mutation with durable journal truth + reconciliation. */
  mutate(
    intent: MutationIntent,
    opts?: { signal?: AbortSignal; cancelled?: () => boolean },
  ): Promise<MutationOutcome>;
  invalidateFor(intent: MutationIntent): number;
  rateLimit(): RateLimitState | null;
  authenticated(): boolean;
  health(): { cache: { entries: number; bytes: number } };
}

interface ServiceRequest {
  v: 1;
  serve: (service: GithubService) => void;
}

export function registerGithubService(
  pi: { events: { on: (channel: string, handler: (payload: unknown) => void) => void } },
  parts: { transport: GitHubTransport; resources: GitHubResources; engine: MutationEngine },
): void {
  const service: GithubService = {
    read: (ref, opts) => parts.resources.read(ref, opts),
    request: (opts) => parts.transport.request(opts),
    mutate: (intent, opts) => parts.engine.execute(intent, opts),
    invalidateFor: (intent) => parts.resources.invalidateFor(intent),
    rateLimit: () => parts.transport.rateLimit,
    authenticated: () => parts.transport.authenticated,
    health: () => ({ cache: parts.resources.health() }),
  };
  pi.events.on(GITHUB_SERVICE_CHANNEL, (payload) => {
    const request = payload as ServiceRequest;
    if (request?.v !== 1 || typeof request.serve !== "function") return;
    request.serve(service);
  });
}

/** Consumer-side helper (structural; pi-ci-next defines the same shape). */
export function requestGithubService(
  pi: { events: { emit: (channel: string, payload: unknown) => void } },
  attempts = 20,
): Promise<GithubService> {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tryOnce = () => {
      n++;
      let answered = false;
      pi.events.emit(GITHUB_SERVICE_CHANNEL, {
        v: 1,
        serve: (service: GithubService) => {
          answered = true;
          resolve(service);
        },
      });
      if (answered) return;
      if (n >= attempts) {
        reject(new Error("github service unavailable — is pi-github-next loaded?") as GitHubError);
        return;
      }
      setTimeout(tryOnce, 50);
    };
    tryOnce();
  });
}
