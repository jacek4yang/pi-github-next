// pi-github-next — efficient structured GitHub access for Pi.
//
// OWNERSHIP: GitHub resource identity/reads/projections, API caching,
// ETag/conditional requests, singleflight, rate-limit state, mutation
// intent/outcome truth, reconciliation. NOT owned: CI lifecycle (future
// pi-ci-next), task state, approval policy, credentials.
//
// POLICY: authorization belongs to pi-policy-next via the tool_call gate —
// github mutations are classified github-write/github-destructive with
// material identity (repo, number, head SHA, method) in the intent (§25).
// This plugin never makes authorization decisions itself.
//
// TASK: issue-candidate promotion is a structured-contract boundary —
// a successful create_issue mutation carrying issueCandidateId emits
// `pinx.github.mutation`, which pi-task-next consumes to mark the
// candidate promoted (§26). No plugin-to-plugin imports either way.
//
// G7: tokens live in the environment (GH_TOKEN/GITHUB_TOKEN) and are never
// logged, stored, emitted, or included in errors.

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { Type } from "typebox";
import { STACK_INFO } from "./info.ts";
import { registerGithubService } from "./core/service.ts";
import { gitHubError } from "./core/errors.ts";
import { formatRef, parseRef, repoSlug } from "./core/refs.ts";
import { GitHubTransport } from "./core/transport.ts";
import { GitHubResources } from "./core/resources.ts";
import { MutationEngine, type MutationOutcome } from "./core/mutations.ts";
import { MutationJournal } from "./core/journal.ts";
import type { MutationIntent } from "./core/types.ts";

function respond(text: string, isError = false, details?: unknown) {
  return { content: [{ type: "text" as const, text }], isError, details };
}

