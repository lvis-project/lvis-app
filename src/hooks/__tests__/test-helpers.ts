import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DiscoveredHook } from "../hook-discovery.js";

/**
 * Whether `binary` answers `--version` on PATH. Hook fixtures shell out to a
 * real interpreter, so suites use this to `it.skipIf(!HAS_NODE)` in
 * environments without one (e.g. minimal CI images).
 *
 * The binary is the parameter because four suites probed for one — `node`,
 * `python3` — with the same try/execFileSync/catch body under four names.
 */
export function hasExecutable(binary: string): boolean {
  try {
    execFileSync(binary, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Serialize `obj` as pretty JSON to `configPath` (a `hooks.json` fixture). */
export function writeJsonConfig(configPath: string, obj: unknown): void {
  writeFileSync(configPath, JSON.stringify(obj, null, 2));
}

export function writeExecutableHook(
  hooksDir: string,
  name: string,
  body = "#!/bin/sh\necho '{}'\n",
): void {
  mkdirSync(hooksDir, { recursive: true });
  const path = join(hooksDir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o700);
}

export function fixtureHook(
  fixtureRoot: string,
  fileName: string,
  type: "pre" | "post" | "perm" = "pre",
): DiscoveredHook {
  return {
    path: resolve(fixtureRoot, fileName),
    fileName,
    hookType: type,
    sha256: "test",
    size: 0,
  };
}

export interface HookDirLayout {
  hooksDir: string;
  disabledDir: string;
  lockfilePath: string;
}

/** The on-disk layout the hook system expects under a scratch root. */
export function hookDirLayout(tmpDir: string): HookDirLayout {
  const hooksDir = join(tmpDir, "hooks");
  return {
    hooksDir,
    disabledDir: join(hooksDir, ".disabled"),
    lockfilePath: join(hooksDir, ".lockfile.json"),
  };
}

/** The repo's checked-in hook fixture tree, the root every hook suite spawns from. */
export const REPO_HOOK_FIXTURE_ROOT = resolve(__dirname, "..", "..", "..", "test", "fixtures", "hooks");

/** A {@link fixtureHook} rooted at the repo's checked-in `test/fixtures/hooks`. */
export function repoFixtureHook(
  fileName: string,
  type: "pre" | "post" | "perm" = "pre",
): DiscoveredHook {
  return fixtureHook(REPO_HOOK_FIXTURE_ROOT, fileName, type);
}
