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
// 20s pings, 30 missed before giving up — ~10 minutes of idle tolerance, which
// covers a full pre-push build with room to spare.
const SSH_KEEPALIVE_COMMAND = "ssh -o ServerAliveInterval=20 -o ServerAliveCountMax=30";

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

  // Keep the push connection alive across a long pre-push run.
  //
  // `git push` opens the transport FIRST (to learn the remote refs), then runs
  // pre-push with that connection idle, and only writes the pack afterwards.
  // Our pre-push runs a full build, so the connection can sit idle for minutes
  // and the server drops it; git then dies writing the pack with SIGPIPE and
  // `git push` exits 141. That reads like a rejected push but no check failed —
  // the hook prints every check OK first — which sends people to `--no-verify`
  // for what is really a transport timeout.
  //
  // Set only when the user has not chosen their own ssh command, and note that
  // the `GIT_SSH_COMMAND` env var still takes precedence over this config, so
  // an override at push time keeps working.
  if (git(["config", "--get", "core.sshCommand"], repoRoot) === null) {
    if (git(["config", "core.sshCommand", SSH_KEEPALIVE_COMMAND], repoRoot) !== null) {
      console.log(`[hooks] core.sshCommand -> ${SSH_KEEPALIVE_COMMAND} (keeps push alive across the pre-push build)`);
    }
    // A failure here is not fatal: the hooks are installed either way, and the
    // only cost is that a very long pre-push may still time the connection out.
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
