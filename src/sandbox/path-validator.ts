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
  sep,
} from "node:path";
import { homedir } from "node:os";

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

  if (isWithin(resolved, resolvedCwd)) {
    return { allowed: true, reason: "" };
  }

  for (const allowed of extraAllowed) {
    const resolvedAllowed = canonicalize(expandTilde(allowed));
    if (isWithin(resolved, resolvedAllowed)) {
      return { allowed: true, reason: "" };
    }
  }

  return {
    allowed: false,
    reason: `path ${resolved} is outside the sandbox boundary (${resolvedCwd})`,
  };
}

function canonicalize(path: string): string {
  const absolute = pathResolve(expandTilde(path));
  if (existsSync(absolute)) {
    return realpathSync(absolute);
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

  const canonicalParent = realpathSync(cursor);
  return suffix.length > 0 ? join(canonicalParent, ...suffix) : canonicalParent;
}

function expandTilde(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return pathResolve(homedir(), path.slice(2));
  }
  return path;
}

function isWithin(child: string, parent: string): boolean {
  const normalizedChild = normalizeForBoundaryCompare(child);
  const normalizedParentBase = normalizeForBoundaryCompare(parent);
  const normalizedParent = normalizedParentBase.endsWith(sep)
    ? normalizedParentBase
    : normalizedParentBase + sep;
  return normalizedChild === normalizedParentBase || normalizedChild.startsWith(normalizedParent);
}

function normalizeForBoundaryCompare(path: string): string {
  return process.platform === "win32" || process.platform === "darwin"
    ? path.toLowerCase()
    : path;
}
