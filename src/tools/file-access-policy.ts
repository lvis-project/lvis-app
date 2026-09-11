import { pathEffectIsConfined, type PathEffect } from "../permissions/allowed-directories.js";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
  isSensitivePath,
} from "../permissions/sensitive-paths.js";
import { validateSandboxPath } from "../sandbox/path-validator.js";
import type { ToolExecutionContext, ToolExecutionResult } from "./types.js";

export function sensitiveFilePattern(path: string): string | null {
  return isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(path)));
}

/** Execute-time sensitive and directory gates shared by native file operations. */
export function ensureFileAccess(
  path: string,
  context: ToolExecutionContext,
  effect: PathEffect,
): ToolExecutionResult | null {
  const sensitive = sensitiveFilePattern(path);
  if (sensitive) {
    return { output: `Sensitive path: ${path} matches ${sensitive}`, isError: true };
  }
  if (!pathEffectIsConfined(effect, context.blockReadsOutsideWorkingDirectories === true)) {
    return null;
  }
  const check = validateSandboxPath(path, context.cwd, [...context.extraAllowedDirectories]);
  if (!check.allowed) {
    return { output: `Sandbox: ${check.reason}`, isError: true };
  }
  return null;
}
