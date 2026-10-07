// Journal truth + mutation reconciliation tests ([G1] no duplicate known
// mutation, [G2] unknown reconciled or fail-closed, [G3] material identity,
// corruption fail-closed, journal bounds + reopen).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MutationJournal } from "../src/core/journal.ts";
import {
  MutationEngine,
  intentDigest,
  operationIdFor,
  reconciliationMarker,
} from "../src/core/mutations.ts";
import type { MutationIntent } from "../src/core/types.ts";
import type { GitHubTransport } from "../src/core/transport.ts";

let clock = 1_700_000_000_000;
const now = () => ++clock;

function commentIntent(body: string): MutationIntent {
  return { operation: "comment", repository: "o/r", fields: { number: 42, body } };
}

function mergeIntent(head: string, method = "squash"): MutationIntent {
  return {
    operation: "merge_pr",
    repository: "o/r",
    fields: { number: 42, head_sha: head, method },
  };
}

function stubTransport(handler: (path: string, method: string) => unknown): GitHubTransport {
  return {
    request: async (opts: { path: string; method?: string }) => {
      const result = handler(opts.path, opts.method ?? "GET");
      if (result instanceof Error) throw result;
      return { status: 200, data: result, etag: null, headers: {} };
    },
  } as unknown as GitHubTransport;
}

