// Pi compatibility gate: the installed @earendil-works/pi-coding-agent must
// exactly match the version this repo declares and was tested against.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const declared = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).devDependencies[
  "@earendil-works/pi-coding-agent"
];

// Locate the installed package (repo node_modules, walking up for hoisted installs).
let dir = repoRoot;
let pkgPath;
for (let i = 0; i < 6 && !pkgPath; i++) {
  const candidate = join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
  if (existsSync(candidate)) pkgPath = candidate;
  dir = dirname(dir);
}
if (!pkgPath) throw new Error("installed @earendil-works/pi-coding-agent not found — run npm ci");
const installed = JSON.parse(readFileSync(pkgPath, "utf8")).version;
assert.equal(
  installed,
  declared,
  `Pi version mismatch: installed ${installed}, declared ${declared}`,
);
console.log(`pi-version OK: ${installed}`);
