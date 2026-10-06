// Resource layer (§10-§20): reads through cache + conditional requests +
// singleflight; purpose-specific projections; mutation-aware invalidation
// (G5); snapshot registry for model-visible "unchanged" results (§18).

import { STACK_INFO } from "../info.ts";
import { gitHubError } from "./errors.ts";
import type { MutationEngine } from "./mutations.ts";
import { ResourceCache, refKey, ttlForKind, estimateBytes } from "./cache.ts";
import { Singleflight } from "./singleflight.ts";
import {
  renderCommitSummary,
  renderIssueSummary,
  renderPrSummary,
  renderRepoSummary,
  renderReleaseSummary,
  renderFilePatch,
  type ReviewSummary,
} from "./projections.ts";
import { formatRef } from "./refs.ts";
import type { GitHubTransport } from "./transport.ts";
import type { FetchOutcome, MutationIntent, ResourceRef, ResourceVersion } from "./types.ts";

export interface ReadResult {
  ref: ResourceRef;
  outcome: FetchOutcome;
  /** Concise model-visible projection. */
  projection: string;
  /** Snapshot id (short) for unchanged-detection on subsequent reads. */
  snapshotId: string;
  resourceVersion: ResourceVersion;
  apiCalls: number;
}

interface PrFile {
  filename?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

function snapshotIdFor(ref: ResourceRef, version: ResourceVersion): string {
  // Concise, stable: kind+identity+strongest version marker
  const marker = version.sha ?? version.etag ?? version.updatedAt ?? String(version.fetchedAt);
  return `${ref.kind}-${ref.owner}-${ref.repo}-${ref.number ?? ""}-${marker}`.slice(0, 80);
}

export class GitHubResources {
  readonly cache: ResourceCache;
  readonly singleflight = new Singleflight();
  readonly snapshots = new Map<string, string>(); // snapshotId -> projection
  private projectionByKey = new Map<
    string,
    { snapshotId: string; projection: string; version: ResourceVersion }
  >();

  constructor(
    private readonly transport: GitHubTransport,
    mutations: MutationEngine,
    now: () => number = Date.now,
    private readonly onResourceChanged?: (payload: Record<string, unknown>) => void,
  ) {
    void mutations;
    this.cache = new ResourceCache(now);
  }

  health(): { entries: number; bytes: number } {
    return { entries: this.cache.size, bytes: this.cache.bytes };
  }

  /**
   * Read + project one resource. Internally may issue several API calls
   * (§8) — all cached, coalesced, and counted; the caller sees ONE result.
   */
  async read(
    ref: ResourceRef,
    opts?: { signal?: AbortSignal; knownSnapshot?: string; withFiles?: boolean },
  ): Promise<ReadResult> {
    const key = refKey(ref);
    return this.singleflight.run(key, async () => {
      const fresh = this.cache.peekFresh(ref);
      if (fresh) {
        // Enriched projection is cached per resource version: a memory hit
        // makes ZERO underlying API calls (reviews included).
        const snapshotId = snapshotIdFor(ref, fresh.version);
        const cachedProjection = this.projectionByKey.get(key);
        if (cachedProjection && cachedProjection.snapshotId === snapshotId) {
          this.emitChanged(ref, "memory-hit", snapshotId);
          return this.unchangedAware(
            {
              ref,
              outcome: "memory-hit",
              projection: cachedProjection.projection,
              snapshotId,
              resourceVersion: fresh.version,
              apiCalls: 0,
            },
            opts,
          );
        }
        return this.project(ref, fresh, "memory-hit", 0, opts);
      }

      const cached = this.cache.peekForValidation(ref);
      if (cached) {
        const response = await this.transport.request({
          path: this.apiPath(ref),
          etag: cached.version.etag,
          signal: opts?.signal,
        });
        if (response.status === 304) {
          // Conditional validation hit: refresh freshness, no retransfer.
          const entry = this.cache.put(
            ref,
            cached.value,
            response.etag ?? cached.version.etag ?? null,
            cached.version.sha,
            cached.version.updatedAt,
          );
          return this.project(ref, entry, "conditional-hit", 1, opts);
        }
        const entry = this.cache.put(
          ref,
          response.data,
          response.etag,
          this.shaOf(ref, response.data),
          this.updatedAtOf(response.data),
        );
        return this.project(ref, entry, "network-fetch", 1, opts);
      }

      const response = await this.transport.request({
        path: this.apiPath(ref),
        signal: opts?.signal,
      });
      const entry = this.cache.put(
        ref,
        response.data,
        response.etag,
        this.shaOf(ref, response.data),
        this.updatedAtOf(response.data),
      );
      return this.project(ref, entry, "network-fetch", 1, opts);
    });
  }

