// Pure core types. No Pi imports. Operational identities and bounded shapes.

/** GitHub resource identity — stable across versions. */
export type ResourceKind = "repo" | "commit" | "branch" | "pr" | "issue" | "release";

/**
 * Concise versioned refs (§38): unambiguous, bounded, parseable,
 * version-safe. The @version suffix is the resource VERSION identity,
 * not part of the resource identity.
 *   gh:repo:owner/name
 *   gh:commit:owner/name@sha
 *   gh:branch:owner/name@refs/heads/main
 *   gh:pr:owner/name#42
 *   gh:issue:owner/name#17
 *   gh:release:owner/name@v1.2.0
 */
export interface ResourceRef {
  kind: ResourceKind;
  owner: string;
  repo: string;
  /** PR/issue number. */
  number?: number;
  /** Commit SHA, branch ref, or release tag (kind-specific). */
  versionMarker?: string;
}

export interface ResourceVersion {
  /** Strongest available version marker (ETag, head SHA, updated_at…). */
  etag?: string;
  /** Semantic version marker when available (immutable SHAs win). */
  sha?: string;
  updatedAt?: string;
  fetchedAt: number;
}

export interface CacheEntry {
  ref: ResourceRef;
  version: ResourceVersion;
  /** Full JSON payload (bounded). */
  value: unknown;
  /** Rough byte estimate for cache bounding. */
  bytes: number;
  /** Last-access counter for deterministic LRU eviction. */
  lastUsed: number;
}

export type FetchOutcome = "memory-hit" | "conditional-hit" | "network-fetch";

/** Auth/rate/network failure taxonomy (§5, §22). Never includes tokens. */
export type GitHubErrorCode =
  | "NOT_AUTHENTICATED"
  | "TOKEN_EXPIRED"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "GITHUB_ERROR";

export interface GitHubError extends Error {
  code: GitHubErrorCode;
  retryable: boolean;
  status?: number;
  rateLimit?: RateLimitState;
}

export interface RateLimitState {
  limit: number | null;
  remaining: number | null;
  /** Epoch ms when the quota resets; null when unknown. */
  reset: number | null;
  resource?: string;
}

/** Explicit truncation envelope (G6): bounds + markers, never silent. */
export interface BoundedText {
  text: string;
  truncated: boolean;
  originalChars: number;
}

/** Mutation journal states (§27). `unknown` = outcome uncertain (§29). */
export type MutationState =
  "not-started" | "started" | "completed" | "failed" | "cancelled" | "unknown";

export interface MutationRecord {
  v: 1;
  operationId: string;
  /** Deterministic digest over material mutation intent (§28). */
  intentDigest: string;
  repository: string;
  resourceRef: string;
  operation: string;
  /** Reconciliation token (e.g. issue id marker) — never credentials. */
  requestMarker?: string;
  /** Result resource ref/id once known. */
  resultRef?: string;
  state: MutationState;
  reason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MutationIntent {
  operation:
    | "create_issue"
    | "comment"
    | "update_issue"
    | "create_pr"
    | "merge_pr"
    | "add_labels"
    | "ci_control";
  repository: string;
  /** Material fields per operation (validated in mutations.ts). */
  fields: Record<string, string | number | string[] | undefined>;
}

/** Health snapshot (§50) — UI/diagnostic only, never model context. */
export interface GitHubHealth {
  auth: "healthy" | "unavailable" | "permission-problem" | "unknown";
  cache: { entries: number; bytes: number };
  rateLimit: RateLimitState | null;
  journal: { state: "healthy" | "degraded"; pending: number; unknown: number };
}
