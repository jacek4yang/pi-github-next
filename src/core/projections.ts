// Purpose-specific projections (§7/§10/§41-42): one reasoning-boundary
// result instead of the N+1 model-call pattern. Bounded output with
// EXPLICIT truncation envelopes (G6) — never silent truncation. Large
// expensive detail (full diffs, full comment threads) stays on demand.

import { STACK_INFO } from "../info.ts";
import { gitHubError } from "./errors.ts";
import type { BoundedText } from "./types.ts";

const Q = STACK_INFO.quotas.bounds;

export function boundText(text: unknown, maxChars: number, what: string): BoundedText {
  void what;
  const raw = typeof text === "string" ? text : "";
  if (raw.length <= maxChars) return { text: raw, truncated: false, originalChars: raw.length };
  return {
    text: raw.slice(0, maxChars - 1) + "…",
    truncated: true,
    originalChars: raw.length,
    // envelope marker is appended by the caller line
    // (kept machine-checkable here)
  } as BoundedText;
}

function envelopeLine(what: string, bounded: BoundedText): string | undefined {
  return bounded.truncated
    ? `[${what} truncated: showing ${bounded.text.length} of ${bounded.originalChars} chars — request detail for more]`
    : undefined;
}

function fmtDate(iso: unknown): string | undefined {
  if (typeof iso !== "string") return undefined;
  return iso.slice(0, 10); // date-only: semantically useful, stable, short
}

interface PrData {
  number?: number;
  state?: string;
  draft?: boolean;
  title?: string;
  base?: { ref?: string };
  head?: { ref?: string; sha?: string; label?: string };
  mergeable?: boolean | null;
  mergeable_state?: string;
  labels?: Array<{ name?: string }>;
  created_at?: string;
  updated_at?: string;
  user?: { login?: string };
  body?: string;
  changed_files?: number;
  additions?: number;
  deletions?: number;
}

export interface ReviewSummary {
  state: string;
  approved: number;
  changesRequested: number;
  commented: number;
  pending: number;
}

/** One bounded reasoning-boundary result for a PR (§8). */
export function renderPrSummary(
  pr: PrData,
  reviews?: ReviewSummary,
  files?: Array<{ filename?: string; additions?: number; deletions?: number }>,
): string {
  const repo = "";
  void repo;
  const lines = [
    `PR #${pr.number ?? "?"} [${pr.state ?? "?"}${pr.draft ? " · draft" : ""}] ${pr.title ?? ""}`,
    `base: ${pr.base?.ref ?? "?"} ← head: ${pr.head?.ref ?? "?"} @ ${pr.head?.sha?.slice(0, 10) ?? "?"}`,
  ];
  if (pr.mergeable !== undefined && pr.mergeable !== null) {
    lines.push(
      `mergeable: ${pr.mergeable ? "yes" : "no"}${pr.mergeable_state ? ` (${pr.mergeable_state})` : ""}`,
    );
  }
  if (reviews) {
    lines.push(
      `reviews: ${reviews.approved} approved · ${reviews.changesRequested} changes-requested · ${reviews.commented} commented${reviews.pending ? ` · ${reviews.pending} pending` : ""}`,
    );
  }
  if (Array.isArray(pr.labels) && pr.labels.length > 0) {
    lines.push(
      `labels: ${pr.labels
        .map((l) => l.name)
        .filter(Boolean)
        .join(", ")}`,
    );
  }
  if (pr.changed_files !== undefined) {
    lines.push(
      `changes: ${pr.changed_files} file(s) (+${pr.additions ?? 0}/-${pr.deletions ?? 0})`,
    );
  }
  if (files && files.length > 0) {
    const shown = files
      .slice(0, 10)
      .map((f) => `  ${f.filename} (+${f.additions ?? 0}/-${f.deletions ?? 0})`);
    if (files.length > 10) shown.push(`  … ${files.length - 10} more files`);
    lines.push("files:", ...shown);
  }
  lines.push(
    `opened: ${fmtDate(pr.created_at) ?? "?"} by ${pr.user?.login ?? "?"} · updated: ${fmtDate(pr.updated_at) ?? "?"}`,
  );
  if (typeof pr.body === "string" && pr.body.length > 0) {
    const body = boundText(pr.body, Q.bodyChars, "PR body");
    lines.push("body:", body.text);
    const env = envelopeLine("PR body", body);
    if (env) lines.push(env);
  }
  return lines.join("\n");
}

interface IssueData {
  number?: number;
  state?: string;
  title?: string;
  labels?: Array<{ name?: string }>;
  comments?: number;
  user?: { login?: string };
  created_at?: string;
  updated_at?: string;
  body?: string;
}

