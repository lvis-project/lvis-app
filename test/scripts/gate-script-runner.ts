import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Runs a build-gate script the way CI does — as a child `node` process — so a
 * test can assert on its exit code and its operator-facing output, not just on
 * an exported function's return value. The gates' contract with the build is
 * the exit code, and that is only observable from outside.
 *
 * Every gate under `scripts/check-*.mjs` takes the same `--root <dir>` escape
 * hatch so a test can point it at a fixture tree instead of the repo. That
 * makes the runner identical for all of them, which is why it lives here
 * rather than being written out once per gate test: two copies of it had
 * already started to differ in which cwd they passed.
 *
 * `LVIS_TEST_NODE_EXEC_PATH` lets the harness override the interpreter (the
 * suite runs under Electron, whose `process.execPath` is not a plain node).
 */
export function runGateScript(
  scriptPath: string,
  root: string,
  env?: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  const nodeCommand = process.env.LVIS_TEST_NODE_EXEC_PATH ?? process.execPath;
  return spawnSync(nodeCommand, [scriptPath, "--root", root], {
    cwd: process.cwd(),
    encoding: "utf-8",
    ...(env ? { env } : {}),
  });
}

/**
 * Write one file into a gate's fixture tree, creating the directories the
 * relative path implies.
 *
 * Every gate test builds its tree the same way — a handful of files at paths
 * the gate is hard-wired to look for — so the mkdir-then-write is the shared
 * part and the paths and contents are the test.
 */
export function writeFixtureFile(root: string, rel: string, contents: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf-8");
}
