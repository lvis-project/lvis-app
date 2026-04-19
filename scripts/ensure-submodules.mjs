#!/usr/bin/env node
/**
 * Guard: ensure git submodules (e.g. packages/plugin-sdk) are populated.
 *
 * Fresh `git clone` without `--recurse-submodules` leaves submodule directories
 * empty, which breaks `bun install` and TypeScript resolution of
 * `@lvis/plugin-sdk` (TS2307). This script auto-initializes submodules when it
 * detects an empty submodule path, so `bun install` works from a plain clone.
 *
 * Safe to run multiple times: no-ops when submodules are already populated or
 * when the working tree is not a git checkout (e.g. published tarball).
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const gitMarker = join(repoRoot, ".git");
if (!existsSync(gitMarker)) {
  // Not a git checkout (e.g. installed as tarball) — nothing to do.
  process.exit(0);
}

const gitmodules = join(repoRoot, ".gitmodules");
if (!existsSync(gitmodules)) {
  process.exit(0);
}

// Minimal parse: list submodule paths.
const content = readFileSync(gitmodules, "utf8");
const paths = [...content.matchAll(/^\s*path\s*=\s*(.+)$/gm)].map((m) =>
  m[1].trim(),
);

const empty = paths.filter((p) => {
  const full = join(repoRoot, p);
  try {
    if (!existsSync(full)) return true;
    const entries = readdirSync(full);
    return entries.length === 0;
  } catch {
    return true;
  }
});

if (empty.length === 0) {
  process.exit(0);
}

console.log(
  `[ensure-submodules] empty submodules detected: ${empty.join(", ")}`,
);
console.log("[ensure-submodules] running: git submodule update --init --recursive");
try {
  execSync("git submodule update --init --recursive", {
    cwd: repoRoot,
    stdio: "inherit",
  });
} catch (err) {
  console.error(
    "[ensure-submodules] failed to initialize submodules. Please run manually:\n" +
      "  git submodule update --init --recursive",
  );
  process.exit(1);
}
