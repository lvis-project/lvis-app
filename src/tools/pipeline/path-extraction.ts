/**
 * Tool pipeline — filesystem target-path extraction + shell path policy.
 *
 * Pure helpers factored out of `executor.ts` (C7 decomposition). No executor
 * state is touched; every function is a free transformation over the tool
 * descriptor + finalized input.
 */
import { resolve as pathResolve } from "node:path";
import { resolveToolPathForPermission } from "../../shared/tool-path-resolution.js";
import type { Tool } from "../base.js";
import { getDottedFieldValue } from "../../shared/dotted-field-value.js";
import { extractShellCommands } from "../../shared/shell-command-fields.js";
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

/**
 * Run the shell path policy over EVERY command-bearing argument of the call.
 *
 * Scanning only `finalInput.command` left the other command fields
 * (`cmd`/`script`/`shellCommand`) unexamined — the same asymmetry that let a
 * second field carry the real payload past classification. The policy is a
 * containment control, so it has to see every string that will be executed.
 */
export function shellPathPolicyViolation(
  finalInput: Record<string, unknown>,
  sandboxRoot: string,
  allowedDirectories: readonly string[],
): ShellPathPolicyViolation | null {
  const commands = extractShellCommands(finalInput);
  if (commands.length === 0) {
    return { kind: "invalid-path", reason: "Shell path policy: missing command string" };
  }
  const cwdValue = finalInput.cwd;
  if (cwdValue !== undefined && typeof cwdValue !== "string") {
    return { kind: "invalid-path", reason: "Shell path policy: cwd must be a string when provided" };
  }
  const resolvedCwd = cwdValue
    ? pathResolve(sandboxRoot, cwdValue)
    : sandboxRoot;
  for (const command of commands) {
    const violation = findShellPathPolicyViolation(
      command,
      resolvedCwd,
      sandboxRoot,
      allowedDirectories,
    );
    if (violation) return violation;
  }
  return null;
}
