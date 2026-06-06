/**
 * Permission policy — Layer 6 hook system: declarative `hooks.json` parser.
 *
 * Spec ref: docs/architecture/hook-runtime-expansion-design.md §4 (command-hooks
 * milestone) + issue #811. This is the PURE, INERT foundation: it parses an
 * already-deserialized `hooks.json` value into normalized config entries. It does
 * NO I/O (no fs, no spawn), and nothing in the boot / runner / trust pipeline
 * imports it yet — wiring lands in a separate cluster-reviewed PR.
 *
 * What it implements (the decisions already made for #811 m1, do not re-litigate):
 *
 *   (a) MATCHER ENGINE = GLOB. We deliberately diverge from the regex sketch in
 *       design §4.2 and reuse the existing `hookMatchesTool(matcher, toolName)`
 *       glob from `hook-discovery.ts` for consistency with `.sh`
 *       `# lvis-hook-matcher:` frontmatter and for ReDoS safety. We only validate
 *       that `matcher` is a string here; the registry does the matching.
 *
 *   (b) EVENT KEYS = CLOSED SET. `PreToolUse → "pre"`, `PostToolUse → "post"`,
 *       `PermissionRequest → "perm"`. An unknown event key is IGNORED with a
 *       returned warning (never silently active — design §4.2 / §5 fail-closed).
 *
 *   (c) HANDLER must be `type: "command"` with a string or argv command. We
 *       classify the command as a local-script (argv[0] resolves to a file path)
 *       vs a PATH-binary (a bare program name). A binary-only command — a
 *       PATH-binary with NO local script argument — has no stable hash anchor for
 *       the lockfile trust model, so it is REJECTED at parse with a clear error
 *       (design §6.1: "not permitted in the command-hooks milestone").
 *
 *   (d) Per-entry `timeoutMs` is clamped to `DEFAULT_HOOK_TIMEOUT_MS`
 *       (`script-hook-types.ts`). Hooks stay on their own budget, independent of
 *       `TOOL_TIMEOUT_POLICY`.
 *
 * Output contract: `parseHookConfig` never throws. It returns `{ entries,
 * warnings, errors }` so the (future) caller can surface non-fatal problems
 * (unknown events, ignored shapes) and fatal per-entry rejections (binary-only
 * commands, bad handler types) without aborting boot.
 */
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  type ScriptHookType,
} from "./script-hook-types.js";

/**
 * A normalized declarative hook entry parsed from `hooks.json`. This is the
 * config-origin half of the unified registry (`hook-registry.ts`); legacy `.sh`
 * files normalize into the same downstream shape there.
 */
export interface HookConfigEntry {
  /** Stable identity for trust-review / audit — `<event>#<index>` within the config. */
  id: string;
  /** Closed-set internal event (mapped from the `hooks.json` event key). */
  event: ScriptHookType;
  /**
   * Optional glob matcher over the tool name (decision (a)). Absent ⇒ matches
   * every tool. Matched later via `hookMatchesTool` in the registry.
   */
  matcher?: string;
  /** argv form of the command (always ≥1 element; argv[0] is the program). */
  command: string[];
  /** Per-entry timeout, clamped to `DEFAULT_HOOK_TIMEOUT_MS` (decision (d)). */
  timeoutMs: number;
  /** Origin discriminant — distinguishes config entries from `.sh` entries. */
  source: "config";
}

export interface ParsedHookConfig {
  entries: HookConfigEntry[];
  /** Non-fatal: shapes we ignored (unknown event, malformed sub-entry, …). */
  warnings: string[];
  /** Fatal per-entry rejections (binary-only command, bad handler type, …). */
  errors: string[];
}

/**
 * Closed-set mapping from `hooks.json` event keys to internal `ScriptHookType`.
 * Decision (b): anything not in this map is ignored + warned.
 */
