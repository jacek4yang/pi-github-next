// Durable mutation journal (§27/§31-33): append-only JSONL under the agent
// dir. Proof of external side-effect truth — "the assistant said so" is
// never proof (§30). Design ideas shared with the recovery journal (hash
// chain, tail-truncation tolerance, bounded GC), implemented independently
// (no private imports).
//
// Corruption semantics (§32): tail truncation auto-recovers (the classic
// crash window); malformed middle records / unknown versions / tampered
// digests mark the journal DEGRADED and reads fail closed to the verified
// prefix — records before corruption stay trustworthy, nothing after is
// accepted until reconciliation resolves it.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, appendFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { STACK_INFO } from "../info.ts";
import type { MutationRecord, MutationState } from "./types.ts";

const Q = STACK_INFO.quotas;

/** States that must never be GC'd (needed for reconciliation). */
const PINNED_STATES: ReadonlySet<MutationState> = new Set(["not-started", "started", "unknown"]);

function recordDigest(record: MutationRecord): string {
  const canonical = JSON.stringify({
    operationId: record.operationId,
    intentDigest: record.intentDigest,
    repository: record.repository,
    resourceRef: record.resourceRef,
    operation: record.operation,
    state: record.state,
    resultRef: record.resultRef,
    reason: record.reason,
    updatedAt: record.updatedAt,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

interface JournalledLine {
  digest: string;
  record: MutationRecord;
}

export class MutationJournal {
  private records = new Map<string, MutationRecord>(); // by operationId
  private degraded: string | undefined;
  private readonly path: string;
  private loaded = false;

  constructor(path: string) {
    this.path = path;
  }

  get degradedReason(): string | undefined {
    return this.degraded;
  }

  get journalState(): "healthy" | "degraded" {
    return this.degraded ? "degraded" : "healthy";
  }

  /** Load + validate. Tail truncation tolerated; middle corruption degrades. */
  async load(): Promise<void> {
    this.loaded = true;
    this.records.clear();
    this.degraded = undefined;
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return; // first use
    }
    const lines = raw.split("\n");
    // Drop a trailing partial line (crash during append) — the classic
    // tail-truncation window is auto-repaired.
    if (lines.at(-1) === "") lines.pop();
    if (lines.length > 0 && !raw.endsWith("\n")) {
      const partial = lines.pop();
      if (partial && partial.trim().length > 0) {
        // the partial line is discarded; appends will rewrite a valid chain
        await this.rewrite([...this.records.values()]);
      }
    }
    for (const line of lines) {
      if (line.trim() === "") continue;
      let parsed: JournalledLine;
      try {
        parsed = JSON.parse(line) as JournalledLine;
      } catch {
        this.degraded = "malformed journal record";
        break; // fail closed to the verified prefix
      }
      const expected = recordDigest(parsed.record);
      if (parsed.digest !== expected) {
        this.degraded = "tampered journal record";
        break;
      }
      if (parsed.record.v !== 1) {
        this.degraded = "unknown journal record version";
        break;
      }
      const existing = this.records.get(parsed.record.operationId);
      if (existing && existing.updatedAt > parsed.record.updatedAt) continue; // older line, ignore
      this.records.set(parsed.record.operationId, parsed.record);
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async appendRecord(record: MutationRecord): Promise<void> {
    const line = JSON.stringify({ digest: recordDigest(record), record });
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await appendFile(this.path, line + "\n", { encoding: "utf8", mode: 0o600 });
  }

  /** Rewrite the file from in-memory state (after tail repair or GC). */
  private async rewrite(records: Iterable<MutationRecord>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    const body = [...records]
      .map((r) => JSON.stringify({ digest: recordDigest(r), record: r }))
      .join("\n");
    await writeFile(tmp, body.length > 0 ? body + "\n" : "", { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.path);
  }

  /** Create a not-started record and persist it BEFORE any request runs. */
  async begin(input: {
    operationId: string;
    intentDigest: string;
    repository: string;
    resourceRef: string;
    operation: string;
    requestMarker?: string;
    now: number;
  }): Promise<MutationRecord> {
    await this.ensureLoaded();
    const existing = this.records.get(input.operationId);
    if (existing) return existing;
    const record: MutationRecord = {
      v: 1,
      operationId: input.operationId,
      intentDigest: input.intentDigest,
      repository: input.repository,
      resourceRef: input.resourceRef,
      operation: input.operation,
      requestMarker: input.requestMarker,
      state: "not-started",
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.records.set(record.operationId, record);
    await this.appendRecord(record);
    return record;
  }

  /** Transition a record's state (started/completed/failed/cancelled/unknown). */
  async update(
    operationId: string,
    state: MutationState,
    opts?: { resultRef?: string; reason?: string; now: number },
  ): Promise<MutationRecord | undefined> {
    await this.ensureLoaded();
    const record = this.records.get(operationId);
    if (!record) return undefined;
    if (!validTransition(record.state, state)) {
      this.degraded = `invalid journal transition ${record.state} -> ${state}`;
      return undefined;
    }
    record.state = state;
    if (opts?.resultRef) record.resultRef = opts.resultRef;
    if (opts?.reason) record.reason = opts.reason;
    record.updatedAt = opts?.now ?? Date.now();
    await this.appendRecord(record);
    await this.gc();
    return record;
  }

  get(operationId: string): MutationRecord | undefined {
    return this.records.get(operationId);
  }

  /** Find a completed record with the same intent digest (G1 reuse). */
  findCompletedByIntent(intentDigest: string): MutationRecord | undefined {
    for (const record of this.records.values()) {
      if (record.intentDigest === intentDigest && record.state === "completed") return record;
    }
    return undefined;
  }

  /** In-flight (uncertain) records needing reconciliation. */
  pendingUnknown(): MutationRecord[] {
    return [...this.records.values()].filter((r) => PINNED_STATES.has(r.state));
  }

  async markDegraded(reason: string): Promise<void> {
    this.degraded = reason;
  }

  /**
   * Deterministic GC (§33): oldest terminal records beyond the bound;
   * pinned (not-started/started/unknown) records are NEVER removed.
   */
  private async gc(): Promise<void> {
    const terminal = [...this.records.values()].filter((r) => !PINNED_STATES.has(r.state));
    const excess = terminal.length - Q.journalMaxTerminal;
    if (excess <= 0) return;
    const droppable = terminal
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, excess)
      .map((r) => r.operationId);
    for (const id of droppable) this.records.delete(id);
    await this.rewrite([...this.records.values()]);
  }

  /** Health counts (§50). */
  counts(): { pending: number; unknown: number; total: number } {
    let pending = 0;
    let unknown = 0;
    for (const r of this.records.values()) {
      if (r.state === "unknown") unknown++;
      else if (PINNED_STATES.has(r.state)) pending++;
    }
    return { pending, unknown, total: this.records.size };
  }

  journalPath(): string {
    return join(this.path);
  }
}

const ALLOWED: Record<MutationState, MutationState[]> = {
  "not-started": ["started", "cancelled", "unknown", "failed"],
  started: ["completed", "failed", "cancelled", "unknown"],
  unknown: ["completed", "failed", "unknown"],
  completed: [],
  failed: ["started"], // explicit retry after a PROVEN failed request
  cancelled: [],
};

function validTransition(from: MutationState, to: MutationState): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}
