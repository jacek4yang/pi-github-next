// Resource-aware bounded cache (§13/§16): per-kind freshness TTLs,
// If-None-Match conditional validation, deterministic LRU eviction by
// entry count AND estimated bytes. Distinguishes memory-hit /
// conditional-hit / network-fetch — a full retransfer is NEVER counted
// as a cache hit (§14).

import { STACK_INFO } from "../info.ts";
import { isImmutableKind } from "./refs.ts";
import type { CacheEntry, FetchOutcome, ResourceRef } from "./types.ts";

const Q = STACK_INFO.quotas;

export function ttlForKind(ref: ResourceRef, value?: unknown): number {
  if (isImmutableKind(ref.kind, ref)) return Number.POSITIVE_INFINITY;
  switch (ref.kind) {
    case "commit":
      return Q.ttlMs.commit;
    case "release":
      return Q.ttlMs.release;
    case "repo":
      return Q.ttlMs.repo;
    case "branch":
      return Q.ttlMs.branch;
    case "pr":
      return Q.ttlMs.pr;
    case "issue":
      // closed issues are stable; open issues churn
      if (value && typeof value === "object" && (value as { state?: string }).state === "closed") {
        return Q.ttlMs.issueClosed;
      }
      return Q.ttlMs.issue;
    default:
      return Q.ttlMs.default;
  }
}

export function refKey(ref: ResourceRef): string {
  return `${ref.kind}:${ref.owner}/${ref.repo}#${ref.number ?? ""}@${ref.versionMarker ?? ""}`;
}

export function estimateBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

export class ResourceCache {
  private entries = new Map<string, CacheEntry>();
  private totalBytes = 0;
  private clockTick = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  /**
   * Return the cached entry when fresh; null when absent/stale.
   * Freshness: immutable kinds never expire; others use their kind TTL.
   */
  peekFresh(ref: ResourceRef): CacheEntry | undefined {
    const entry = this.entries.get(refKey(ref));
    if (!entry) return undefined;
    const ttl = ttlForKind(entry.ref, entry.value);
    if (this.now() - entry.version.fetchedAt >= ttl) return undefined;
    entry.lastUsed = ++this.clockTick;
    return entry;
  }

  /** Entry with a known ETag for conditional validation, if any. */
  peekForValidation(ref: ResourceRef): CacheEntry | undefined {
    const entry = this.entries.get(refKey(ref));
    if (!entry?.version.etag) return undefined;
    entry.lastUsed = ++this.clockTick;
    return entry;
  }

  /** Serve from cache ignoring freshness (e.g. post-304 refresh). */
  peekAny(ref: ResourceRef): CacheEntry | undefined {
    const entry = this.entries.get(refKey(ref));
    if (entry) entry.lastUsed = ++this.clockTick;
    return entry;
  }

  put(
    ref: ResourceRef,
    value: unknown,
    etag: string | null,
    sha?: string,
    updatedAt?: string,
  ): CacheEntry {
    const key = refKey(ref);
    const previous = this.entries.get(key);
    if (previous) {
      this.totalBytes -= previous.bytes;
      this.entries.delete(key);
    }
    const bytes = estimateBytes(value);
    const entry: CacheEntry = {
      ref,
      version: { etag: etag ?? undefined, sha, updatedAt, fetchedAt: this.now() },
      value,
      bytes,
      lastUsed: ++this.clockTick,
    };
    this.entries.set(key, entry);
    this.totalBytes += bytes;
    this.evict();
    return entry;
  }

  /** Mutation invalidation (G5): drop the resource and everything under it. */
  invalidate(match: (ref: ResourceRef) => boolean): number {
    let dropped = 0;
    for (const [key, entry] of [...this.entries.entries()]) {
      if (match(entry.ref)) {
        this.totalBytes -= entry.bytes;
        this.entries.delete(key);
        dropped++;
      }
    }
    return dropped;
  }

  private evict(): void {
    while (this.entries.size > Q.cacheMaxEntries || this.totalBytes > Q.cacheMaxBytes) {
      let oldestKey: string | undefined;
      let oldestTick = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        if (entry.lastUsed < oldestTick) {
          oldestTick = entry.lastUsed;
          oldestKey = key;
        }
        if (oldestTick === 1) break;
      }
      if (!oldestKey) break;
      const victim = this.entries.get(oldestKey)!;
      this.totalBytes -= victim.bytes;
      this.entries.delete(oldestKey);
      if (this.entries.size === 0) break;
    }
  }
}

export type { FetchOutcome };
