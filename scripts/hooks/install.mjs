#!/usr/bin/env node
// Installs lvis-app's own git hooks by pointing core.hooksPath at the tracked
// scripts/hooks directory, whose pre-commit / pre-push shims call
// run-local-checks.mjs.
//
// App-owned: a fresh clone gets the pre-push gate from `bun install` alone — no
// external dev-tools checkout required. Idempotent and fail-safe: it never fails
// the install lifecycle it is wired into (postinstall), and no-ops outside a git
// checkout (tarball / CI-artifact installs).

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = "scripts/hooks";

function git(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || "").trim();
}

function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..", "..");

  // A successful rev-parse is the real "inside a git checkout" signal (works for
  // both normal clones and worktrees, whose .git is a file).
  if (git(["rev-parse", "--show-toplevel"], repoRoot) === null) return;

  const current = git(["config", "--get", "core.hooksPath"], repoRoot);
  if (current !== HOOKS_DIR) {
    if (git(["config", "core.hooksPath", HOOKS_DIR], repoRoot) === null) {
      console.warn("[hooks] could not set core.hooksPath; pre-push checks not installed");
      return;
    }
    console.log(`[hooks] core.hooksPath -> ${HOOKS_DIR} (app-owned pre-commit/pre-push)`);
  }

  // Git preserves the executable bit in-tree; re-assert it best-effort so a
  // fresh checkout on a fileMode-off setup still runs the shims. No-op on Windows.
  for (const name of ["pre-commit", "pre-push"]) {
    const shim = join(repoRoot, HOOKS_DIR, name);
    try {
      if (existsSync(shim)) chmodSync(shim, 0o755);
    } catch {
      // best-effort only
    }
  }
}

try {
  main();
} catch (error) {
  console.warn(
    `[hooks] install skipped: ${error instanceof Error ? error.message : String(error)}`
  );
}
