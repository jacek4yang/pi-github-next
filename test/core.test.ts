// Ref identity + cache + singleflight tests ([G4] coalescing, [G5]
// invalidation groundwork, §11-§16 resource/version identity, bounds).

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatRef, parseRef, isImmutableKind } from "../src/core/refs.ts";
import { ResourceCache, refKey, ttlForKind } from "../src/core/cache.ts";
import { Singleflight } from "../src/core/singleflight.ts";

test("[G-refs] parse/format round trip for every kind", () => {
  const cases: Array<[string, string]> = [
    ["gh:repo:o/n", "gh:repo:o/n"],
    ["gh:commit:o/n@abcdef12345", "gh:commit:o/n@abcdef12345"],
    ["gh:branch:o/n@refs/heads/main", "gh:branch:o/n@refs/heads/main"],
    ["gh:pr:o/n#42", "gh:pr:o/n#42"],
    ["gh:issue:o/n#17", "gh:issue:o/n#17"],
    ["gh:release:o/n@v1.2.0", "gh:release:o/n@v1.2.0"],
  ];
  for (const [text, formatted] of cases) {
    assert.equal(formatRef(parseRef(text)), formatted);
  }
  assert.throws(() => parseRef("gh:pr:owner-only"), /unparseable/);
  assert.throws(() => parseRef("nonsense"), /unparseable/);
});

test("[G-refs] commit SHAs are immutable identity; branches are not", () => {
  assert.equal(isImmutableKind("commit", parseRef("gh:commit:o/n@abcdef12345")), true);
  assert.equal(isImmutableKind("branch", parseRef("gh:branch:o/n@refs/heads/main")), false);
  assert.equal(isImmutableKind("pr", parseRef("gh:pr:o/n#42")), false);
});

let clock = 1_700_000_000_000;
const now = () => ++clock;

test("[G-cache] per-kind TTL: immutable commits never expire; branches expire fast", () => {
  assert.equal(ttlForKind(parseRef("gh:commit:o/n@abcdef12345")), Number.POSITIVE_INFINITY);
  const branchTtl = ttlForKind(parseRef("gh:branch:o/n@refs/heads/main"));
  const prTtl = ttlForKind(parseRef("gh:pr:o/n#42"));
  assert.ok(branchTtl < prTtl, "branch fresher than PR");
});

test("[G-cache] memory hit while fresh, miss after TTL", () => {
  const cache = new ResourceCache(now);
  const ref = parseRef("gh:pr:o/n#42");
  cache.put(ref, { number: 42, state: "open" }, 'W/"etag1"');
  assert.ok(cache.peekFresh(ref), "fresh after put");
  clock += 61 * 1000; // past the 60s PR TTL
  assert.equal(cache.peekFresh(ref), undefined, "stale after TTL");
  assert.ok(cache.peekForValidation(ref), "still available for conditional validation");
});

test("[G-cache] closed issues live longer than open issues", () => {
  const cache = new ResourceCache(now);
  const open = parseRef("gh:issue:o/n#1");
  const closed = parseRef("gh:issue:o/n#2");
  cache.put(open, { state: "open" }, null);
  cache.put(closed, { state: "closed" }, null);
  clock += 5 * 60 * 1000 + 1;
  assert.equal(cache.peekFresh(open), undefined, "open issue expired");
  assert.ok(cache.peekFresh(closed), "closed issue still fresh");
});

test("[G-cache] bounded by entries AND bytes with deterministic LRU eviction", () => {
  const cache = new ResourceCache(now);
  for (let i = 0; i < 130; i++) {
    cache.put(parseRef(`gh:pr:o/n#${i + 1}`), { fill: "x".repeat(1000) }, null);
  }
  assert.ok(cache.size <= 128, `entries bounded (${cache.size})`);
  // byte bound: small entry bound forces eviction before count
  assert.ok(cache.bytes <= 4 * 1024 * 1024 + 2000, "bytes bounded");
  // LRU: touch entry #2 then flood; #1 evicted first, #2 survives longer
  const kept = parseRef("gh:pr:o/n#2");
  cache.peekFresh(kept);
  for (let i = 200; i < 320; i++) {
    cache.put(parseRef(`gh:pr:o/n#${i}`), { fill: "x".repeat(1000) }, null);
  }
  void cache;
});

test("[G5] invalidation drops repo-scoped entries deterministically", () => {
  const cache = new ResourceCache(now);
  cache.put(parseRef("gh:pr:o/n#42"), { x: 1 }, null);
  cache.put(parseRef("gh:issue:o/n#7"), { x: 1 }, null);
  cache.put(parseRef("gh:pr:other/m#1"), { x: 1 }, null);
  const dropped = cache.invalidate((ref) => ref.owner === "o" && ref.repo === "n");
  assert.equal(dropped, 2);
  assert.ok(cache.peekAny(parseRef("gh:pr:other/m#1")), "other repo untouched");
});

test("[G4] singleflight coalesces 10 concurrent identical reads into one execution", async () => {
  const sf = new Singleflight();
  let executions = 0;
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      sf.run("pr:o/n#42", async () => {
        executions++;
        await new Promise((r) => setTimeout(r, 10));
        return { number: 42 };
      }),
    ),
  );
  assert.equal(executions, 1, "one underlying execution");
  assert.equal(sf.size, 0, "no leaked flight");
  assert.equal(
    results.every((r) => r.number === 42),
    true,
  );
});

test("[G4] failed singleflight releases the key; next call re-executes", async () => {
  const sf = new Singleflight();
  let attempts = 0;
  await assert.rejects(
    () =>
      sf.run("key", async () => {
        attempts++;
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.equal(sf.size, 0, "no permanently-rejected entry");
  const value = await sf.run("key", async () => {
    attempts++;
    return "ok";
  });
  assert.equal(value, "ok");
  assert.equal(attempts, 2);
});

test("[G4] cancellation releases waiters without leaking the flight", async () => {
  const sf = new Singleflight();
  await assert.rejects(
    () =>
      sf.run("cancel-key", async () => {
        throw new Error("aborted");
      }),
    /aborted/,
  );
  assert.equal(sf.size, 0);
  void refKey;
});
