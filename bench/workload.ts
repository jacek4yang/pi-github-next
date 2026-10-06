// Deterministic GitHub workload benchmark (§51, §53-54): measured API call
// counts, cache behavior, singleflight savings, and model-visible bytes
// against a counting stub transport. No live GitHub, no LLM.
//
// Run: npx tsx bench/workload.ts → JSON on stdout

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitHubResources } from "../src/core/resources.ts";
import { MutationEngine, intentDigest } from "../src/core/mutations.ts";
import { MutationJournal } from "../src/core/journal.ts";
import type { MutationIntent } from "../src/core/types.ts";

let clock = 1_700_000_000_000;
const now = () => ++clock;

function makeWorld() {
  const calls: Array<{ path: string; method: string }> = [];
  let prVersion = 0;
  const prData = () => ({
    number: 42,
    state: "open",
    title: "Feature work",
    head: { ref: "feat", sha: `head${prVersion}` },
    base: { ref: "main" },
    mergeable: true,
    changed_files: 3,
    additions: 120,
    deletions: 4,
    labels: [{ name: "review" }],
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-05T00:00:00Z",
  });
  const transport = {
    request: async (opts: { path: string; method?: string; etag?: string }) => {
      calls.push({ path: opts.path, method: opts.method ?? "GET" });
      if (opts.path.endsWith("/pulls/42")) {
        const currentEtag = `W/"pr-v${prVersion}"`;
        if (opts.etag === currentEtag)
          return { status: 304, data: undefined, etag: currentEtag, headers: {} };
        return { status: 200, data: prData(), etag: currentEtag, headers: {} };
      }
      if (opts.path.includes("/reviews")) {
        return {
          status: 200,
          data: [{ user: { login: "rev" }, state: "APPROVED" }],
          etag: null,
          headers: {},
        };
      }
      if (opts.method === "POST" && opts.path.includes("/comments")) {
        prVersion++; // a comment changes the PR world
        return { status: 200, data: { id: 9000 + prVersion }, etag: null, headers: {} };
      }
      if (opts.method === "POST" && opts.path.endsWith("/issues")) {
        return { status: 200, data: { number: 73 }, etag: null, headers: {} };
      }
      return { status: 200, data: [], etag: null, headers: {} };
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "pinx-gh-bench-"));
  const journal = new MutationJournal(join(dir, "j.jsonl"));
  const engine = new MutationEngine(transport as never, journal, now);
  const resources = new GitHubResources(transport as never, engine, now);
  return {
    calls,
    resources,
    engine,
    journal,
    bumpPr: () => prVersion++,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const prRef = { kind: "pr" as const, owner: "o", repo: "n", number: 42 };
const results: Record<string, unknown> = {};

// ---- Scenario A: 10 identical logical PR reads, resource unchanged ----
{
  const w = makeWorld();
  const reads: Array<{ snapshotId: string; projection: string; outcome: string }> = [];
  for (let i = 0; i < 10; i++) {
    reads.push(await w.resources.read(prRef, { knownSnapshot: reads.at(-1)?.snapshotId }));
  }
  results.A_repeated_unchanged = {
    logicalReads: 10,
    underlyingApiCalls: w.calls.length,
    memoryHits: reads.filter((r) => r.outcome === "memory-hit").length,
    networkFetches: reads.filter((r) => r.outcome === "network-fetch").length,
    unchangedCompactions: reads.filter((r) => r.projection.startsWith("unchanged")).length,
    modelVisibleBytesFirstRead: Buffer.byteLength(reads[0]!.projection, "utf8"),
    modelVisibleBytesUnchangedResult: Buffer.byteLength(reads.at(-1)!.projection, "utf8"),
    fullTransfersAvoided: 10 - w.calls.length,
  };
  w.cleanup();
}

// ---- Scenario B: 3 concurrent consumers request the same PR ----
{
  const w = makeWorld();
  const concurrent = await Promise.all([
    w.resources.read(prRef),
    w.resources.read(prRef),
    w.resources.read(prRef),
  ]);
  results.B_concurrent_singleflight = {
    concurrentConsumers: 3,
    underlyingApiCalls: w.calls.length,
    requestsSaved: Math.max(0, 3 * 2 - w.calls.length), // naive: 2 calls per read
    singleAgreement: concurrent.every((r) => r.snapshotId === concurrent[0]!.snapshotId),
  };
  w.cleanup();
}

// ---- Scenario C: the resource changes once during repeated reads ----
{
  const w = makeWorld();
  const before = await w.resources.read(prRef);
  const beforeHead = before.snapshotId;
  w.bumpPr(); // PR head moves on GitHub
  clock += 2 * 60 * 1000; // TTL expires: revalidation required (ETag check)
  const after = await w.resources.read(prRef);
  results.C_resource_changed = {
    mechanism: "TTL expiry -> If-None-Match revalidation (memory hit serves within TTL by design)",
    snapshotChanged: after.snapshotId !== beforeHead,
    freshDataServed: after.projection.includes("head1"),
    outcomeAfterChange: after.outcome,
    totalApiCalls: w.calls.length,
  };
  w.cleanup();
}

// ---- Scenario D: mutation followed by immediate read ----
{
  const w = makeWorld();
  await w.resources.read(prRef);
  const intent: MutationIntent = {
    operation: "comment",
    repository: "o/n",
    fields: { number: 42, body: "note" },
  };
  const mutation = await w.engine.execute(intent);
  const invalidated = w.resources.invalidateFor(intent);
  const post = await w.resources.read(prRef);
  results.D_mutation_then_read = {
    mutationState: mutation.state,
    invalidatedEntries: invalidated,
    postMutationOutcome: post.outcome,
    staleSnapshotServed: invalidated === 0 && post.outcome === "memory-hit",
    freshSnapshotServed: post.outcome === "network-fetch",
  };
  w.cleanup();
}

// ---- Scenario E: issue-candidate promotion mock (one mutation, durable result) ----
{
  const w = makeWorld();
  const intent: MutationIntent = {
    operation: "create_issue",
    repository: "o/n",
    fields: { title: "Promoted candidate", body: "from task layer", issueCandidateId: "issue_x1" },
  };
  const outcome = await w.engine.execute(intent);
  const completedBefore = w.journal.findCompletedByIntent(intentDigest(intent));
  results.E_promotion = {
    state: outcome.state,
    resultRef: outcome.resultRef,
    durableRecord: completedBefore !== undefined,
    taskReceivesOnlyRef:
      typeof outcome.resultRef === "string" && outcome.resultRef.startsWith("gh:issue:"),
  };
  w.cleanup();
}

// ---- Scenario F: uncertain outcome + reconciliation (zero duplicates) ----
{
  const calls: Array<{ path: string; method: string }> = [];
  let posts = 0;
  const marker = "pinx-github-next op:";
  const transport = {
    request: async (opts: { path: string; method?: string }) => {
      calls.push({ path: opts.path, method: opts.method ?? "GET" });
      if (opts.method === "POST" && opts.path.includes("/comments")) {
        posts++;
        if (posts === 1) throw new Error("network dropped after send");
        return { status: 200, data: { id: 4242 }, etag: null, headers: {} };
      }
      if (opts.path.includes("/comments")) {
        // reconciliation search: after the retry the marker is visible
        return posts >= 2
          ? {
              status: 200,
              data: [{ id: 4242, body: `x<!-- ${marker}ret -->` }],
              etag: null,
              headers: {},
            }
          : { status: 200, data: [], etag: null, headers: {} };
      }
      return { status: 200, data: [], etag: null, headers: {} };
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "pinx-gh-f-"));
  const journal = new MutationJournal(join(dir, "j.jsonl"));
  const engine = new MutationEngine(transport as never, journal, now);
  const intent: MutationIntent = {
    operation: "comment",
    repository: "o/n",
    fields: { number: 42, body: "f" },
  };
  const outcome = await engine.execute(intent);
  const reopened = new MutationJournal(join(dir, "j.jsonl"));
  await reopened.load();
  results.F_uncertain_reconciled = {
    finalState: outcome.state,
    postAttempts: posts,
    duplicateMutations: Math.max(0, posts - 2), // 1 dropped send + 1 proven retry = 2 max
    journalSurvivedReopen: reopened.get(outcome.record.operationId) !== undefined,
  };
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(JSON.stringify({ bench: "pi-github-next workload", results }, null, 2) + "\n");