const EVENT_KEY_TO_TYPE: Readonly<Record<string, ScriptHookType>> = {
  PreToolUse: "pre",
  PostToolUse: "post",
  PermissionRequest: "perm",
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Normalize a command field into an argv array. Accepts either a pre-split argv
 * (`string[]`) or a single string that we whitespace-split. Returns null when the
 * shape is unusable (not a string / array, empty, or contains non-string items).
 *
 * NOTE: this is a deliberately simple split — it does NOT honor shell quoting.
 * The trust model resolves argv[0]/script args as literal paths, so a hook author
 * who needs spaces in a path must use the argv (array) form. Documented here so a
 * future reader doesn't "fix" it into a shell parser (which would reintroduce
 * shell-injection surface the env allowlist + no-shell runner exist to avoid).
 */
function normalizeCommand(raw: unknown): string[] | null {
  let argv: string[];
  if (typeof raw === "string") {
    argv = raw.trim().split(/\s+/).filter((s) => s.length > 0);
  } else if (Array.isArray(raw)) {
    if (!raw.every((s) => typeof s === "string")) return null;
    argv = (raw as string[]).map((s) => s.trim()).filter((s) => s.length > 0);
  } else {
    return null;
  }
  return argv.length > 0 ? argv : null;
}

/**
 * Does this token look like a resolvable local file path (vs a bare PATH program
 * name)? Pure heuristic — NO fs access (this module is I/O-free by contract):
 *
 *   - contains a path separator (`/` or `\`)            → path
 *   - starts with `~` (home-relative)                   → path
 *   - starts with `.` (`./x`, `../x`, or a dotfile)     → path
 *
 * A bare token like `python3`, `node`, `curl` is a PATH-binary. The real sha256
 * resolution happens later in the (separately reviewed) trust wiring; here we
 * only need the local-vs-binary classification for decision (c)'s rejection.
 *
 * A URL (`https://host/path`) is NOT a local script even though it contains `/` —
 * `curl https://x/y` must stay "binary-only" and be rejected. We exclude any
 * token carrying a `scheme://` so a remote target can't masquerade as a local
 * hash anchor.
 */
export function looksLikeLocalScriptPath(token: string): boolean {
  if (token.length === 0) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return false; // URL → not a local path
  if (token.includes("/") || token.includes("\\")) return true;
  if (token.startsWith("~")) return true;
  if (token.startsWith(".")) return true;
  return false;
}

/**
 * Classify a command argv for the trust model (decision (c)):
 *   - "local-script": argv[0] itself resolves to a local file path. Anchorable.
 *   - "script-arg": argv[0] is a PATH-binary but a later arg references a local
 *      script (e.g. `python3 ~/.config/lvis/hooks/policy.py`). Anchorable on the
 *      script's sha256.
 *   - "binary-only": a PATH-binary with no local script argument (e.g.
 *      `curl https://x`). NOT anchorable — rejected.
 */
export type CommandClass = "local-script" | "script-arg" | "binary-only";

export function classifyCommand(argv: string[]): CommandClass {
  if (looksLikeLocalScriptPath(argv[0])) return "local-script";
  if (argv.slice(1).some(looksLikeLocalScriptPath)) return "script-arg";
  return "binary-only";
}

/**
 * Parse a deserialized `hooks.json` value into normalized config entries.
 *
 * Pure: takes already-parsed JSON (NOT a path / file contents), does no I/O, and
 * never throws. Missing / empty / malformed-at-the-top config yields empty
 * entries (with a warning for the malformed case) so a broken config can never
 * silently flip behavior.
 */
