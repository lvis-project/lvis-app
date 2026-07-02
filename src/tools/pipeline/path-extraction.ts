/**
 * Tool pipeline — filesystem target-path extraction + shell path policy.
 *
 * Pure helpers factored out of `executor.ts` (C7 decomposition). No executor
 * state is touched; every function is a free transformation over the tool
 * descriptor + finalized input.
 */
import { homedir } from "node:os";
import { resolve as pathResolve } from "node:path";
import type { Tool } from "../base.js";
import {
  findShellPathPolicyViolation,
  type ShellPathPolicyViolation,
} from "../shell-path-policy.js";

/**
 * Extract absolute filesystem target paths from a tool's declared
 * `pathFields` contract. Used so {@link ApprovalGate}'s
 * §S1 sensitive-path hard-block can actually run against the path the
 * tool is about to touch. Returns an empty list when a tool declares no
 * path fields; built-in shell tools enforce command operands inside their
 * own native execution surface.
 */
export function extractTargetFilePaths(
  tool: Tool,
  input: unknown,
  cwd: string,
): string[] {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const fields = new Set<string>(tool.pathFields ?? []);
  const paths: string[] = [];
  for (const field of fields) {
    const candidate = getDottedFieldValue(obj, field);
    const values = Array.isArray(candidate) ? candidate : [candidate];
    for (const value of values) {
      if (typeof value !== "string" || value.length === 0) continue;
      try {
        paths.push(resolveToolPathForPermission(value, cwd));
      } catch {
        // Tool schema validation owns argument-type failures.
      }
    }
  }
  return [...new Set(paths)];
}

function getDottedFieldValue(input: Record<string, unknown>, field: string): unknown {
  let current: unknown = input;
  for (const segment of field.split(".")) {
    if (segment.length === 0) return undefined;
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function resolveToolPathForPermission(value: string, cwd: string): string {
  const expanded = value === "~"
    ? homedir()
    : value.startsWith("~/") || value.startsWith("~\\")
      ? pathResolve(homedir(), value.slice(2))
      : value;
  return pathResolve(pathResolve(cwd), expanded);
}

export function shellPathPolicyViolation(
  finalInput: Record<string, unknown>,
  sandboxRoot: string,
  allowedDirectories: readonly string[],
): ShellPathPolicyViolation | null {
  const command = finalInput.command;
  if (typeof command !== "string" || command.length === 0) {
    return { kind: "invalid-path", reason: "Shell path policy: missing command string" };
  }
  const cwdValue = finalInput.cwd;
  if (cwdValue !== undefined && typeof cwdValue !== "string") {
    return { kind: "invalid-path", reason: "Shell path policy: cwd must be a string when provided" };
  }
  const resolvedCwd = cwdValue
    ? pathResolve(sandboxRoot, cwdValue)
    : sandboxRoot;
  return findShellPathPolicyViolation(
    command,
    resolvedCwd,
    sandboxRoot,
    allowedDirectories,
  );
}
