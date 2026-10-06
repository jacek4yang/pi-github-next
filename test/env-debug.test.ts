import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubTransport } from "../src/core/transport.ts";

test("env debug", () => {
  process.env.GH_TOKEN = "test";
  const t1 = new GitHubTransport();
  assert.equal(t1.authenticated, true);
  delete process.env.GH_TOKEN;
  const t2 = new GitHubTransport();
  console.log("t2:", t2.authenticated);
  assert.equal(t2.authenticated, false, "transport respects env deletion");
  process.env.GITHUB_TOKEN = "other";
  const t3 = new GitHubTransport();
  assert.equal(t3.authenticated, true);
  delete process.env.GITHUB_TOKEN;
});
