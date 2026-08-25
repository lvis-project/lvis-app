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

/**
 * The environment every `git` call here runs in, with the ambient one removed.
 *
 * These cases used to inherit `process.env` whole, and passed — until they ran
 * inside a `pre-push` hook, where git exports `GIT_DIR`, `GIT_WORK_TREE` and
 * `GIT_CONFIG_PARAMETERS` to what it invokes. `GIT_DIR` OUTRANKS `cwd`, so the
 * scratch repo's `git config --get` was answering out of the REAL repository,
 * and the first case's "no ssh command is set yet" premise was reading someone
 * else's setting.
 *
 * That is worth fixing rather than routing around, because it made the suite
 * pass in the one place it did not matter — a plain `bun run test` — and fail
 * in the one place these cases are actually about: a push.
 *
 * `HOME`/`GIT_CONFIG_GLOBAL` are redirected as well, so a developer's own
 * `core.sshCommand` in `~/.gitconfig` cannot decide the answer either.
 */
function isolatedGitEnv(home: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "GIT_DIR" || key === "GIT_WORK_TREE" || key.startsWith("GIT_CONFIG")) {
      delete env[key];
    }
  }
  env.HOME = home;
  env.GIT_CONFIG_GLOBAL = join(home, "gitconfig-that-does-not-exist");
  env.GIT_CONFIG_SYSTEM = join(home, "gitconfig-system-that-does-not-exist");
  return env;
}

function git(args: string[], cwd: string, home: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", env: isolatedGitEnv(home) });
  return (result.stdout || "").trim();
}

describe("hooks installer — push keepalive", () => {
  let repo: string;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lvis-hooks-home-"));
    repo = mkdtempSync(join(tmpdir(), "lvis-hooks-install-"));
    git(["init", "--quiet"], repo, home);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function runInstaller(cwd: string) {
    // The installer resolves the repo from its OWN location, so point it at the
    // scratch repo by running it with that repo as the working directory and a
    // copied script path is unnecessary — it reads `git rev-parse` from cwd.
    return spawnSync(process.execPath, [INSTALLER], {
      cwd,
      encoding: "utf-8",
      env: { ...isolatedGitEnv(home), GIT_DIR: join(cwd, ".git"), GIT_WORK_TREE: cwd },
    });
  }

  it("sets a keepalive ssh command when the user has not chosen one", () => {
    expect(git(["config", "--get", "core.sshCommand"], repo, home)).toBe("");

    runInstaller(repo);

    const configured = git(["config", "--get", "core.sshCommand"], repo, home);
    expect(configured).toContain("ServerAliveInterval");
    expect(configured).toContain("ServerAliveCountMax");
  });

  it("does not overwrite an ssh command the user already set", () => {
    const chosen = "ssh -i ~/.ssh/company_key";
    git(["config", "core.sshCommand", chosen], repo, home);

    runInstaller(repo);

    expect(git(["config", "--get", "core.sshCommand"], repo, home)).toBe(chosen);
  });
});
