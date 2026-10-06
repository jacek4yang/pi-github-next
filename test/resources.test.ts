// Resource layer tests ([G5] mutation invalidation, [G6] bounds, §14
// conditional 304, §18 unchanged snapshots, §8 call counting).

import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubResources } from "../src/core/resources.ts";
import type { MutationIntent } from "../src/core/types.ts";

let clock = 1_700_000_000_000;
const now = () => ++clock;

interface Call {
  path: string;
  method: string;
  etag?: string;
}

function stubTransport(
  handler: (call: Call) => { status?: number; data?: unknown; etag?: string },
) {
  const calls: Call[] = [];
  const transport = {
    request: async (opts: { path: string; method?: string; etag?: string }) => {
      calls.push({ path: opts.path, method: opts.method ?? "GET", etag: opts.etag });
      const result = handler({ path: opts.path, method: opts.method ?? "GET", etag: opts.etag });
      return {
        status: result.status ?? 200,
        data: result.data,
        etag: result.etag ?? null,
        headers: {},
      };
    },
  };
  return {
    calls,
    transport: transport as unknown as ConstructorParameters<typeof GitHubResources>[0],
  };
}

function prRef(): { owner: string; repo: string; kind: "pr"; number: 42 } {
  return { kind: "pr", owner: "o", repo: "n", number: 42 };
}

test("[G4/§8] PR summary: one reasoning result from several cached, counted API calls", async () => {
  const { calls, transport } = stubTransport((c) => {
    if (c.path.endsWith("/pulls/42")) {
      return {
        data: {
          number: 42,
          state: "open",
          title: "Feature",
          head: { sha: "aaaa", ref: "feat" },
          base: { ref: "main" },
        },
        etag: 'W/"pr1"',
      };
    }
    if (c.path.includes("/reviews"))
      return { data: [{ user: { login: "rev" }, state: "APPROVED" }] };
    return { data: [] };
  });
  const resources = new GitHubResources(transport, {} as never, now);
  const result = await resources.read(prRef());
  assert.match(result.projection, /PR #42/);
  assert.match(result.projection, /1 approved/);
  assert.equal(result.outcome, "network-fetch");
  const callsFirst = calls.length;
  assert.ok(callsFirst >= 2, "internally multiple calls (PR + reviews), one result");

  // Second read: memory hit — ZERO additional API calls.
  const second = await resources.read(prRef());
  assert.equal(second.outcome, "memory-hit");
  assert.equal(calls.length, callsFirst, "no new API calls on memory hit");
});

test("[§14] conditional validation: ETag refresh via 304 without retransfer", async () => {
  const { calls, transport } = stubTransport((c) => {
    if (c.etag) return { status: 304, data: undefined, etag: c.etag };
    return {
      data: { number: 7, state: "open", title: "Issue", head: { sha: "abc" } },
      etag: 'W/"iss1"',
    };
  });
  const resources = new GitHubResources(transport, {} as never, now);
  const ref = { kind: "issue" as const, owner: "o", repo: "n", number: 7 };
  const first = await resources.read(ref);
  assert.equal(first.outcome, "network-fetch");
  // expire TTL by advancing the clock
  clock += 10 * 60 * 1000;
  const second = await resources.read(ref);
  assert.equal(second.outcome, "conditional-hit", "304 refresh");
  assert.ok(calls.at(-1)!.etag, "If-None-Match sent");
  assert.match(second.projection, /Issue #7/, "cached value served after 304");
});

test("[G5] mutation invalidation: post-mutation read cannot return stale cache", async () => {
  const world: { issueData: unknown } = {
    issueData: { number: 17, state: "open", title: "Original title" },
  };
  const { calls, transport } = stubTransport((c) => {
    if (c.path.endsWith("/issues/17")) {
      return { data: world.issueData, etag: `W/"v${calls.length}"` };
    }
    return { data: [] };
  });
  const resources = new GitHubResources(transport, {} as never, now);
  const ref = { kind: "issue" as const, owner: "o", repo: "n", number: 17 };
  const first = await resources.read(ref);
  assert.match(first.projection, /Original title/);

  // update_issue mutation invalidates the issue entry
  const intent: MutationIntent = {
    operation: "update_issue",
    repository: "o/n",
    fields: { number: 17, title: "Renamed" },
  };
  const dropped = resources.invalidateFor(intent);
  assert.ok(dropped >= 1, "affected cache entries dropped");

  // transport now returns the new title (mock simulates the changed world)
  world.issueData = { number: 17, state: "open", title: "Renamed" };
  const second = await resources.read(ref);
  assert.match(second.projection, /Renamed/, "fresh state after invalidation");
  assert.equal(second.outcome, "network-fetch", "not served from stale memory");
});

test("[§18] unchanged resource returns compact unchanged result for a known snapshot", async () => {
  const { calls, transport } = stubTransport(() => ({
    data: { number: 42, state: "open", title: "Feature", head: { sha: "aaaa" } },
    etag: 'W/"p1"',
  }));
  const resources = new GitHubResources(transport, {} as never, now);
  const first = await resources.read(prRef());
  const second = await resources.read(prRef(), { knownSnapshot: first.snapshotId });
  assert.match(
    second.projection,
    /^unchanged\nresource: gh:pr:o\/n#42\nsnapshot: /,
    "compact unchanged result",
  );
  assert.ok(calls.length >= 2 || second.outcome === "memory-hit");
});

test("[G6] huge bodies are explicitly truncated with an envelope, never silently", async () => {
  const { transport } = stubTransport(() => ({
    data: {
      number: 1,
      state: "open",
      title: "Big body",
      body: "x".repeat(10_000),
      head: { sha: "a" },
    },
    etag: undefined,
  }));
  const resources = new GitHubResources(transport, {} as never, now);
  const result = await resources.read({ kind: "pr", owner: "o", repo: "n", number: 1 });
  assert.match(result.projection, /truncated: showing .* of 10000 chars/, "explicit envelope");
  assert.ok(result.projection.length < 10_000, "bounded output");
});