export function parseHookConfig(raw: unknown): ParsedHookConfig {
  const entries: HookConfigEntry[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  // Missing / empty config → empty entries, byte-identical to "no hooks.json".
  if (raw === undefined || raw === null) {
    return { entries, warnings, errors };
  }
  if (!isPlainObject(raw)) {
    warnings.push("hooks.json: top-level value is not an object — ignored");
    return { entries, warnings, errors };
  }

  const hooksByEvent = raw.hooks;
  if (hooksByEvent === undefined) {
    // `{ version: 1 }` with no hooks is a valid empty config.
    return { entries, warnings, errors };
  }
  if (!isPlainObject(hooksByEvent)) {
    warnings.push('hooks.json: "hooks" is not an object — ignored');
    return { entries, warnings, errors };
  }

  for (const [eventKey, group] of Object.entries(hooksByEvent)) {
    const event = EVENT_KEY_TO_TYPE[eventKey];
    if (!event) {
      // Decision (b): unknown event → ignored + warned, never silently active.
      warnings.push(`hooks.json: unknown event "${eventKey}" — entry ignored`);
      continue;
    }
    if (!Array.isArray(group)) {
      warnings.push(`hooks.json: event "${eventKey}" value is not an array — ignored`);
      continue;
    }

    group.forEach((matcherBlock, blockIdx) => {
      if (!isPlainObject(matcherBlock)) {
        warnings.push(
          `hooks.json: ${eventKey}[${blockIdx}] is not an object — ignored`,
        );
        return;
      }

      // matcher is optional; when present it must be a string (decision (a) —
      // validated as a glob string, matched later via hookMatchesTool).
      let matcher: string | undefined;
      if (matcherBlock.matcher !== undefined) {
        if (typeof matcherBlock.matcher !== "string") {
          warnings.push(
            `hooks.json: ${eventKey}[${blockIdx}].matcher is not a string — matcher ignored`,
          );
        } else {
          const trimmed = matcherBlock.matcher.trim();
          // "*" and "" both mean "match all" → leave matcher undefined so the
          // registry's hookMatchesTool short-circuits to true.
          matcher = trimmed === "" || trimmed === "*" ? undefined : trimmed;
        }
      }

      const handlers = matcherBlock.hooks;
      if (!Array.isArray(handlers)) {
        warnings.push(
          `hooks.json: ${eventKey}[${blockIdx}].hooks is not an array — ignored`,
        );
        return;
      }

      handlers.forEach((handler, handlerIdx) => {
        const id = `${eventKey}#${blockIdx}.${handlerIdx}`;
        if (!isPlainObject(handler)) {
          errors.push(`hooks.json: ${id} handler is not an object — rejected`);
          return;
        }
        if (handler.type !== "command") {
          errors.push(
            `hooks.json: ${id} handler.type must be "command" (got ${JSON.stringify(
              handler.type,
            )}) — rejected`,
          );
          return;
        }

        const command = normalizeCommand(handler.command);
        if (!command) {
          errors.push(
            `hooks.json: ${id} handler.command must be a non-empty string or string[] — rejected`,
          );
          return;
        }

        // Decision (c): binary-only commands have no stable hash anchor for the
        // lockfile trust model — reject at parse with a clear error.
        if (classifyCommand(command) === "binary-only") {
          errors.push(
            `hooks.json: ${id} command "${command.join(
              " ",
            )}" is a PATH-binary with no local script argument — rejected (no stable hash anchor for the trust lockfile; design §6.1)`,
          );
          return;
        }

        // Decision (d): clamp timeoutMs to the hook ceiling.
        let timeoutMs = DEFAULT_HOOK_TIMEOUT_MS;
        if (handler.timeoutMs !== undefined) {
          if (typeof handler.timeoutMs !== "number" || !Number.isFinite(handler.timeoutMs)) {
            warnings.push(
              `hooks.json: ${id} handler.timeoutMs is not a finite number — defaulting to ${DEFAULT_HOOK_TIMEOUT_MS}ms`,
            );
          } else if (handler.timeoutMs <= 0) {
            warnings.push(
              `hooks.json: ${id} handler.timeoutMs must be > 0 — defaulting to ${DEFAULT_HOOK_TIMEOUT_MS}ms`,
            );
          } else {
            timeoutMs = Math.min(handler.timeoutMs, DEFAULT_HOOK_TIMEOUT_MS);
          }
        }

        entries.push({
          id,
          event,
          ...(matcher !== undefined ? { matcher } : {}),
          command,
          timeoutMs,
          source: "config",
        });
      });
    });
  }

  return { entries, warnings, errors };
}
