// Package smoke: npm pack produces a tarball for the package.
// (Real-Pi load smoke is added on feature branches.)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const source = process.env.INIT_CWD ?? process.cwd();
const out = tmpdir();
const tarball = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", source], {
  encoding: "utf8",
  cwd: out,
  shell: process.platform === "win32",
})
  .trim()
  .split("\n")
  .pop();
assert(tarball && tarball.endsWith(".tgz"), "npm pack did not produce a tarball");
console.log(`package-smoke OK: ${pkg.name} -> ${tarball}`);