  /** PR file patch on demand (§42). */
  async prFilePatch(
    ref: ResourceRef,
    filename: string,
    opts?: { signal?: AbortSignal },
  ): Promise<string> {
    if (ref.kind !== "pr") throw gitHubError("GITHUB_ERROR", "prFilePatch requires a pr ref");
    const files = await this.transport.request({
      path: `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files?per_page=100`,
      signal: opts?.signal,
    });
    const list = files.data as PrFile[];
    const file = Array.isArray(list) ? list.find((f) => f.filename === filename) : undefined;
    if (!file) throw gitHubError("NOT_FOUND", `file not in PR: ${filename}`, { status: 404 });
    return renderFilePatch(filename, file.patch);
  }

  // -- mutation invalidation (G5) -------------------------------------------

  /** Invalidate cache affected by a mutation; returns dropped entry count. */
  invalidateFor(intent: MutationIntent): number {
    const [owner, repo] = intent.repository.split("/");
    const sameRepo = (ref: ResourceRef): boolean => ref.owner === owner && ref.repo === repo;
    switch (intent.operation) {
      case "comment":
      case "update_issue":
      case "add_labels": {
        const number = intent.fields.number as number | undefined;
        return this.cache.invalidate(
          (ref) =>
            sameRepo(ref) &&
            (ref.kind === "issue" || ref.kind === "pr") &&
            (number === undefined || ref.number === number),
        );
      }
      case "create_issue":
        return this.cache.invalidate((ref) => sameRepo(ref) && ref.kind === "repo");
      case "merge_pr": {
        const number = intent.fields.number as number | undefined;
        return this.cache.invalidate(
          (ref) =>
            sameRepo(ref) &&
            ((ref.kind === "pr" && (number === undefined || ref.number === number)) ||
              ref.kind === "branch" ||
              ref.kind === "commit"),
        );
      }
      case "create_pr":
        return this.cache.invalidate(
          (ref) => sameRepo(ref) && (ref.kind === "repo" || ref.kind === "branch"),
        );
      default:
        return 0;
    }
  }

  // -- internals --------------------------------------------------------------

