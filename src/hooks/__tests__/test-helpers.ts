import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DiscoveredHook } from "../hook-discovery.js";

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
