// pi-github-next — stack identity, quotas, contracts.

export const STACK_INFO = {
  name: "pi-github-next",
  contractVersion: 1,
  tool: {
    name: "github",
  },
  /** Versioned contracts owned by this plugin. */
  events: {
    resourceChanged: "pinx.github.resource.changed",
    mutation: "pinx.github.mutation",
  },
  env: {
    /** Token source (standard GitHub mechanism; never stored or logged). */
    token: "GH_TOKEN", // GITHUB_TOKEN also honored
    disable: "PINX_GITHUB_DISABLE", // =1 disables the plugin entirely
  },
  /** Cache + journal quotas (documented, deterministic). */
  quotas: {
    /** Bounded LRU cache: max entries AND max estimated payload bytes. */
    cacheMaxEntries: 128,
    cacheMaxBytes: 4 * 1024 * 1024,
    /** Per-kind freshness TTLs (ms). Immutable resources never expire. */
    ttlMs: {
      commit: Number.POSITIVE_INFINITY, // immutable by SHA
      release: 6 * 60 * 60 * 1000, // published releases are stable
      repo: 60 * 60 * 1000,
      issueClosed: 6 * 60 * 60 * 1000,
      issue: 5 * 60 * 1000, // open issues churn
      pr: 60 * 1000, // open PRs churn fast
      branch: 30 * 1000, // refs move on push
      default: 60 * 1000,
    },
    /** Snapshot registry (model-visible unchanged-detection), session-scoped. */
    maxSnapshots: 64,
    /** Mutation journal bound. */
    journalMaxTerminal: 100,
    /** Content bounds (chars) — explicit truncation envelopes, G6. */
    bounds: {
      bodyChars: 4000,
      commentChars: 2000,
      diffChars: 16_000,
      listItems: 20,
      maxChangedFiles: 100,
    },
  },
} as const;
