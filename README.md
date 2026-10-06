# pi-github-next

Efficient, structured GitHub access for the [Pi](https://github.com/earendil-works/pi)
coding agent — the third Agent Body v2 productization plugin.

pi-github-next owns GitHub resource identity, reads, purpose-specific
projections, the API cache, ETag/conditional requests, singleflight
coalescing, rate-limit state, mutation intent/outcome truth, and
reconciliation. It does NOT own CI lifecycle (future pi-ci-next consumes
resource primitives from here), task state, approval policy, or credentials.

## Design: one reasoning result, not N+1 model calls

`github { action: "summary", ref: "gh:pr:o/n#42" }` returns ONE bounded
projection: state/draft, base←head with head SHA, mergeability, review-state
summary, labels, changed-file count, open/update dates, and a truncated body
envelope. Internally the resource layer may issue several API calls — all
cached, coalesced, and counted; expensive detail (file patches, full
threads, full diffs) stays explicitly on demand (`pr_file_patch`, `detail`).

## Resource identity and version identity

```
gh:repo:owner/name        gh:pr:owner/name#42      gh:issue:owner/name#17
gh:commit:owner/name@sha  gh:branch:owner/name@ref gh:release:owner/name@tag
```

Resource identity (which resource) is separated from version identity
(ETag / head SHA / updated_at). Branch names and PR numbers are never
treated as version identity.

## Cache, conditionals, singleflight

- **Per-kind TTL** — immutable commits never expire; published releases 6 h;
  closed issues 6 h; open issues 5 min; open PRs 1 min; branches 30 s.
  Within TTL, memory hits make **zero** API calls (enriched projections are
  cached per resource version).
- **Conditional validation** — stale entries revalidate with
  `If-None-Match`; a 304 refreshes freshness without retransferring the
  payload and is counted as a _conditional hit_ — never as a full fetch.
- **Singleflight** — concurrent identical reads coalesce onto one in-flight
  request; the key is released on success, failure, and cancellation.
- **Bounds** — LRU eviction by entry count (128) AND estimated bytes (4 MiB).
  In-memory by design; correctness never depends on warm cache.

## Mutations with durable truth

Supported: `create_issue`, `comment`, `update_issue`, `create_pr`,
`merge_pr`, `add_labels`. Every mutation:

1. computes a deterministic **intent digest** over material fields only
   (repo, number, body, labels, expected head SHA, merge method);
2. writes a durable journal record **before** the request
   (`not-started → started → …`) — the journal, not assistant prose, is the
   side-effect truth;
3. **never auto-retries** mutations;
4. treats a network failure after possible commit as **unknown** and
   reconciles: embedded reconciliation markers prove committed/not-committed
   (comment/issue search, PR merge state + head comparison); a proven
   not-committed operation is retried exactly once; inconclusive fails
   CLOSED as `unknown` with the operation id for manual follow-up;
5. **never re-executes** a known-completed mutation with the same intent
   (journal reuse survives session reopen).

Journal: hash-digested JSONL under the agent dir (0600), tail-truncation
auto-recovery, tamper detection fails closed to the verified prefix,
terminal records GC'd at 100 — pinned (started/unknown) records are never
dropped. No credentials, no full private bodies.

## Policy and task integration

- **Policy** (pi-policy-next) owns authorization through the `tool_call`
  gate: GitHub mutations classify as `github-write` / `github-destructive`
  with material identity (repo, number, expected head SHA, method) in the
  approval intent — a head-SHA or method change invalidates a prior approval.
- **Tasks** (pi-task-next) hold concise `gh:*` refs only. Issue-candidate
  promotion is a structured contract: a completed `create_issue` mutation
  carrying an `issueCandidateId` emits `pinx.github.mutation`; the task
  layer marks its local candidate promoted. Explicit, never automatic.

## Model context discipline

Cache stats, ETags, rate-limit counters, and snapshot registries are
UI/diagnostic state — never injected into model context. Repeated reads of
an unchanged resource return a compact `unchanged` result (snapshot id
matching) instead of repeating the payload. Errors are bounded and typed
(`NOT_AUTHENTICATED`, `TOKEN_EXPIRED`, `PERMISSION_DENIED`, `RATE_LIMITED`,
`NETWORK_ERROR`, …); tokens never appear in errors or events.

## Authentication

Standard GitHub mechanism: `GH_TOKEN` (or `GITHUB_TOKEN`) from the
environment. Pi remains the credential owner; nothing is stored. Without a
token the plugin fails fast and honestly reports `NOT_AUTHENTICATED`.

## Development

```bash
npm ci
npm run bench   # workload scenarios A–F (measured API-call reductions)
npm run soak    # 800+ reads, 400 burst callers, mutations, reconciliation
npm run ci      # check:pi + typecheck + lint + format + test
```

Windows/Linux parity: pure Node HTTP transport (no `gh` CLI, no shell) —
the gh CLI is not used on any production path. Pi pinned exactly (`check:pi`).
Invariants **G1–G7** are test-tagged and conformance-mapped in the meta
repository.
