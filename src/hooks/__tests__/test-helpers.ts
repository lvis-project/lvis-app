import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DiscoveredHook } from "../hook-discovery.js";

/**
 * Whether a `node` binary is on PATH. Lifecycle hook fixtures shell out to
 * `node`, so suites use this to `it.skipIf(!HAS_NODE)` in environments without
 * it (e.g. minimal CI images).
 */
export function hasNode(): boolean {
  try {
    execFileSync("node", ["--version"], { stdio: "ignore" });
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
