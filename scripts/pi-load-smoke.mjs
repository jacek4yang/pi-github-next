// Real-Pi load smoke: load this package's extension through the actual Pi SDK
// with a disposable agent home, assert clean load and that the github tool
// and /github-next command are registered. No model calls, no network.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempAgentDir = mkdtempSync(join(tmpdir(), "pi-github-smoke-"));
process.env.PI_CODING_AGENT_DIR = tempAgentDir;

const { createAgentSession, DefaultResourceLoader, SessionManager } =
  await import("@earendil-works/pi-coding-agent");

const probe = { commands: null, tools: null };
const loader = new DefaultResourceLoader({
  cwd: repoRoot,
  agentDir: tempAgentDir,
  additionalExtensionPaths: [join(repoRoot, "src", "index.ts")],
  extensionFactories: [
    (pi) => {
      pi.on("session_start", () => {
        probe.commands = pi.getCommands().map((c) => c.name);
        probe.tools = pi.getAllTools().map((t) => t.name);
      });
      pi.on("tool_call", () => {
        return undefined; // a second opinion that never blocks
      });
    },
  ],
});
await loader.reload();
const { errors, warnings } = loader.extensionsResult;
assert.deepEqual(errors, [], `extension load errors: ${JSON.stringify(errors)}`);
console.log(`pi-load-smoke: extensions loaded (${warnings?.length ?? 0} warnings)`);

const { session } = await createAgentSession({
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(),
});
try {
  await session.bindExtensions({ mode: "json" });
  await new Promise((r) => setImmediate(r));
  assert.ok(Array.isArray(probe.commands), "session_start probe never ran");
  assert.ok(
    probe.commands?.includes("github-next"),
    `github-next command registered (commands: ${probe.commands?.join(", ")})`,
  );
  assert.ok(
    probe.tools?.includes("github"),
    `tool 'github' missing; got ${JSON.stringify(probe.tools)}`,
  );
  console.log(
    `pi-load-smoke OK: /github-next present, github tool registered (${probe.tools?.length ?? 0} tools total)`,
  );
} finally {
  session.dispose();
  rmSync(tempAgentDir, { recursive: true, force: true });
}
