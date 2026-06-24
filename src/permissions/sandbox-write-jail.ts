/**
 * Derive the OS sandbox write-jail for a shell/tool spawn.
 *
 * The ASRT OS sandbox (Linux bwrap `--bind`, macOS Seatbelt `file-write*`)
 * confines writes to an explicit allow-list. This module computes that
 * allow-list from the SAME signals the permission reviewer uses, so the
 * kernel-enforced write boundary matches the §Storage-namespace rule
 * (`~/.lvis/plugins/<id>/`) rather than the shell's bare working directory.
 *
 * The earlier derivation hard-coded the jail to the resolved cwd. That is
 * wrong for two reasons:
 *   - a plugin-owned tool's writable region is its sandbox root
 *     (`~/.lvis/plugins/<pluginId>/`), not the chat session cwd; and
 *   - a user who authorized extra directories expects writes there to work.
 *
 * The write set is therefore the canonicalized union of:
 *   - `ownerPluginSandboxRoot` when the invoking tool is plugin-owned
 *     (undefined for builtins / no-plugin shell), and
 *   - the in-scope `allowedDirectories` (cwd ∪ user-authorized extras).
 *
 * Reads are governed separately (the runner still grants cwd + system read
 * paths); this module only computes the WRITE jail.
 */
import { canonicalizePathForMatch } from "./sensitive-paths.js";

/** Inputs for {@link deriveSandboxWritePaths}. Pure data — no I/O of its own. */
export interface SandboxWriteJailInput {
  /**
   * Owner plugin sandbox root (`~/.lvis/plugins/<pluginId>/`) when the
   * invoking tool is plugin-owned, else undefined. Builtins (bash/powershell
   * invoked directly) have no owner plugin and pass undefined.
   */
  ownerPluginSandboxRoot?: string;
  /**
   * In-scope authorized directories for this invocation: the session cwd
   * unioned with the user-authorized extra directories. These remain
   * writable so a user who granted a directory can still write to it.
   */
  allowedDirectories: readonly string[];
}

/**
 * Compute the canonicalized, de-duplicated set of filesystem paths the
 * sandbox may grant write access to for this invocation.
 *
 * Canonicalization uses {@link canonicalizePathForMatch} (the same
 * normalization the reviewer's sensitive-path layer uses) so the OS jail and
 * the reviewer judgement see bit-identical path strings. That helper performs
 * a bounded synchronous `realpath` walk-up (the only I/O here); the function
 * has no global state and does not spawn, so it stays testable in isolation.
 *
 * Builtins / no-plugin shell: `ownerPluginSandboxRoot` is undefined, so the
 * jail is exactly the allowed directories. A plugin-owned tool additionally
 * gains its own sandbox root.
 */
export function deriveSandboxWritePaths(input: SandboxWriteJailInput): string[] {
  const raw: string[] = [];
  if (input.ownerPluginSandboxRoot !== undefined && input.ownerPluginSandboxRoot !== "") {
    raw.push(input.ownerPluginSandboxRoot);
  }
  for (const dir of input.allowedDirectories) {
    if (dir !== "") raw.push(dir);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of raw) {
    const canonical = canonicalizePathForMatch(path);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}