export function renderIssueSummary(issue: IssueData): string {
  const lines = [
    `Issue #${issue.number ?? "?"} [${issue.state ?? "?"}] ${issue.title ?? ""}`,
    `labels: ${
      (issue.labels ?? [])
        .map((l) => l.name)
        .filter(Boolean)
        .join(", ") || "(none)"
    } · comments: ${issue.comments ?? 0}`,
    `opened: ${fmtDate(issue.created_at) ?? "?"} by ${issue.user?.login ?? "?"} · updated: ${fmtDate(issue.updated_at) ?? "?"}`,
  ];
  if (typeof issue.body === "string" && issue.body.length > 0) {
    const body = boundText(issue.body, Q.bodyChars, "issue body");
    lines.push("body:", body.text);
    const env = envelopeLine("issue body", body);
    if (env) lines.push(env);
  }
  return lines.join("\n");
}

interface RepoData {
  full_name?: string;
  description?: string | null;
  default_branch?: string;
  stargazers_count?: number;
  open_issues_count?: number;
  pushed_at?: string;
  visibility?: string;
  archived?: boolean;
  language?: string | null;
}

export function renderRepoSummary(repo: RepoData): string {
  return [
    `${repo.full_name ?? "?"}${repo.archived ? " [archived]" : ""} · ${repo.visibility ?? "?"} · ${repo.language ?? "unknown"}`,
    `default branch: ${repo.default_branch ?? "?"} · stars: ${repo.stargazers_count ?? 0} · open issues: ${repo.open_issues_count ?? 0}`,
    `last push: ${fmtDate(repo.pushed_at) ?? "?"}`,
    repo.description ? `description: ${repo.description}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

interface CommitData {
  sha?: string;
  commit?: { message?: string; author?: { name?: string; date?: string } };
  stats?: { additions?: number; deletions?: number };
  files?: Array<{ filename?: string }>;
}

export function renderCommitSummary(commit: CommitData): string {
  const lines = [
    `commit ${commit.sha?.slice(0, 10) ?? "?"} by ${commit.commit?.author?.name ?? "?"} on ${fmtDate(commit.commit?.author?.date) ?? "?"}`,
  ];
  const message = (commit.commit?.message ?? "").split("\n");
  lines.push(`subject: ${message[0] ?? ""}`);
  if (message.length > 1) lines.push(`(${message.length - 1} more message line(s))`);
  if (commit.stats) {
    lines.push(
      `changes: ${commit.files?.length ?? "?"} file(s) (+${commit.stats.additions ?? 0}/-${commit.stats.deletions ?? 0})`,
    );
  }
  return lines.join("\n");
}

interface ReleaseData {
  tag_name?: string;
  name?: string | null;
  prerelease?: boolean;
  draft?: boolean;
  published_at?: string;
  body?: string;
}

export function renderReleaseSummary(release: ReleaseData): string {
  const lines = [
    `release ${release.tag_name ?? "?"}${release.prerelease ? " [pre-release]" : ""}${release.draft ? " [draft]" : ""} — ${release.name ?? ""}`,
    `published: ${fmtDate(release.published_at) ?? "?"}`,
  ];
  if (typeof release.body === "string" && release.body.length > 0) {
    const body = boundText(release.body, Q.bodyChars, "release notes");
    lines.push("notes:", body.text);
    const env = envelopeLine("release notes", body);
    if (env) lines.push(env);
  }
  return lines.join("\n");
}

/** Specific file patch on demand (§42); bounded, never silent. */
export function renderFilePatch(filename: string, patch: unknown): string {
  const patchText =
    typeof patch === "string" ? patch : "(binary or no inline patch — fetch via contents API)";
  const bounded = boundText(patchText, Q.diffChars, "patch");
  const lines = [`patch: ${filename}`, bounded.text];
  const env = envelopeLine("patch", bounded);
  if (env) lines.push(env);
  return lines.join("\n");
}

/** List projection with explicit hasMore (§43). */
export function renderList(kind: string, items: Array<{ title: string; detail: string }>): string {
  if (items.length === 0) return `(${kind}: none)`;
  const shown = items.slice(0, Q.listItems);
  const lines = shown.map((i) => `- ${i.title}: ${i.detail}`);
  if (items.length > Q.listItems) {
    lines.push(`… ${items.length - Q.listItems} more (hasMore: true — refine the query)`);
  }
  return lines.join("\n");
}

export function requireNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw gitHubError("GITHUB_ERROR", `${what} must be a number`);
  }
  return value;
}
