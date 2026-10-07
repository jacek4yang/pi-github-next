// Mutations (§24-§30): bounded set, deterministic intent digest over
// material fields only, durable journal as side-effect truth, and
// operation-specific reconciliation for UNKNOWN outcomes (network drop
// after possible commit). A known-completed mutation is NEVER re-executed
// (G1); unknown outcomes are reconciled or fail closed — never blindly
// retried (G2); material identity changes invalidate reuse (G3).

import { createHash } from "node:crypto";
import { gitHubError } from "./errors.ts";
import type { MutationJournal } from "./journal.ts";
import type { GitHubError, MutationIntent, MutationRecord } from "./types.ts";
import type { GitHubTransport } from "./transport.ts";

const RECON_MARKER_PREFIX = "pinx-github-next op:";

/** Deterministic intent digest: canonical material fields only. */
export function intentDigest(intent: MutationIntent): string {
  const canonical = JSON.stringify({
    operation: intent.operation,
    repository: intent.repository,
    fields: Object.keys(intent.fields)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        const value = intent.fields[key];
        acc[key] = value;
        return acc;
      }, {}),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Stable operation id derived from the intent digest (idempotency key). */
export function operationIdFor(intent: MutationIntent): string {
  return `op_${intentDigest(intent).slice(0, 24)}`;
}

/** Embedded reconciliation marker for idempotent creation semantics. */
export function reconciliationMarker(intent: MutationIntent): string {
  return `${RECON_MARKER_PREFIX}${operationIdFor(intent)}`;
}

function validateIntent(intent: MutationIntent): void {
  if (!/^[^/]+\/[^/]+$/.test(intent.repository)) {
    throw gitHubError("GITHUB_ERROR", `invalid repository: ${intent.repository}`);
  }
  switch (intent.operation) {
    case "create_issue": {
      const title = intent.fields.title;
      if (typeof title !== "string" || title.length === 0) {
        throw gitHubError("GITHUB_ERROR", "create_issue requires a title");
      }
      break;
    }
    case "comment": {
      if (typeof intent.fields.number !== "number") {
        throw gitHubError("GITHUB_ERROR", "comment requires an issue/PR number");
      }
      if (typeof intent.fields.body !== "string" || intent.fields.body.length === 0) {
        throw gitHubError("GITHUB_ERROR", "comment requires a body");
      }
      break;
    }
    case "merge_pr": {
      if (typeof intent.fields.number !== "number") {
        throw gitHubError("GITHUB_ERROR", "merge_pr requires a PR number");
      }
      if (typeof intent.fields.head_sha !== "string") {
        throw gitHubError(
          "GITHUB_ERROR",
          "merge_pr requires the expected head SHA (material identity)",
        );
      }
      break;
    }
    case "update_issue":
    case "create_pr":
    case "add_labels":
      break;
    case "ci_control": {
      // CI control endpoints are whitelisted: run cancel/rerun-failed-jobs
      // and workflow dispatches only (pi-ci-next consumption, CONTRACTS §13).
      const ciPath = intent.fields.ciPath;
      const allowed =
        /^\/repos\/[^/]+\/[^/]+\/actions\/(runs\/\d+\/(cancel|rerun-failed-jobs)|workflows\/.+\/dispatches)$/;
      if (typeof ciPath !== "string" || !allowed.test(ciPath)) {
        throw gitHubError("GITHUB_ERROR", "ci_control requires a whitelisted Actions endpoint");
      }
      break;
    }
    default: {
      const exhaustive: never = intent.operation;
      throw gitHubError("GITHUB_ERROR", `unsupported mutation: ${String(exhaustive)}`);
    }
  }
}

/** The API path for a mutation. */
function mutationPath(intent: MutationIntent): string {
  const repo = intent.repository;
  switch (intent.operation) {
    case "create_issue":
      return `/repos/${repo}/issues`;
    case "comment": {
      const number = intent.fields.number as number;
      return `/repos/${repo}/issues/${number}/comments`;
    }
    case "update_issue": {
      const number = intent.fields.number as number;
      return `/repos/${repo}/issues/${number}`;
    }
    case "create_pr":
      return `/repos/${repo}/pulls`;
    case "merge_pr": {
      const number = intent.fields.number as number;
      return `/repos/${repo}/pulls/${number}/merge`;
    }
    case "add_labels": {
      const number = intent.fields.number as number;
      return `/repos/${repo}/issues/${number}/labels`;
    }
    case "ci_control":
      return intent.fields.ciPath as string;
    default: {
      const exhaustive: never = intent.operation;
      throw gitHubError("GITHUB_ERROR", `unsupported mutation: ${String(exhaustive)}`);
    }
  }
}

function mutationBody(intent: MutationIntent): Record<string, unknown> {
  const fields = intent.fields;
  switch (intent.operation) {
    case "create_issue":
      return {
        title: fields.title,
        body: `${fields.body ?? ""}\n\n<!-- ${reconciliationMarker(intent)} -->`.trim(),
        ...(Array.isArray(fields.labels) ? { labels: fields.labels } : {}),
      };
    case "comment":
      return { body: `${fields.body}\n\n<!-- ${reconciliationMarker(intent)} -->` };
    case "update_issue":
      return {
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.body !== undefined ? { body: fields.body } : {}),
        ...(fields.state !== undefined ? { state: fields.state } : {}),
      };
    case "create_pr":
      return {
        title: fields.title,
        head: fields.head,
        base: fields.base,
        ...(fields.body ? { body: fields.body } : {}),
      };
    case "merge_pr":
      return {
        sha: fields.head_sha,
        merge_method: fields.method ?? "merge",
      };
    case "add_labels":
      return { labels: fields.labels };
    case "ci_control": {
      // dispatch carries ref/inputs; cancel/rerun post empty bodies
      if (typeof fields.inputsJson === "string") {
        return { ref: fields.ref ?? "main", inputs: JSON.parse(fields.inputsJson) };
      }
      return fields.ref !== undefined ? { ref: fields.ref } : {};
    }
    default: {
      const exhaustive: never = intent.operation;
      throw gitHubError("GITHUB_ERROR", `unsupported mutation: ${String(exhaustive)}`);
    }
  }
}