export default function piGithubNext(pi: ExtensionAPI) {
  if (process.env[STACK_INFO.env.disable] === "1") {
    pi.registerCommand("github-next", {
      description: "Show pi-github-next status",
      handler: async (_args, ctx) => {
        await ctx.ui.notify(
          "pi-github-next: DISABLED (no protection or access claimed)",
          "warning",
        );
      },
    });
    return;
  }

  const transport = new GitHubTransport();
  const journal = new MutationJournal(
    join(getAgentDir(), "pinx", "github-next", "mutations.jsonl"),
  );
  const engine = new MutationEngine(transport, journal, Date.now, (payload) => {
    try {
      pi.events.emit(STACK_INFO.events.mutation, payload);
    } catch {
      // observability is best-effort
    }
  });
  const resources = new GitHubResources(transport, engine, Date.now, (payload) => {
    try {
      pi.events.emit(STACK_INFO.events.resourceChanged, payload);
    } catch {
      // observability is best-effort
    }
  });

  // Public service exposure (CONTRACTS §12): pi-ci-next obtains the shared
  // GitHub stack over the event bus — single auth/cache/rate-limit/journal.
  registerGithubService(pi, { transport, resources, engine });

  const schema = Type.Object({
    action: Type.Union([
      Type.Literal("summary"),
      Type.Literal("detail"),
      Type.Literal("list"),
      Type.Literal("mutate"),
      Type.Literal("pr_file_patch"),
      Type.Literal("promote_issue_candidate"),
      Type.Literal("status"),
    ]),
    /** Resource ref: `gh:pr:owner/name#42`, `gh:issue:owner/name#17`, etc. */
    ref: Type.Optional(
      Type.String({
        description:
          "Resource ref (gh:pr:o/n#42, gh:issue:o/n#17, gh:repo:o/n, gh:commit:o/n@sha, gh:release:o/n@tag)",
      }),
    ),
    /** Previously consumed snapshot id — returns a compact "unchanged" result. */
    snapshot: Type.Optional(
      Type.String({ description: "Snapshot id from a previous read for unchanged-detection" }),
    ),
    files: Type.Optional(Type.Boolean({ description: "Include changed-file list in PR summary" })),
    file: Type.Optional(Type.String({ description: "Filename for pr_file_patch" })),
    /** Mutations */
    operation: Type.Optional(
      Type.Union([
        Type.Literal("create_issue"),
        Type.Literal("comment"),
        Type.Literal("update_issue"),
        Type.Literal("create_pr"),
        Type.Literal("merge_pr"),
        Type.Literal("add_labels"),
      ]),
    ),
    repository: Type.Optional(Type.String({ description: "owner/name (mutations)" })),
    title: Type.Optional(Type.String({ description: "Issue/PR title" })),
    body: Type.Optional(Type.String({ description: "Body/comment text (bounded)" })),
    number: Type.Optional(Type.Number({ description: "Issue/PR number" })),
    labels: Type.Optional(Type.Array(Type.String())),
    head: Type.Optional(Type.String({ description: "PR head branch (create_pr)" })),
    base: Type.Optional(Type.String({ description: "PR base branch (create_pr)" })),
    head_sha: Type.Optional(
      Type.String({ description: "Expected head SHA — material identity for merge_pr" }),
    ),
    method: Type.Optional(
      Type.Union([Type.Literal("merge"), Type.Literal("squash"), Type.Literal("rebase")]),
    ),
    issue_candidate_id: Type.Optional(
      Type.String({ description: "Local issue candidate id to mark promoted on success" }),
    ),
  });

  pi.registerTool({
    name: STACK_INFO.tool.name,
    label: "GitHub",
    description:
      "Structured GitHub access: purpose-specific summaries (repo/PR/issue/commit/release) with caching and unchanged-detection, " +
      "on-demand detail (file patches), and safe mutations with durable outcomes. Cache/snapshot ids are optional optimizations.",
    parameters: schema,
    async execute(_toolCallId: unknown, params: unknown, signal?: AbortSignal) {
      try {
        return await handle(params as never, signal);
      } catch (error) {
        const err = error as { code?: string; message?: string };
        const code = err.code ?? "NETWORK_ERROR";
        return respond(`${code}: ${err.message ?? "github error"}`, true, { code });
      }
    },
  } as never);

  async function handle(p: Record<string, unknown>, signal?: AbortSignal) {
    const action = p.action as string;
    switch (action) {
      case "status": {
        const counts = journal.counts();
        return respond(
          [
            `auth: ${transport.authenticated ? "token present" : "NOT AUTHENTICATED (set GH_TOKEN)"}`,
            `rate limit: ${transport.rateLimit ? `${transport.rateLimit.remaining}/${transport.rateLimit.limit} (reset ${transport.rateLimit.reset ? new Date(transport.rateLimit.reset).toISOString() : "?"})` : "unknown"}`,
            `cache: ${resources.health().entries} entries · ${resources.health().bytes} bytes`,
            `journal: ${journal.journalState} · pending ${counts.pending} · unknown ${counts.unknown}`,
          ].join("\n"),
        );
      }
      case "summary": {
        if (typeof p.ref !== "string") return respond("GITHUB_ERROR: ref required", true);
        const ref = parseRef(p.ref);
        const result = await resources.read(ref, {
          signal,
          knownSnapshot: typeof p.snapshot === "string" ? p.snapshot : undefined,
          withFiles: p.files === true,
        });
        return respond(result.projection, false, {
          snapshotId: result.snapshotId,
          outcome: result.outcome,
          ref: formatRef(ref),
        });
      }
      case "detail": {
        if (typeof p.ref !== "string") return respond("GITHUB_ERROR: ref required", true);
        const ref = parseRef(p.ref);
        // detail = full fresh read (ignores snapshot-unchanged compaction)
        const result = await resources.read(ref, { signal, withFiles: ref.kind === "pr" });
        return respond(result.projection, false, {
          snapshotId: result.snapshotId,
          outcome: result.outcome,
        });
      }
      case "list": {
        if (typeof p.ref !== "string" || typeof p.repository !== "string") {
          return respond("GITHUB_ERROR: ref (kind) and repository required", true);
        }
        return respond(
          "GITHUB_ERROR: use summary with a specific ref; open PR/issue listing arrives with pi-ci-next scoping",
          true,
        );
      }
      case "pr_file_patch": {
        if (typeof p.ref !== "string" || typeof p.file !== "string") {
          return respond("GITHUB_ERROR: ref and file required", true);
        }
        const patch = await resources.prFilePatch(parseRef(p.ref), p.file, { signal });
        return respond(patch);
      }
      case "promote_issue_candidate":
      case "mutate": {
        if (typeof p.operation !== "string")
          return respond("GITHUB_ERROR: operation required", true);
        if (typeof p.repository !== "string")
          return respond("GITHUB_ERROR: repository required", true);
        repoSlug(p.repository.split("/")[0]!, p.repository.split("/")[1] ?? "");
        const intent: MutationIntent = {
          operation: p.operation as MutationIntent["operation"],
          repository: p.repository,
          fields: {
            title: typeof p.title === "string" ? p.title : undefined,
            body: typeof p.body === "string" ? p.body : undefined,
            number: typeof p.number === "number" ? p.number : undefined,
            labels: Array.isArray(p.labels) ? (p.labels as string[]) : undefined,
            head: typeof p.head === "string" ? p.head : undefined,
            base: typeof p.base === "string" ? p.base : undefined,
            head_sha: typeof p.head_sha === "string" ? p.head_sha : undefined,
            method: typeof p.method === "string" ? p.method : undefined,
            issueCandidateId:
              typeof p.issue_candidate_id === "string" ? p.issue_candidate_id : undefined,
          },
        };
        const outcome: MutationOutcome = await engine.execute(intent, { signal });
        if (outcome.state === "completed") {
          // Promotion boundary: pi-task-next consumes this event and marks
          // its local candidate promoted — structured contract, no imports.
          const candidateId = intent.fields.issueCandidateId;
          if (typeof candidateId === "string") {
            try {
              pi.events.emit(STACK_INFO.events.mutation, {
                v: 1,
                operationId: outcome.record.operationId,
                operation: intent.operation,
                repository: intent.repository,
                state: "completed",
                resultRef: outcome.resultRef,
                issueCandidateId: candidateId,
              });
            } catch {
              // best-effort
            }
          }
          const line = `${intent.operation} completed\nresource: ${outcome.resultRef ?? intent.repository}\nsnapshot ref: ${outcome.record.operationId}`;
          return respond(line, false, { state: outcome.state, resultRef: outcome.resultRef });
        }
        if (outcome.state === "unknown") {
          return respond(
            [
              "MUTATION OUTCOME UNKNOWN",
              `reason: ${outcome.reason ?? "network failure after possible commit"}`,
              "reconciliation was attempted; do NOT blindly retry",
              `operation id: ${outcome.record.operationId} (kept in journal for reconciliation)`,
              "next: verify the resource on GitHub, then retry or reconcile explicitly",
            ].join("\n"),
            true,
            { state: "unknown", operationId: outcome.record.operationId },
          );
        }
        return respond(
          `${intent.operation} ${outcome.state}: ${outcome.reason ?? "see journal"}`,
          true,
          { state: outcome.state },
        );
      }
      default:
        return respond(`GITHUB_ERROR: unknown action ${action}`, true);
    }
  }

  pi.registerCommand("github-next", {
    description: "Show pi-github-next health (auth, rate limit, cache, journal)",
    handler: async (_args, ctx) => {
      void ctx;
      const counts = journal.counts();
      await ctx.ui.notify(
        [
          `pi-github-next ${STACK_INFO.contractVersion} · auth ${transport.authenticated ? "ok" : "unavailable"}`,
          `rate limit: ${transport.rateLimit ? `${transport.rateLimit.remaining}/${transport.rateLimit.limit}` : "unknown"} · cache: ${resources.health().entries} entries / ${resources.health().bytes} bytes`,
          `journal: ${journal.journalState} · ${counts.total} records · pending ${counts.pending} · unknown ${counts.unknown}${journal.degradedReason ? ` · DEGRADED: ${journal.degradedReason}` : ""}`,
          gitHubError("NOT_AUTHENTICATED", "").code === "NOT_AUTHENTICATED" &&
          !transport.authenticated
            ? "set GH_TOKEN to enable access"
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
        transport.authenticated ? "info" : "warning",
      );
    },
  });
}
