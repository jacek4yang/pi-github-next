// Shared error helpers. Deliberately dependency-free so refs/deltas can use
// them without importing the octokit adapter.

import type { GitHubError, GitHubErrorCode } from "./types.ts";

export function gitHubError(
  code: GitHubErrorCode,
  message: string,
  opts?: { retryable?: boolean; status?: number },
): GitHubError {
  const error = new Error(message) as GitHubError;
  error.code = code;
  error.retryable = opts?.retryable ?? false;
  error.status = opts?.status;
  return error;
}

export function taskErrorShim(message: string): Error {
  return new Error(message);
}
