/**
 * Portions adapted from OpenHarness (MIT License)
 * https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/sandbox/path_validator.py
 * Copyright (c) 2025 OpenHarness Contributors
 *
 * SandboxPathValidator (Tier A3) — symlink-safe path boundary check.
 *
 * Every file tool that touches disk should call {@link validateSandboxPath}
 * before any read/write. The validator:
 *   1. Expands `~` to the user's home directory.
 *   2. Resolves the path to an absolute form.
 *   3. If the path exists, follows symlinks via `realpathSync` so that
 *      symlink traversal attempts cannot escape the boundary.
 *   4. Checks whether the canonicalized path is contained within the
 *      sandbox cwd or any entry in `extraAllowed`.
 *
 * Uses Node stdlib only (`node:fs`, `node:path`, `node:os`) — zero
 * external dependencies.
 */
import { existsSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  join,
  resolve as pathResolve,
} from "node:path";
import { isPathWithin } from "../plugins/plugin-storage-containment.js";
import { expandLeadingTilde } from "../shared/home-tilde.js";

export interface SandboxValidationResult {
  allowed: boolean;
  reason: string;
}

/**
 * Validates that `path` is within `cwd` or one of the `extraAllowed` roots.
 *
 * Returns `{ allowed: true, reason: "" }` on success, or
 * `{ allowed: false, reason: <explanation> }` on failure.
 *
 * Non-existent paths are validated through the nearest existing parent
 * so future-create paths still inherit symlink boundary checks.
 */
export function validateSandboxPath(
  path: string,
  cwd: string,
  extraAllowed: string[] = [],
): SandboxValidationResult {
  const resolved = canonicalize(path);
  const resolvedCwd = canonicalize(cwd);

  if (isWithin(resolvedCwd, resolved)) {
    return { allowed: true, reason: "" };
  }

  for (const allowed of extraAllowed) {
    const resolvedAllowed = canonicalize(expandLeadingTilde(allowed));
    if (isWithin(resolvedAllowed, resolved)) {
      return { allowed: true, reason: "" };
    }
  }

  return {
    allowed: false,
    reason: `path ${resolved} is outside the sandbox boundary (${resolvedCwd})`,
  };
}

function canonicalize(path: string): string {
  const absolute = pathResolve(expandLeadingTilde(path));
  if (existsSync(absolute)) {
    return realpathSync.native(absolute);
  }

  const suffix: string[] = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      return absolute;
    }
    suffix.unshift(basename(cursor));
    cursor = parent;
  }

  const canonicalParent = realpathSync.native(cursor);
  return suffix.length > 0 ? join(canonicalParent, ...suffix) : canonicalParent;
}

/**
 * `(parent, child)` — the argument order every other containment predicate in
 * this tree uses. It read `(child, parent)` until the two orders were noticed
 * side by side; a reader who copies the wrong one inverts a sandbox boundary
 * without the types objecting, since both arguments are `string`.
 *
 * The containment question itself is {@link isPathWithin}. What stays here is
 * the case policy, which is this layer's and not the storage layer's: macOS and
 * Windows are case-insensitive by default, so a tool asking for `/Users/ken/PROJ`
 * inside a sandbox rooted at `/Users/ken/proj` is asking for a path the
 * filesystem will hand it either way. {@link canonicalize} has usually already
 * settled the casing via `realpathSync.native`; this covers the paths that do
 * not exist yet and so cannot be canonicalised.
 */
function isWithin(parent: string, child: string): boolean {
  return isPathWithin(normalizeForBoundaryCompare(parent), normalizeForBoundaryCompare(child));
}

function normalizeForBoundaryCompare(path: string): string {
  return process.platform === "win32" || process.platform === "darwin"
    ? path.toLowerCase()
    : path;
}
