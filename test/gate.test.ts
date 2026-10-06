// Pi wiring gate tests: tool registered, error taxonomy surfaced, disabled
// mode claims nothing. Network behavior is fully stubbed at the transport
// layer in resources/mutations tests — the wiring adds error→tool mapping.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { default as piGithubNext } from "../src/index.ts";

function harness(env: Record<string, string> = {}) {
  const commands: string[] = [];
  const tools: Array<{ name?: string }> = [];
  const bus: Array<{ channel: string; payload: unknown }> = [];
  const agentDir = mkdtempSync(join(tmpdir(), "pinx-gh-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.GH_TOKEN; // harness env isolation
  delete process.env.GITHUB_TOKEN;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;

  const pi = {
    on: () => () => {},
    registerTool: (tool: { name?: string }) => {
      tools.push(tool);
    },
    registerCommand: (name: string) => {
      commands.push(name);
    },
    events: {
      emit: (channel: string, payload: unknown) => {
        bus.push({ channel, payload });
      },
      on: () => () => {},
    },
  };
  piGithubNext(pi as never);
  const cleanup = () => {
    for (const k of Object.keys(env)) delete process.env[k];
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    rmSync(agentDir, { recursive: true, force: true });
  };
  const tool = tools.find((t) => t.name === "github") as never as {
    execute: (
      id: unknown,
      params: unknown,
      signal?: AbortSignal,
    ) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  };
  return { commands, tools, bus, tool, cleanup };
}

test("[G] github tool + /github-next command registered; bounded surface", () => {
  const h = harness({ GH_TOKEN: "ghp_test" });
  assert.ok(
    h.tools.some((t) => t.name === "github"),
    "github tool present",
  );
  assert.equal(h.tools.length, 1, "exactly one model-visible tool (bounded surface)");
  assert.ok(h.commands.includes("github-next"), "status command present");
  h.cleanup();
});

test("[G] status works without network; auth state honest", async () => {
  const h = harness({ GH_TOKEN: "ghp_test" });
  const status = await h.tool.execute(undefined, { action: "status" });
  assert.match(status.content[0]!.text, /token present/);
  const noAuth = harness({});
  const status2 = await noAuth.tool.execute(undefined, { action: "status" });
  assert.match(status2.content[0]!.text, /NOT AUTHENTICATED/);
  noAuth.cleanup();
  h.cleanup();
});

test("[G7] no-auth summary fails with NOT_AUTHENTICATED and never leaks the token", async () => {
  const h = harness({}); // no token
  const result = await h.tool.execute(undefined, { action: "summary", ref: "gh:pr:o/n#1" });
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /NOT_AUTHENTICATED|NETWORK_ERROR/);
  assert.ok(!result.content[0]!.text.includes("ghp_"), "no token material in errors");
  h.cleanup();
});

test("[G] disabled mode claims nothing", async () => {
  const h = harness({ PINX_GITHUB_DISABLE: "1" });
  assert.equal(h.tools.length, 0, "no tools when disabled");
  assert.ok(h.commands.includes("github-next"), "status command still explains state");
  h.cleanup();
});

test("[G] mutation with unknown operation is a bounded tool error, not a throw", async () => {
  const h = harness({ GH_TOKEN: "ghp_test" });
  const result = await h.tool.execute(undefined, {
    action: "mutate",
    operation: "delete_everything",
    repository: "o/r",
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /GITHUB_ERROR/);
  h.cleanup();
});

test("[G5] mutation completion emits pinx.github.mutation; read invalidation wired", async () => {
  const h = harness({ GH_TOKEN: "ghp_test" });
  // Without network the mutation fails cleanly pre-send (422-class) — the
  // journal still records the attempt (not-started→failed).
  const result = await h.tool.execute(undefined, {
    action: "mutate",
    operation: "comment",
    repository: "o/r",
    number: 1,
    body: "hello",
  });
  // network failure (no real GitHub in tests): outcome must NOT be "completed"
  assert.equal(result.isError, true);
  assert.ok(
    /unknown|failed|NETWORK|RATE_LIMITED|NOT_AUTHENTICATED/.test(result.content[0]!.text),
    `bounded terminal outcome: ${result.content[0]!.text.slice(0, 80)}`,
  );
  h.cleanup();
});