export interface MutationOutcome {
  state: "completed" | "failed" | "cancelled" | "unknown";
  resultRef?: string;
  reason?: string;
  record: MutationRecord;
}

export class MutationEngine {
  private readonly transport: GitHubTransport;
  private readonly journal: MutationJournal;
  private readonly now: () => number;
  private readonly onMutationEvent?: (payload: Record<string, unknown>) => void;

  constructor(
    transport: GitHubTransport,
    journal: MutationJournal,
    now: () => number = Date.now,
    onMutationEvent?: (payload: Record<string, unknown>) => void,
  ) {
    this.transport = transport;
    this.journal = journal;
    this.now = now;
    this.onMutationEvent = onMutationEvent;
  }

  /**
   * Execute one mutation with full journal truth:
   *   begin (not-started, durable) → started → request → completed/failed
   *   → network-drop-after-send → unknown → reconcile → completed/failed
   *   / still-unknown (fail closed).
   */
  async execute(
    intent: MutationIntent,
    opts?: { signal?: AbortSignal; cancelled?: () => boolean },
  ): Promise<MutationOutcome> {
    validateIntent(intent);
    const digest = intentDigest(intent);
    const operationId = operationIdFor(intent);

    // G1: a known completed mutation with the SAME intent is never re-run.
    const prior = this.journal.findCompletedByIntent(digest);
    if (prior) {
      return {
        state: "completed",
        resultRef: prior.resultRef,
        record: prior,
        reason: "already completed (journal)",
      };
    }
    if (opts?.cancelled?.()) {
      const record = await this.journal.begin({
        ...baseBegin(intent, digest, operationId),
        now: this.now(),
      });
      const updated = await this.journal.update(operationId, "cancelled", { now: this.now() });
      return { state: "cancelled", reason: "cancelled before request", record: updated ?? record };
    }

    const begin = await this.journal.begin({
      ...baseBegin(intent, digest, operationId),
      now: this.now(),
    });
    if (begin.state === "unknown" || begin.state === "started") {
      // A prior attempt is still in flight or unproven: reconcile instead
      // of blindly re-executing (G2).
      return this.reconcile(intent, operationId);
    }
    await this.journal.update(operationId, "started", { now: this.now() });
    this.emit(begin, "started");

    let response;
    try {
      response = await this.transport.request({
        method: "POST",
        path: mutationPath(intent),
        body: mutationBody(intent),
        signal: opts?.signal,
        allowRetry: false, // mutations never auto-retry (G2)
      });
    } catch (error) {
      const err = error as GitHubError & { message?: string };
      if (err.status === undefined) {
        // No HTTP response: we cannot know whether the request committed.
        if (/abort/i.test(err.message ?? "")) {
          // User-initiated cancellation — recorded, not retried.
          const record = await this.journal.update(operationId, "cancelled", {
            reason: "aborted (outcome unverified)",
            now: this.now(),
          });
          this.emit(record ?? begin, "cancelled");
          return { state: "cancelled", reason: "aborted", record: record ?? begin };
        }
        // Request MAY have committed (network dropped after send) → unknown.
        const record = await this.journal.update(operationId, "unknown", {
          reason: "network failure after possible commit",
          now: this.now(),
        });
        this.emit(record ?? begin, "unknown");
        return this.reconcile(intent, operationId);
      }
      // Proven server response: a 4xx means nothing committed.
      const record = await this.journal.update(operationId, "failed", {
        reason: err.message,
        now: this.now(),
      });
      this.emit(record ?? begin, "failed");
      return { state: "failed", reason: err.message, record: record ?? begin };
    }

    const resultRef = resultRefFor(intent, response.data);
    const record = await this.journal.update(operationId, "completed", {
      resultRef,
      now: this.now(),
    });
    this.emit(record ?? begin, "completed");
    return { state: "completed", resultRef, record: record ?? begin };
  }

