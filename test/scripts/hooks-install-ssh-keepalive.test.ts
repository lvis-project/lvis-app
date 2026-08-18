/**
 * `scripts/hooks/install.mjs` — push-transport keepalive.
 *
 * `git push` opens the transport before running pre-push and writes the pack
 * after it, so a multi-minute pre-push build leaves the connection idle long
 * enough for the server to drop it. Git then dies with SIGPIPE and `git push`
 * exits 141 — which reads as a rejected push even though every check passed,
 * and sends people to `--no-verify` for what is really a transport timeout.
 *
 * These tests pin the two behaviours that matter: the installer sets a
 * keepalive ssh command, and it never overwrites one the user chose.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const INSTALLER = resolve(
  fileURLToPath(new URL("../../scripts/hooks/install.mjs", import.meta.url)),
);

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return (result.stdout || "").trim();
}

describe("hooks installer — push keepalive", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "lvis-hooks-install-"));
    git(["init", "--quiet"], repo);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function runInstaller(cwd: string) {
    // The installer resolves the repo from its OWN location, so point it at the
    // scratch repo by running it with that repo as the working directory and a
    // copied script path is unnecessary — it reads `git rev-parse` from cwd.
    return spawnSync(process.execPath, [INSTALLER], {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, GIT_DIR: join(cwd, ".git"), GIT_WORK_TREE: cwd },
    });
  }

  it("sets a keepalive ssh command when the user has not chosen one", () => {
    expect(git(["config", "--get", "core.sshCommand"], repo)).toBe("");

    runInstaller(repo);

    const configured = git(["config", "--get", "core.sshCommand"], repo);
    expect(configured).toContain("ServerAliveInterval");
    expect(configured).toContain("ServerAliveCountMax");
  });

  it("does not overwrite an ssh command the user already set", () => {
    const chosen = "ssh -i ~/.ssh/company_key";
    git(["config", "core.sshCommand", chosen], repo);

    runInstaller(repo);

    expect(git(["config", "--get", "core.sshCommand"], repo)).toBe(chosen);
  });
});
