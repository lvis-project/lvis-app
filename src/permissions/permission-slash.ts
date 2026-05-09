/**
 * Q12 Phase 2.5 — `/permission dir <verb> <args>` slash handler stub.
 *
 * Spec ref: docs/architecture/q12-permission-policy-design.md §3 Layer 1
 * (slash commands), §11 v2.1 binding decisions.
 *
 * Phase 2.5 is the parsing + persistence skeleton. Phase 5 will fully
 * wire the slash dispatcher, autocomplete UI, and toast feedback. This
 * module returns structured results so the eventual UI layer can render
 * them without re-parsing.
 *
 * Trust origin gate (spec C2 fix): callers MUST verify
 * `trustOrigin === "user"` before invoking. This module does NOT enforce
 * trust origin internally — it would be plausibly mistaken for the
 * authoritative gate. Callers up-stack (the slash dispatcher) own the
 * trust check.
 */
import {
  validateDirectoryAddition,
  buildAllowedScope,
} from "./allowed-directories.js";
import {
  addAllowedDirectoryPersist,
  removeAllowedDirectoryPersist,
  readPermissionSettings,
} from "./permission-settings-store.js";

export type PermissionDirVerb = "allow" | "deny" | "list";

export interface PermissionDirCommand {
  verb: PermissionDirVerb;
  /** Path argument for allow/deny. Empty string for `list`. */
  path: string;
  /** `--session` flag for in-memory-only allow (allow-once). */
  session: boolean;
}

export type PermissionDirResult =
  | { ok: true; verb: "allow"; persisted: string[]; sessionOnly: boolean; warnings: string[] }
  | { ok: true; verb: "deny"; persisted: string[] }
  | { ok: true; verb: "list"; defaults: string[]; userAdditions: string[]; effective: string[] }
  | { ok: false; error: string };

/**
 * Parse a `/permission dir ...` invocation. Accepts the full subcommand
 * string AFTER `/permission dir` (so the dispatcher can hand off the
 * remainder).
 *
 * Examples:
 *   "allow ~/Documents/old-project"
 *   "allow ~/foo --session"
 *   "deny /tmp/staging"
 *   "list"
 */
export function parsePermissionDirCommand(
  rawArgs: string,
): PermissionDirCommand | { ok: false; error: string } {
  const args = rawArgs.trim().split(/\s+/).filter((p) => p.length > 0);
  if (args.length === 0) {
    return { ok: false, error: "missing subcommand — usage: /permission dir <allow|deny|list> [path] [--session]" };
  }
  const verb = args[0] as PermissionDirVerb;
  if (verb !== "allow" && verb !== "deny" && verb !== "list") {
    return { ok: false, error: `unknown subcommand '${verb}' — expected allow|deny|list` };
  }
  if (verb === "list") {
    if (args.length > 1) {
      return { ok: false, error: "list takes no extra arguments" };
    }
    return { verb, path: "", session: false };
  }
  const session = args.includes("--session");
  const remaining = args.slice(1).filter((a) => a !== "--session");
  if (remaining.length === 0) {
    return { ok: false, error: `${verb} requires a path argument` };
  }
  if (remaining.length > 1) {
    return { ok: false, error: `${verb} takes a single path (got ${remaining.length})` };
  }
  if (verb === "deny" && session) {
    return { ok: false, error: "--session is not valid for deny" };
  }
  return { verb, path: remaining[0], session };
}

/**
 * Dispatch a parsed command. Side effects:
 *   - `allow` (no --session) → persist to ~/.lvis/settings.json.
 *   - `allow --session` → no persist; caller is expected to merge into
 *     the live in-memory `additionalDirectories` (Phase 5 will fully
 *     wire that channel — for Phase 2.5 we just return ok+sessionOnly).
 *   - `deny` → remove from ~/.lvis/settings.json (settings-level).
 *     Layer 0 sensitive-paths is the actual hard-deny — `deny` here is
 *     just removing from the user's own list.
 *   - `list` → read current state.
 *
 * `pathOverride` is for tests (settings file location).
 */
export async function dispatchPermissionDirCommand(
  cmd: PermissionDirCommand,
  pathOverride?: string,
): Promise<PermissionDirResult> {
  if (cmd.verb === "list") {
    const current = readPermissionSettings(pathOverride);
    const userAdditions = current.permissions.additionalDirectories;
    const effective = buildAllowedScope(userAdditions).directories;
    // The defaults are the entries in `effective` that are NOT in
    // `userAdditions` after sanitize. Surfacing both helps the UI
    // distinguish provenance.
    const defaults = effective.filter((d) => !userAdditions.includes(d));
    return { ok: true, verb: "list", defaults, userAdditions, effective };
  }
  if (cmd.verb === "allow") {
    const validation = validateDirectoryAddition(cmd.path);
    if (!validation.ok) return { ok: false, error: validation.reason };
    if (cmd.session) {
      // Phase 5 will plumb this into the in-memory scope. For now we
      // surface a structured response so the dispatcher can update the
      // live executor context.
      return {
        ok: true,
        verb: "allow",
        persisted: [],
        sessionOnly: true,
        warnings: validation.adjacencyWarnings,
      };
    }
    const next = await addAllowedDirectoryPersist(cmd.path, pathOverride);
    return {
      ok: true,
      verb: "allow",
      persisted: next,
      sessionOnly: false,
      warnings: validation.adjacencyWarnings,
    };
  }
  // deny
  const next = await removeAllowedDirectoryPersist(cmd.path, pathOverride);
  return { ok: true, verb: "deny", persisted: next };
}
