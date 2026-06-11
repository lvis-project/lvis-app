/**
 * Permission policy — Layer 6: `hooks.json` trust unit (#811 command-hooks).
 *
 * Spec ref: docs/architecture/hook-runtime-expansion-design.md §6.1 + §10
 * (open decision 1, recommendation adopted): **the whole `hooks.json` is a
 * single trust unit** — hashed as one file (mirroring a single `.sh`), with
 * each referenced local script's sha256 folded into the composite so that
 * editing a referenced script ALSO re-quarantines the config.
 *
 * This module is the bridge that lets `hooks.json` ride the SAME
 * `diffAgainstLockfile → quarantine-new/changed → /permission hooks accept`
 * flow as `.sh` files: it synthesizes a `DiscoveredHook` whose `fileName` is the
 * config trust-unit identity ({@link HOOKS_CONFIG_FILENAME}) and whose `sha256`
 * is the composite trust hash. Downstream trust code (`diffAgainstLockfile`,
 * `disableHook`, `persistLockfile`) treats it like any other hook — so an
 * untrusted or changed `hooks.json` is QUARANTINED (moved to `.disabled/`) and
 * its declarative command entries are NEVER loaded until the user explicitly
 * accepts it.
 *
 * SECURITY: this module is the trust gate. `wireHookSystem` must only feed the
 * parsed config entries into the runtime registry when this synthetic hook is
 * `trusted` — exactly the same gate `.sh` files pass through.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as pathResolve } from "node:path";
import { createLogger } from "../lib/logger.js";
import {
  classifyCommand,
  looksLikeLocalScriptPath,
  parseHookConfig,
  type HookConfigEntry,
} from "./hook-config.js";
import { defaultHooksDir, type DiscoveredHook } from "./hook-discovery.js";

const log = createLogger("hook-config-trust");

/**
 * The trust-unit identity for `hooks.json`. Carried as a synthetic
 * `DiscoveredHook.fileName` so the lockfile / diff / disable flow keys on it
 * identically to a `.sh` file. NOT a `.sh` name — `validateHookName` widens to
 * admit exactly this literal (and nothing else) for the config surface.
 */
export const HOOKS_CONFIG_FILENAME = "hooks.json";

/** Default `hooks.json` path inside the hooks directory. */
export function defaultHooksConfigPath(dir: string = defaultHooksDir()): string {
  return pathResolve(dir, HOOKS_CONFIG_FILENAME);
}

/** Expand a leading `~` / `~/` to the user's home directory (NO fs access). */
function expandHome(token: string): string {
  if (token === "~") return homedir();
  if (token.startsWith("~/") || token.startsWith("~\\")) {
    return homedir() + token.slice(1);
  }
  return token;
}

/**
 * Resolve the local-script token a `command` argv anchors its trust on, if any:
 *   - "local-script": argv[0] itself is the script.
 *   - "script-arg":   the first later arg that looks like a local script.
 * Returns the resolved absolute-ish path (with `~` expanded), or null for a
 * binary-only command (which `parseHookConfig` already rejects).
 */
export function resolveScriptAnchor(command: string[]): string | null {
  const cls = classifyCommand(command);
  if (cls === "binary-only") return null;
  const token =
    cls === "local-script"
      ? command[0]
      : command.slice(1).find(looksLikeLocalScriptPath);
  if (token === undefined) return null;
  return expandHome(token);
}

export interface LoadedHookConfig {
  /** Absolute path to `hooks.json`. */
  path: string;
  /** True when `hooks.json` exists on disk. */
  exists: boolean;
  /** Parsed + normalized config entries (empty when absent / unparsable). */
  entries: HookConfigEntry[];
  /** Non-fatal parser warnings (unknown events, ignored shapes). */
  warnings: string[];
  /** Fatal per-entry parser rejections (binary-only, bad handler type). */
  errors: string[];
  /**
   * Composite trust hash: sha256 over the raw `hooks.json` bytes plus each
   * referenced local script's sha256. null when `hooks.json` is absent.
   */
  trustHash: string | null;
}

/**
 * Load + parse `hooks.json` and compute its composite trust hash. Pure-ish:
 * reads `hooks.json` and any referenced local scripts to fold their sha256 in,
 * but never executes anything. Missing config → `{ exists:false, entries:[] }`
 * (byte-identical to "no hooks.json").
 */
export function loadHookConfig(
  configPath: string = defaultHooksConfigPath(),
): LoadedHookConfig {
  if (!existsSync(configPath)) {
    return { path: configPath, exists: false, entries: [], warnings: [], errors: [], trustHash: null };
  }

  let raw: Buffer;
  try {
    raw = readFileSync(configPath);
  } catch (err) {
    log.warn("hook-config-trust: read failed %s: %s", configPath, (err as Error).message);
    return { path: configPath, exists: false, entries: [], warnings: [], errors: [], trustHash: null };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw.toString("utf-8"));
  } catch (err) {
    // Unparsable JSON is NOT silently ignored: surface as a fatal error so the
    // caller can audit it. We still compute a trust hash over the bytes so a
    // broken-then-fixed config re-diffs, but entries stay empty (fail-closed).
    log.warn("hook-config-trust: JSON parse failed %s: %s", configPath, (err as Error).message);
    return {
      path: configPath,
      exists: true,
      entries: [],
      warnings: [],
      errors: [`hooks.json: not valid JSON — ${(err as Error).message}`],
      trustHash: hashBytesOnly(raw),
    };
  }

  const parsed = parseHookConfig(parsedJson);

  // Fold each referenced local script's sha256 into the trust hash so editing a
  // referenced script ALSO flips the config to `changed` (re-quarantine). A
  // referenced script that does not exist contributes a stable "missing" token
  // (so its later appearance re-diffs).
  const hasher = createHash("sha256");
  hasher.update(raw);
  const anchors = collectScriptAnchors(parsed.entries);
  for (const anchorPath of anchors) {
    hasher.update("\0");
    hasher.update(anchorPath);
    hasher.update("\0");
    try {
      hasher.update(readFileSync(anchorPath));
    } catch {
      hasher.update("<missing-script>");
    }
  }

  return {
    path: configPath,
    exists: true,
    entries: parsed.entries,
    warnings: parsed.warnings,
    errors: parsed.errors,
    trustHash: hasher.digest("hex"),
  };
}

function hashBytesOnly(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Sorted, de-duplicated list of resolved local-script anchors across entries. */
function collectScriptAnchors(entries: HookConfigEntry[]): string[] {
  const set = new Set<string>();
  for (const entry of entries) {
    const anchor = resolveScriptAnchor(entry.command);
    if (anchor) set.add(anchor);
  }
  return [...set].sort();
}

/**
 * Synthesize a `DiscoveredHook` for the `hooks.json` trust unit so the lockfile
 * diff / quarantine / accept flow treats it like any `.sh` file. `hookType` is a
 * placeholder (`pre`) and is NEVER used for dispatch — config entries carry
 * their own `event`; this synthetic hook exists ONLY to anchor trust state.
 */
export function syntheticConfigHook(loaded: LoadedHookConfig): DiscoveredHook | null {
  if (!loaded.exists || loaded.trustHash === null) return null;
  return {
    path: loaded.path,
    fileName: HOOKS_CONFIG_FILENAME,
    hookType: "pre",
    sha256: loaded.trustHash,
    size: 0,
  };
}