  /**
   * Reconciliation for unknown outcomes (§29): operation-specific, using the
   * embedded reconciliation marker. Proves committed → completed; proves
   * not-committed → safe single retry; still unknown → fail closed.
   */
  async reconcile(intent: MutationIntent, operationId: string): Promise<MutationOutcome> {
    const record = this.journal.get(operationId);
    if (!record) {
      throw gitHubError("GITHUB_ERROR", "reconcile: journal lost the operation");
    }
    const proven = await this.proveOutcome(intent);
    if (proven.committed) {
      const updated = await this.journal.update(operationId, "completed", {
        resultRef: proven.resultRef,
        reason: "reconciled: committed",
        now: this.now(),
      });
      this.emit(updated ?? record, "completed");
      return {
        state: "completed",
        resultRef: proven.resultRef,
        reason: "reconciled: committed",
        record: updated ?? record,
      };
    }
    if (proven.notCommitted) {
      // One safe retry (request proven not to have committed).
      try {
        const response = await this.transport.request({
          method: "POST",
          path: mutationPath(intent),
          body: mutationBody(intent),
          allowRetry: false,
        });
        const resultRef = resultRefFor(intent, response.data);
        const updated = await this.journal.update(operationId, "completed", {
          resultRef,
          reason: "reconciled: not committed, retried once",
          now: this.now(),
        });
        this.emit(updated ?? record, "completed");
        return {
          state: "completed",
          resultRef,
          reason: "reconciled: retried once",
          record: updated ?? record,
        };
      } catch (error) {
        const err = error as GitHubError;
        const updated = await this.journal.update(operationId, "failed", {
          reason: `reconciled: not committed, retry failed: ${err.message}`,
          now: this.now(),
        });
        return { state: "failed", reason: err.message, record: updated ?? record };
      }
    }
    // Still unknown → fail CLOSED with explicit unknown state (G2).
    const updated = await this.journal.update(operationId, "unknown", {
      reason: "reconciliation inconclusive",
      now: this.now(),
    });
    return {
      state: "unknown",
      reason: "reconciliation inconclusive — check GitHub manually before retrying",
      record: updated ?? record,
    };
  }