  private apiPath(ref: ResourceRef): string {
    switch (ref.kind) {
      case "repo":
        return `/repos/${ref.owner}/${ref.repo}`;
      case "commit":
        return `/repos/${ref.owner}/${ref.repo}/commits/${ref.versionMarker}`;
      case "branch":
        return `/repos/${ref.owner}/${ref.repo}/branches/${encodeURIComponent(ref.versionMarker ?? "")}`;
      case "pr":
        return `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
      case "issue":
        return `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`;
      case "release":
        return `/repos/${ref.owner}/${ref.repo}/releases/tags/${encodeURIComponent(ref.versionMarker ?? "")}`;
      default: {
        const exhaustive: never = ref.kind;
        throw gitHubError("GITHUB_ERROR", `unsupported ref kind: ${String(exhaustive)}`);
      }
    }
  }

  private shaOf(ref: ResourceRef, data: unknown): string | undefined {
    if (ref.kind === "commit" && ref.versionMarker) return ref.versionMarker;
    const d = data as { head?: { sha?: string }; sha?: string } | null;
    return d?.head?.sha ?? d?.sha;
  }

  private updatedAtOf(data: unknown): string | undefined {
    const d = data as { updated_at?: string; pushed_at?: string } | null;
    return d?.updated_at ?? d?.pushed_at;
  }

  /** Build the projection; PR summaries may add reviews/files (§8). */
  private async project(
    ref: ResourceRef,
    entry: {
      value: unknown;
      version: { sha?: string; etag?: string; updatedAt?: string; fetchedAt: number };
    },
    outcome: FetchOutcome,
    extraCalls: number,
    opts?: { knownSnapshot?: string; withFiles?: boolean; signal?: AbortSignal },
  ): Promise<ReadResult> {
    let projection = "";
    let apiCalls = extraCalls;
    switch (ref.kind) {
      case "repo":
        projection = renderRepoSummary(entry.value as never);
        break;
      case "commit":
        projection = renderCommitSummary(entry.value as never);
        break;
      case "issue":
        projection = renderIssueSummary(entry.value as never);
        break;
      case "release":
        projection = renderReleaseSummary(entry.value as never);
        break;
      case "branch": {
        const b = entry.value as { name?: string; commit?: { sha?: string } };
        projection = `branch ${b.name ?? "?"} @ ${b.commit?.sha?.slice(0, 10) ?? "?"}`;
        break;
      }
      case "pr": {
        const reviews = await this.reviewSummary(ref, () => apiCalls++);
        let files: Array<{ filename?: string; additions?: number; deletions?: number }> | undefined;
        if (opts?.withFiles) {
          const response = await this.transport.request({
            path: `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files?per_page=100`,
            signal: opts?.signal,
          });
          apiCalls++;
          const list = response.data as PrFile[];
          files = Array.isArray(list) ? list : [];
        }
        projection = renderPrSummary(entry.value as never, reviews, files);
        break;
      }
      default: {
        const exhaustive: never = ref.kind;
        throw gitHubError("GITHUB_ERROR", `unsupported projection: ${String(exhaustive)}`);
      }
    }

    const version: ResourceVersion = {
      etag: entry.version.etag,
      sha: entry.version.sha,
      updatedAt: entry.version.updatedAt,
      fetchedAt: entry.version.fetchedAt,
    };
    const snapshotId = snapshotIdFor(ref, version);
    if (this.snapshots.size >= STACK_INFO.quotas.maxSnapshots) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest !== undefined) this.snapshots.delete(oldest);
    }
    this.snapshots.set(snapshotId, projection);
    this.projectionByKey.set(refKey(ref), { snapshotId, projection, version });

    this.emitChanged(ref, outcome, snapshotId);

    return this.unchangedAware(
      { ref, outcome, projection, snapshotId, resourceVersion: version, apiCalls },
      opts,
    );
  }

  private emitChanged(ref: ResourceRef, outcome: FetchOutcome, snapshotId: string): void {
    this.onResourceChanged?.({
      v: 1,
      ref: formatRef(ref),
      kind: ref.kind,
      outcome,
      snapshotId,
    });
  }

  /** §18: a consumed snapshot + unchanged version → compact result. */
  private unchangedAware(result: ReadResult, opts?: { knownSnapshot?: string }): ReadResult {
    if (opts?.knownSnapshot && opts.knownSnapshot === result.snapshotId) {
      return {
        ...result,
        projection: `unchanged\nresource: ${formatRef(result.ref)}\nsnapshot: ${result.snapshotId}`,
      };
    }
    return result;
  }

  /** Review state summary (aggregated; one cached call). */
  private async reviewSummary(
    ref: ResourceRef,
    countCall: () => void,
  ): Promise<ReviewSummary | undefined> {
    try {
      countCall();
      const response = await this.transport.request({
        path: `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews?per_page=50`,
      });
      const reviews = response.data as Array<{ state?: string }>;
      const summary: ReviewSummary = {
        state: "none",
        approved: 0,
        changesRequested: 0,
        commented: 0,
        pending: 0,
      };
      const latest = new Map<string, string>();
      for (const review of (Array.isArray(reviews) ? reviews : []) as Array<{
        state?: string;
        user?: { login?: string };
      }>) {
        if (review.user && review.state) latest.set(String(review.user.login ?? ""), review.state);
      }
      for (const state of latest.values()) {
        if (state === "APPROVED") summary.approved++;
        else if (state === "CHANGES_REQUESTED") summary.changesRequested++;
        else if (state === "COMMENTED") summary.commented++;
        else if (state === "PENDING") summary.pending++;
      }
      summary.state =
        summary.changesRequested > 0
          ? "changes-requested"
          : summary.approved > 0
            ? "approved"
            : summary.pending > 0
              ? "pending"
              : "none";
      return summary;
    } catch {
      return undefined; // review summary is best-effort; PR data is still shown
    }
  }
}

void estimateBytes;
void ttlForKind;