function tempJournal(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pinx-gh-journal-"));
  return {
    path: join(dir, "mutations.jsonl"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("[G3] intent digest: material fields change it; volatile fields don't exist in it", () => {
  const a = intentDigest(commentIntent("hello"));
  const b = intentDigest(commentIntent("hello"));
  assert.equal(a, b, "same material intent = same digest");
  assert.notEqual(intentDigest(commentIntent("different")), a);
  assert.notEqual(
    intentDigest(mergeIntent("aaaa")),
    intentDigest(mergeIntent("bbbb")),
    "head SHA is material",
  );
  assert.notEqual(
    intentDigest(mergeIntent("aaaa", "merge")),
    intentDigest(mergeIntent("aaaa", "squash")),
    "method is material",
  );
  assert.equal(operationIdFor(commentIntent("hello")), operationIdFor(commentIntent("hello")));
  assert.ok(reconciliationMarker(commentIntent("hello")).startsWith("pinx-github-next op:"));
});

test("[G1] a known completed mutation is never re-executed", async () => {
  const { path, cleanup } = tempJournal();
  try {
    const journal = new MutationJournal(path);
    let posts = 0;
    const transport = stubTransport(() => {
      posts++;
      return { id: 999 };
    });
    const engine = new MutationEngine(transport, journal, now);
    const first = await engine.execute(commentIntent("hello"));
    assert.equal(first.state, "completed");
    assert.equal(posts, 1);
    const second = await engine.execute(commentIntent("hello"));
    assert.equal(second.state, "completed", "reused");
    assert.match(second.reason ?? "", /already completed/);
    assert.equal(posts, 1, "NO duplicate external side effect");
  } finally {
    cleanup();
  }
});

test("[G2] unknown outcome reconciled as committed — no duplicate", async () => {
  const { path, cleanup } = tempJournal();
  try {
    const journal = new MutationJournal(path);
    let posts = 0;
    let searches = 0;
    const marker = reconciliationMarker(commentIntent("hello"));
    const transport = stubTransport((p, method) => {
      if (method === "POST" && p.includes("/comments")) {
        posts++;
        throw new Error("network dropped"); // simulate drop AFTER send
      }
      if (p.includes("/comments") && searches === 0) {
        searches++;
        return [{ id: 555, body: `text\n<!-- ${marker} -->` }]; // reconciliation finds it
      }
      return [];
    });
    const engine = new MutationEngine(transport, journal, now);
    const outcome = await engine.execute(commentIntent("hello"));
    assert.equal(outcome.state, "completed");
    assert.match(outcome.reason ?? "", /reconciled: committed/);
    assert.equal(posts, 1, "one POST; the committed result was found, not repeated");
    assert.equal(outcome.resultRef, "gh:comment:o/r#555");
  } finally {
    cleanup();
  }
});

test("[G2] unknown reconciled as NOT committed → exactly one safe retry", async () => {
  const { path, cleanup } = tempJournal();
  try {
    const journal = new MutationJournal(path);
    let posts = 0;
    const marker = reconciliationMarker(commentIntent("again"));
    const transport = stubTransport((p, method) => {
      if (method === "POST" && p.includes("/comments")) {
        posts++;
        if (posts === 1) throw new Error("network dropped");
        return { id: 777 };
      }
      if (p.includes("/comments")) {
        return posts >= 2 ? [{ id: 777, body: `x<!-- ${marker} -->` }] : []; // second search sees the retry
      }
      return [];
    });
    const engine = new MutationEngine(transport, journal, now);
    const outcome = await engine.execute(commentIntent("again"));
    assert.equal(outcome.state, "completed");
    assert.match(outcome.reason ?? "", /retried once/);
    assert.equal(posts, 2, "one failed send + one proven-safe retry — never more");
  } finally {
    cleanup();
  }
});

test("[G2] inconclusive reconciliation fails CLOSED as unknown — never blindly retried", async () => {
  const { path, cleanup } = tempJournal();
  try {
    const journal = new MutationJournal(path);
    let posts = 0;
    const transport = stubTransport((p, method) => {
      if (method === "POST" && p.includes("/comments")) {
        posts++;
        throw new Error("network dropped");
      }
      throw new Error("search also failing"); // reconciliation inconclusive
    });
    const engine = new MutationEngine(transport, journal, now);
    const outcome = await engine.execute(commentIntent("mystery"));
    assert.equal(outcome.state, "unknown");
    assert.match(outcome.reason ?? "", /inconclusive|manually/);
    assert.equal(posts, 1, "no retry storm");
    // retrying the same intent does NOT re-post while journal says unknown:
    const again = await engine.execute(commentIntent("mystery"));
    assert.equal(again.state, "unknown");
    assert.equal(posts, 1, "unknown state blocks silent re-execution");
  } finally {
    cleanup();
  }
});

test("[G2] merge_pr reconciliation: proves merged / head-moved inconclusive", async () => {
  const { path, cleanup } = tempJournal();
  try {
    const journal = new MutationJournal(path);
    // proven merged
    let mergedProbe = 0;
    let mergePosts = 0;
    const transportMerged = stubTransport((p, method) => {
      if (method === "POST") {
        mergePosts++;
        if (mergePosts === 1) throw new Error("network dropped");
        return { merged: true, merge_commit_sha: "ffff" };
      }
      if (p.endsWith("/pulls/42")) {
        mergedProbe++;
        return mergedProbe === 1
          ? { merged: false, head: { sha: "aaaa" } }
          : { merged: true, merge_commit_sha: "ffff" };
      }
      return {};
    });
    const engineA = new MutationEngine(transportMerged, journal, now);
    const outcomeA = await engineA.execute(mergeIntent("aaaa"));
    assert.equal(outcomeA.state, "completed");
    assert.match(outcomeA.resultRef ?? "", /merged/);

    // head moved → inconclusive → unknown (fail closed)
    const journal2 = new MutationJournal(join(tmpdir(), `pinx-gh-${Math.random()}.jsonl`));
    const transportMoved = stubTransport((p, method) => {
      if (method === "POST") throw new Error("network dropped");
      if (p.endsWith("/pulls/42")) return { merged: false, head: { sha: "zzzz" } };
      return {};
    });
    const engineB = new MutationEngine(transportMoved, journal2, now);
    const outcomeB = await engineB.execute(mergeIntent("aaaa"));
    assert.equal(outcomeB.state, "unknown", "inconclusive merge outcome fails closed");
  } finally {
    cleanup();
  }
});

test("[G-journal] durable truth survives reopen; completed result reused", async () => {
  const { path, cleanup } = tempJournal();
  try {
    const journalA = new MutationJournal(path);
    const transport = stubTransport(() => ({ id: 31337 }));
    const engineA = new MutationEngine(transport, journalA, now);
    const first = await engineA.execute(commentIntent("durable"));
    assert.equal(first.state, "completed");

    const journalB = new MutationJournal(path); // reopen
    await journalB.load();
    let posts = 0;
    const transportB = stubTransport(() => {
      posts++;
      return { id: 1 };
    });
    const engineB = new MutationEngine(transportB, journalB, now);
    const reused = await engineB.execute(commentIntent("durable"));
    assert.equal(reused.state, "completed");
    assert.equal(reused.resultRef, first.resultRef);
    assert.equal(posts, 0, "no duplicate mutation after reopen (G1)");
  } finally {
    cleanup();
  }
});

test("[G-journal] corruption: tampered record degrades fail-closed; verified prefix stands", async () => {
  const { path, cleanup } = tempJournal();
  try {
    const journalA = new MutationJournal(path);
    const transport = stubTransport(() => ({ id: 5 }));
    await new MutationEngine(transport, journalA, now).execute(commentIntent("one"));
    const raw = readFileSync(path, "utf8");
    const tampered = raw.replace('"state":"completed"', '"state":"failed"');
    appendFileSync(path, tampered.split("\n").at(-2)!.replace(/^\{/, "{")); // duplicate tampered line
    writeFileSync(path, raw + tampered.split("\n").filter(Boolean).at(-1) + "\n");

    const journalB = new MutationJournal(path);
    await journalB.load();
    assert.match(journalB.degradedReason ?? "", /tampered|malformed/, "tampered digest detected");
    assert.equal(journalB.journalState, "degraded");
  } finally {
    cleanup();
  }
});

test("[G-journal] tail truncation auto-recovers (crash window)", async () => {
  const { path, cleanup } = tempJournal();
  try {
    const journalA = new MutationJournal(path);
    const engineA = new MutationEngine(
      stubTransport(() => ({ id: 9 })),
      journalA,
      now,
    );
    await engineA.execute(commentIntent("tail"));
    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n");
    // simulate a crash mid-append: keep only half of the last line
    const half = lines.slice(0, -1).join("\n") + "\n" + lines.filter(Boolean).at(-1)!.slice(0, 40);
    writeFileSync(path, half);

    const journalB = new MutationJournal(path);
    await journalB.load();
    assert.equal(journalB.journalState, "healthy", "partial tail tolerated");
  } finally {
    cleanup();
  }
});

test("[G-journal] GC never drops pinned (unknown/started) records; terminal bounded", async () => {
  const { path, cleanup } = tempJournal();
  try {
    const journal = new MutationJournal(path);
    // 120 completed + 1 unknown
    for (let i = 0; i < 120; i++) {
      await journal.begin({
        operationId: `op_done_${i}`,
        intentDigest: `d${i}`,
        repository: "o/r",
        resourceRef: "x",
        operation: "comment",
        now: now(),
      });
      await journal.update(`op_done_${i}`, "started", { now: now() });
      await journal.update(`op_done_${i}`, "completed", {
        resultRef: `gh:comment:o/r#${i}`,
        now: now(),
      });
    }
    await journal.begin({
      operationId: "op_unknown",
      intentDigest: "du",
      repository: "o/r",
      resourceRef: "x",
      operation: "comment",
      now: now(),
    });
    await journal.update("op_unknown", "unknown", { now: now() });

    const reopened = new MutationJournal(path);
    await reopened.load();
    const unknownRecord = reopened.get("op_unknown");
    assert.ok(unknownRecord, "pinned unknown survives GC");
    assert.ok(reopened.counts().total <= 101, `journal bounded (got ${reopened.counts().total})`);
  } finally {
    cleanup();
  }
});

test("[G-journal] invalid transitions degrade instead of corrupting", async () => {
  const { path, cleanup } = tempJournal();
  try {
    const journal = new MutationJournal(path);
    await journal.begin({
      operationId: "op1",
      intentDigest: "d",
      repository: "o/r",
      resourceRef: "x",
      operation: "comment",
      now: now(),
    });
    await journal.update("op1", "started", { now: now() });
    await journal.update("op1", "completed", { now: now() });
    const bad = await journal.update("op1", "started", { now: now() });
    assert.equal(bad, undefined, "completed is terminal");
    assert.match(journal.degradedReason ?? "", /invalid journal transition/);
  } finally {
    cleanup();
  }
});

test("[G-journal][ci] ci_control mutations are journaled with whitelist enforcement", async () => {
  const { path, cleanup } = tempJournal();
  try {
    const journal = new MutationJournal(path);
    let posts = 0;
    const transport = stubTransport((_p, method) => {
      if (method === "POST") {
        posts++;
        return { status: 200, data: {} };
      }
      return {};
    });
    const engine = new MutationEngine(transport, journal, now);
    const good: MutationIntent = {
      operation: "ci_control",
      repository: "o/r",
      fields: { ciPath: "/repos/o/r/actions/runs/9001/cancel", ciAction: "cancel" },
    };
    const outcome = await engine.execute(good);
    assert.equal(outcome.state, "completed");
    assert.equal(posts, 1);
    assert.match(outcome.resultRef ?? "", /gh:ci:o\/r\/cancel/);

    // non-whitelisted endpoint is rejected before any request
    const evil: MutationIntent = {
      operation: "ci_control",
      repository: "o/r",
      fields: { ciPath: "/repos/o/r/hooks" },
    };
    await assert.rejects(() => engine.execute(evil), /whitelisted/);
    assert.equal(posts, 1, "no request for rejected intent");
  } finally {
    cleanup();
  }
});
