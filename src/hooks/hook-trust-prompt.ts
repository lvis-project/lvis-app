/**
 * Permission policy Layer 6 hook trust quarantine workflow.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 6.
 *
 * Boot-time flow:
 *
 *   1. {@link discoverHooks} reads `~/.config/lvis/hooks/`.
 *   2. {@link diffAgainstLockfile} compares to the existing lockfile.
 *   3. If any `new` or `changed` entries → strict-deny unless a test
 *      dispatcher is injected. Production trust enrollment is the
 *      user-keyboard `/permission hooks accept <name>` path.
 *   4. Trusted hooks → lockfile updated; rejected hooks → moved to
 *      `.disabled/` subfolder (won't run on subsequent boots).
 *
 * Atomic cutover (CLAUDE.md No-Fallback): production boot runs in
 * **strict-deny** mode — every untrusted hook is automatically disabled.
 * There's no renderer approval prompt or silent allow path.
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
   * Test dispatcher. Production omits this so every untrusted hook is
   * auto-disabled (strict-deny).
   */
  promptDispatcher?: TrustPromptDispatcher;
}

export interface RunHookTrustResult {
  /** Trusted hooks (will run going forward). */
  trustedHooks: DiscoveredHook[];
  /** Hooks quarantined or rejected, now living under `.disabled/`. */
  disabledHooks: DiscoveredHook[];
  /** Updated lockfile contents (or null if nothing was persisted). */
  lockfile: LockfileShape | null;
  /** Initial diff that triggered the trust decision. Useful for audit. */
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
  // Always ensure the directory exists — hook trust ships an empty
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
    // Nothing to decide — but if the lockfile previously knew about
    // files that have since been deleted, refresh the lockfile so the
    // `removed` entries no longer appear in subsequent diffs.
    const removed = diff.filter((d) => d.state === "removed");
    if (removed.length > 0 && lockfile) {
      const next = await persistLockfile(trusted, options.lockfilePath, acceptedAtMap);
      return { trustedHooks: trusted, disabledHooks: [], lockfile: next, diff };
    }
    return { trustedHooks: trusted, disabledHooks: [], lockfile, diff };
  }

  // Test dispatcher path; production omits it and strict-denies.
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
      // Skip if the file already vanished between diff and decision.
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
