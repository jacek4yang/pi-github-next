// Concise versioned resource refs (§38): parse + format, deterministic.

import { taskErrorShim } from "./errors.ts";
import type { ResourceKind, ResourceRef } from "./types.ts";

const KINDS: ReadonlySet<ResourceKind> = new Set([
  "repo",
  "commit",
  "branch",
  "pr",
  "issue",
  "release",
]);

/** `gh:pr:owner/name#42` → ResourceRef. Version markers live in refs as `@marker`. */
export function formatRef(ref: ResourceRef): string {
  const base = `gh:${ref.kind}:${ref.owner}/${ref.repo}`;
  switch (ref.kind) {
    case "pr":
    case "issue":
      return `${base}#${ref.number}`;
    case "commit":
    case "branch":
    case "release":
      return `${base}@${ref.versionMarker ?? ""}`;
    case "repo":
      return base;
    default: {
      const exhaustive: never = ref.kind;
      throw taskErrorShim(`unknown resource kind: ${String(exhaustive)}`);
    }
  }
}

export function parseRef(text: string): ResourceRef {
  const match =
    /^gh:(repo|commit|branch|pr|issue|release):([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(?:#(\d+)|@(.+))?$/.exec(
      text,
    );
  if (!match) {
    throw taskErrorShim(`unparseable GitHub resource ref: ${text}`);
  }
  const kind = match[1] as ResourceKind;
  if (!KINDS.has(kind)) throw taskErrorShim(`unsupported ref kind: ${kind}`);
  return {
    kind,
    owner: match[2]!,
    repo: match[3]!,
    number: match[4] !== undefined ? Number(match[4]) : undefined,
    versionMarker: match[5],
  };
}

/** Repo slug "owner/name" with light validation. */
export function repoSlug(owner: string, repo: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
    throw taskErrorShim(`invalid repository slug: ${owner}/${repo}`);
  }
  return `${owner}/${repo}`;
}

/** True when the kind's identity includes an immutable version marker. */
export function isImmutableKind(kind: ResourceKind, ref: ResourceRef): boolean {
  if (kind === "commit")
    return Boolean(ref.versionMarker && /^[0-9a-f]{7,40}$/.test(ref.versionMarker));
  if (kind === "release") return Boolean(ref.versionMarker);
  return false;
}
