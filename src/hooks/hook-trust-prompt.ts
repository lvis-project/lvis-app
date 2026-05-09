/**
 * Q12 Phase 4 — Layer 6 hook TOFU prompt orchestrator.
 *
 * Spec ref: docs/architecture/q12-permission-policy-design.md §3 Layer 6.
 *
 * Boot-time flow:
 *
 *   1. {@link discoverHooks} reads `~/.config/lvis/hooks/`.
 *   2. {@link diffAgainstLockfile} compares to the existing lockfile.
 *   3. If any `new` or `changed` entries → IPC `lvis:hooks:trust-prompt`
 *      to the renderer with the diff (file names, hashes, what changed).
 *   4. User clicks "Trust selected" or "Disable selected"; renderer
 *      sends back the per-file decision via IPC.
 *   5. Trusted hooks → lockfile updated; rejected hooks → moved to
 *      `.disabled/` subfolder (won't run on subsequent boots).
 *
 * Atomic cutover (CLAUDE.md No-Fallback): when the renderer is not
 * available (test, headless boot), the orchestrator runs in
 * **strict-deny** mode — every untrusted hook is automatically
 * disabled. There's no silent allow path.
 */
import { existsSync } from "node:fs";
import {
  buildAcceptedAtMap,
  diffAgainstLockfile,
  disableHook,
  discoverHooks,
  ensureHooksDirectory,
  persistLockfile,
  readLockfile,
  type DiscoveredHook,
  type HookDiff,
  type LockfileShape,
} from "./hook-discovery.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("hook-trust");

export interface TrustPromptDecision {
  fileName: string;
  /** When true the hook is moved into the trusted lockfile. */
  trust: boolean;
}

export interface TrustPromptDispatcher {
  /**
   * Surface the diff to the user. Returns the decision array.
   * The orchestrator already filters `removed` entries (no UX needed).
   */
  prompt(diff: HookDiff[]): Promise<TrustPromptDecision[]>;
}

export interface RunHookTrustOptions {
  /** Override hooks dir (test). */
  hooksDir?: string;
  /** Override lockfile path (test). */
  lockfilePath?: string;
  /** Override disabled subfolder (test). */
  disabledDir?: string;
  /**
   * UI dispatcher. When omitted, every untrusted hook is auto-disabled
   * (strict-deny — applied to headless test/boot paths).
   */
  promptDispatcher?: TrustPromptDispatcher;
}

export interface RunHookTrustResult {
  /** Trusted hooks (will run going forward). */
  trustedHooks: DiscoveredHook[];
  /** Hooks the user rejected, now living under `.disabled/`. */
  disabledHooks: DiscoveredHook[];
  /** Updated lockfile contents (or null if nothing was persisted). */
  lockfile: LockfileShape | null;
  /** Initial diff that triggered the prompt. Useful for audit. */
  diff: HookDiff[];
}

/**
 * Boot orchestrator. Idempotent — call once at startup. The lockfile
 * write is atomic so concurrent boots don't race (withFileLock inside
 * persistLockfile).
 */
export async function runHookTrustWorkflow(
  options: RunHookTrustOptions = {},
): Promise<RunHookTrustResult> {
  // Always ensure the directory exists — Phase 4 v1 ships an empty
  // directory on fresh installs (spec §11 v2.1 binding decision).
  ensureHooksDirectory(options.hooksDir);

  const discovered = discoverHooks(options.hooksDir);
  const lockfile = readLockfile(options.lockfilePath);
  const acceptedAtMap = buildAcceptedAtMap(lockfile);
  const diff = diffAgainstLockfile(discovered, lockfile);

  const newOrChanged = diff.filter(
    (d) => d.state === "new" || d.state === "changed",
  );
  const trusted = diff.filter((d) => d.state === "trusted").map((d) => d.hook);

  if (newOrChanged.length === 0) {
    // Nothing to prompt — but if the lockfile previously knew about
    // files that have since been deleted, refresh the lockfile so the
    // `removed` entries no longer appear in subsequent diffs.
    const removed = diff.filter((d) => d.state === "removed");
    if (removed.length > 0 && lockfile) {
      const next = await persistLockfile(trusted, options.lockfilePath, acceptedAtMap);
      return { trustedHooks: trusted, disabledHooks: [], lockfile: next, diff };
    }
    return { trustedHooks: trusted, disabledHooks: [], lockfile, diff };
  }

  // Surface to UI; if no dispatcher, strict-deny.
  let decisions: TrustPromptDecision[];
  if (options.promptDispatcher) {
    try {
      decisions = await options.promptDispatcher.prompt(newOrChanged);
    } catch (err) {
      log.warn(
        "hook-trust: prompt dispatcher failed (%s) — strict-deny applied",
        (err as Error).message,
      );
      decisions = newOrChanged.map((d) => ({ fileName: d.hook.fileName, trust: false }));
    }
  } else {
    log.info(
      "hook-trust: no prompt dispatcher (headless) — auto-disabling %d untrusted hook(s)",
      newOrChanged.length,
    );
    decisions = newOrChanged.map((d) => ({ fileName: d.hook.fileName, trust: false }));
  }

  const newlyTrusted: DiscoveredHook[] = [];
  const disabled: DiscoveredHook[] = [];
  for (const d of newOrChanged) {
    const decision = decisions.find((x) => x.fileName === d.hook.fileName);
    if (decision?.trust) {
      newlyTrusted.push(d.hook);
    } else {
      // Skip if the file already vanished between prompt and decision.
      if (existsSync(d.hook.path)) {
        try {
          disableHook(d.hook, options.disabledDir);
          disabled.push(d.hook);
        } catch (err) {
          log.warn(
            "hook-trust: disable failed for %s: %s",
            d.hook.fileName,
            (err as Error).message,
          );
        }
      }
    }
  }

  const allTrusted = [...trusted, ...newlyTrusted];
  const next = await persistLockfile(allTrusted, options.lockfilePath, acceptedAtMap);
  return {
    trustedHooks: allTrusted,
    disabledHooks: disabled,
    lockfile: next,
    diff,
  };
}