  /** Operation-specific proof: committed / notCommitted / inconclusive. */
  private async proveOutcome(
    intent: MutationIntent,
  ): Promise<{ committed: boolean; notCommitted: boolean; resultRef?: string }> {
    const marker = reconciliationMarker(intent);
    try {
      switch (intent.operation) {
        case "comment": {
          const number = intent.fields.number as number;
          const comments = (
            await this.transport.request({
              path: `/repos/${intent.repository}/issues/${number}/comments?per_page=20`,
            })
          ).data as Array<{ id: number; body?: string }>;
          const match = Array.isArray(comments)
            ? comments.find((c) => typeof c.body === "string" && c.body.includes(marker))
            : undefined;
          if (match)
            return {
              committed: true,
              notCommitted: false,
              resultRef: `gh:comment:${intent.repository}#${match.id}`,
            };
          return { committed: false, notCommitted: true };
        }
        case "create_issue": {
          const issues = (
            await this.transport.request({
              path: `/repos/${intent.repository}/issues?creator=me&per_page=20&sort=created&direction=desc`,
            })
          ).data as Array<{ id: number; number: number; body?: string; title?: string }>;
          const match = Array.isArray(issues)
            ? issues.find((i) => typeof i.body === "string" && i.body.includes(marker))
            : undefined;
          if (match)
            return {
              committed: true,
              notCommitted: false,
              resultRef: `gh:issue:${intent.repository}#${match.number}`,
            };
          return { committed: false, notCommitted: true };
        }
        case "merge_pr": {
          const number = intent.fields.number as number;
          const pr = (
            await this.transport.request({
              path: `/repos/${intent.repository}/pulls/${number}`,
            })
          ).data as { merged?: boolean; merge_commit_sha?: string; head?: { sha?: string } };
          if (pr.merged) {
            return {
              committed: true,
              notCommitted: false,
              resultRef: `gh:pr:${intent.repository}#${number}@merged`,
            };
          }
          // not merged, and head still matches what we expected → not committed
          if (pr.head?.sha === intent.fields.head_sha)
            return { committed: false, notCommitted: true };
          return { committed: false, notCommitted: false }; // head moved: inconclusive
        }
        default:
          return { committed: false, notCommitted: false }; // inconclusive by default
      }
    } catch {
      return { committed: false, notCommitted: false };
    }
  }

  private emit(record: MutationRecord | undefined, state: string): void {
    if (!record || !this.onMutationEvent) return;
    this.onMutationEvent({
      v: 1,
      operationId: record.operationId,
      operation: record.operation,
      repository: record.repository,
      resourceRef: record.resourceRef,
      state,
      resultRef: record.resultRef,
    });
  }
}

function baseBegin(intent: MutationIntent, digest: string, operationId: string) {
  return {
    operationId,
    intentDigest: digest,
    repository: intent.repository,
    resourceRef: mutationPath(intent),
    operation: intent.operation,
  };
}

function resultRefFor(intent: MutationIntent, data: unknown): string | undefined {
  const d = data as { number?: number; id?: number; sha?: string; merged?: boolean } | null;
  if (!d) return undefined;
  switch (intent.operation) {
    case "create_issue":
      return d.number !== undefined ? `gh:issue:${intent.repository}#${d.number}` : undefined;
    case "comment":
      return d.id !== undefined ? `gh:comment:${intent.repository}#${d.id}` : undefined;
    case "create_pr":
      return d.number !== undefined ? `gh:pr:${intent.repository}#${d.number}` : undefined;
    case "merge_pr":
      return d.merged ? `gh:pr:${intent.repository}#${intent.fields.number}@merged` : undefined;
    case "add_labels":
    case "update_issue":
      return `gh:${intent.fields.number !== undefined ? (intent.operation === "add_labels" || intent.operation === "update_issue" ? "issue" : "pr") : "issue"}:${intent.repository}#${intent.fields.number ?? ""}`;
    case "ci_control":
      return `gh:ci:${intent.repository}/${intent.fields.ciAction ?? "control"}`;
    default:
      return undefined;
  }
}
