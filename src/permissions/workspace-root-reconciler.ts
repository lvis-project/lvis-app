import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";

import type { AuditEntry } from "../audit/audit-logger.js";
import { redactFsPath } from "../audit/dlp-filter.js";
import { sanitizeRuntimeAllowedDirectories } from "./allowed-directories.js";
import {
  readPermissionSettings,
  removeAllowedDirectoryPersist,
} from "./permission-settings-store.js";
import { withWorkspaceRootLifecycleLock } from "./workspace-root-lifecycle-lock.js";
import { canonicalizePathForMatch, caseFoldForMatch } from "./sensitive-paths.js";

const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;

type StatFn = (path: string) => Promise<Pick<Stats, "isDirectory">>;

export interface WorkspaceRootAuditLogger {
  log(entry: AuditEntry): void;
}

export interface WorkspaceRootGrantPruner {
  prunePathGrantsUnderRoot(
    root: string,
    options?: { preserveRoots?: readonly string[] },
  ): Promise<readonly unknown[]>;
}

export interface WorkspaceRootRemovalContext {
  preserveRoots: readonly string[];
  globalScopeWasAuthorized: true;
}

export type WorkspaceRootRemovalReason = "missing" | "not-directory";
export type WorkspaceRootRetentionReason =
  | "directory"
  | "invalid-path"
  | "timeout"
  | "transient-error"
  | "persist-error"
  | "unprobed";

export interface RemovedWorkspaceRoot {
  /** Exact value removed from permissions.additionalDirectories. */
  storedPath: string;
  /** Canonical, case-preserving path used by the runtime and filesystem probe. */
  runtimePath: string;
  reason: WorkspaceRootRemovalReason;
  prunedGrants: number;
}

export interface RetainedWorkspaceRoot {
  storedPath: string;
  runtimePath?: string;
  reason: WorkspaceRootRetentionReason;
  /** Stable filesystem/error code only; never an exception message. */
  code?: string;
}

export interface WorkspaceRootReconcileResult {
  removed: RemovedWorkspaceRoot[];
  retained: RetainedWorkspaceRoot[];
}

export interface ReconcileWorkspaceRootsOptions {
  auditLogger?: WorkspaceRootAuditLogger;
  permissionManager?: WorkspaceRootGrantPruner;
  source: "boot" | "list-roots" | string;
  /** Test-only settings file override. */
  settingsPath?: string;
  /** Test seam for filesystem outcomes. */
  statFn?: StatFn;
  timeoutMs?: number;
  concurrency?: number;
  /** Durable fail-closed cleanup that must succeed before settings shrink. */
  beforeRemove?: (
    runtimeRoot: string,
    context: WorkspaceRootRemovalContext,
  ) => Promise<number | void>;
  /** Runs after persistence/grant cleanup while the canonical root lock is held. */
  onRemoved?: (
    removed: RemovedWorkspaceRoot,
    context: WorkspaceRootRemovalContext,
  ) => Promise<void>;
}
type RootProbe =
  | { storedPath: string; kind: "invalid-path" }
  | { storedPath: string; runtimePath: string; kind: "directory" }
  | { storedPath: string; runtimePath: string; kind: "missing" | "not-directory" }
  | { storedPath: string; runtimePath: string; kind: "timeout" }
  | { storedPath: string; runtimePath: string; kind: "transient-error"; code: string }
  | { storedPath: string; runtimePath?: string; kind: "unprobed" };

function stableErrorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "UNKNOWN";
  const code = String((error as { code?: unknown }).code ?? "UNKNOWN").toUpperCase();
  return /^[A-Z0-9_-]{1,64}$/.test(code) ? code : "UNKNOWN";
}

function audit(
  logger: WorkspaceRootAuditLogger | undefined,
  source: string,
  type: "info" | "warn",
  detail: Record<string, unknown>,
): void {
  logger?.log({
    timestamp: new Date().toISOString(),
    sessionId: "boot",
    type,
    input: "workspace-root-reconcile",
    output: JSON.stringify({ source, ...detail }),
  });
}

async function probeRoot(storedPath: string, statFn: StatFn, timeoutMs: number): Promise<RootProbe> {
  const runtimePath = sanitizeRuntimeAllowedDirectories([storedPath])[0];
  if (!runtimePath) return { storedPath, kind: "invalid-path" };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RootProbe>((resolve) => {
    timer = setTimeout(() => resolve({ storedPath, runtimePath, kind: "timeout" }), timeoutMs);
    timer.unref?.();
  });
  const filesystem = Promise.resolve()
    .then(() => statFn(runtimePath))
    .then<RootProbe>((result) => ({
      storedPath,
      runtimePath,
      kind: result.isDirectory() ? "directory" : "not-directory",
    }))
    .catch<RootProbe>((error: unknown) => {
      const code = stableErrorCode(error);
      if (code === "ENOENT") return { storedPath, runtimePath, kind: "missing" };
      if (code === "ENOTDIR") return { storedPath, runtimePath, kind: "not-directory" };
      return { storedPath, runtimePath, kind: "transient-error", code };
    });

  try {
    return await Promise.race([filesystem, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeRootsBounded(
  storedPaths: readonly string[],
  statFn: StatFn,
  timeoutMs: number,
  concurrency: number,
): Promise<RootProbe[]> {
  const probes = new Array<RootProbe>(storedPaths.length);
  let cursor = 0;
  const workerCount = Math.min(storedPaths.length, concurrency);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < storedPaths.length) {
        const index = cursor++;
        const probe = await probeRoot(storedPaths[index]!, statFn, timeoutMs);
        probes[index] = probe;
        if (probe.kind === "timeout") return;
      }
    }),
  );
  for (let index = 0; index < storedPaths.length; index += 1) {
    if (probes[index]) continue;
    const storedPath = storedPaths[index]!;
    probes[index] = {
      storedPath,
      runtimePath: sanitizeRuntimeAllowedDirectories([storedPath])[0],
      kind: "unprobed",
    };
  }
  return probes;
}

/**
 * Return separately registered roots strictly below `removedRoot`. Removing a
 * parent workspace must not revoke grants or routine scope owned by one of
 * these still-registered child projects.
 */
export function retainedDescendantWorkspaceRoots(
  removedRoot: string,
  candidates: readonly string[],
): string[] {
  const root = caseFoldForMatch(canonicalizePathForMatch(removedRoot)).replace(/\/+$/g, "") || "/";
  const seen = new Set<string>();
  const retained: string[] = [];
  for (const candidate of candidates) {
    const canonical = canonicalizePathForMatch(candidate);
    const key = caseFoldForMatch(canonical).replace(/\/+$/g, "") || "/";
    const descendant = key !== root && (root === "/"
      ? key.startsWith("/")
      : key.startsWith(`${root}/`));
    if (!descendant || seen.has(key)) continue;
    seen.add(key);
    retained.push(canonical);
  }
  return retained;
}

/**
 * Reconcile persisted additional workspace roots with current filesystem state.
 *
 * Only confirmed absence and confirmed non-directories are destructive. Access,
 * network, busy, unknown, and timeout failures retain the user's setting. Probes
 * are bounded and concurrent, while settings mutations remain serial so the
 * read-modify-write persistence helper cannot race with itself.
 */
export async function reconcileWorkspaceRoots(
  options: ReconcileWorkspaceRootsOptions,
): Promise<WorkspaceRootReconcileResult> {
  const storedPaths = readPermissionSettings(options.settingsPath).permissions.additionalDirectories;
  if (storedPaths.length === 0) return { removed: [], retained: [] };

  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const concurrency = Math.min(
    MAX_CONCURRENCY,
    Math.max(1, Math.trunc(options.concurrency ?? DEFAULT_CONCURRENCY)),
  );
  const probes = await probeRootsBounded(storedPaths, options.statFn ?? stat, timeoutMs, concurrency);
  const removed: RemovedWorkspaceRoot[] = [];
  const retained: RetainedWorkspaceRoot[] = [];

  for (const probe of probes) {
    const runtimePath = "runtimePath" in probe ? probe.runtimePath : undefined;
    const redactedPath = redactFsPath(runtimePath ?? probe.storedPath);
    if (probe.kind === "directory") {
      retained.push({ storedPath: probe.storedPath, runtimePath, reason: "directory" });
      continue;
    }
    if (probe.kind === "invalid-path") {
      retained.push({ storedPath: probe.storedPath, reason: "invalid-path", code: "INVALID_PATH" });
      audit(options.auditLogger, options.source, "warn", {
        path: redactedPath,
        outcome: "retained",
        reason: "invalid-path",
        code: "INVALID_PATH",
      });
      continue;
    }
    if (probe.kind === "unprobed") {
      retained.push({
        storedPath: probe.storedPath,
        runtimePath,
        reason: "unprobed",
        code: "STAT_UNPROBED_AFTER_TIMEOUT",
      });
      audit(options.auditLogger, options.source, "warn", {
        path: redactedPath,
        outcome: "retained",
        reason: "unprobed",
        code: "STAT_UNPROBED_AFTER_TIMEOUT",
      });
      continue;
    }
    if (probe.kind === "timeout") {
      retained.push({
        storedPath: probe.storedPath,
        runtimePath,
        reason: "timeout",
        code: "STAT_TIMEOUT",
      });
      audit(options.auditLogger, options.source, "warn", {
        path: redactedPath,
        outcome: "retained",
        reason: "timeout",
        code: "STAT_TIMEOUT",
      });
      continue;
    }
    if (probe.kind === "transient-error") {
      retained.push({
        storedPath: probe.storedPath,
        runtimePath,
        reason: "transient-error",
        code: probe.code,
      });
      audit(options.auditLogger, options.source, "warn", {
        path: redactedPath,
        outcome: "retained",
        reason: "transient-error",
        code: probe.code,
      });
      continue;
    }

    await withWorkspaceRootLifecycleLock(probe.runtimePath, async () => {
      // A root may have been recreated/re-added after the snapshot probe. Confirm
      // the destructive result again while holding the same lifecycle lock used
      // by add/remove so a stale ENOENT can never delete a newer registration.
      const current = readPermissionSettings(options.settingsPath).permissions.additionalDirectories;
      const stillRegistered = current.find(
        (candidate) =>
          sanitizeRuntimeAllowedDirectories([candidate])[0] === probe.runtimePath,
      );
      if (!stillRegistered) return;

      const confirmation = await probeRoot(stillRegistered, options.statFn ?? stat, timeoutMs);
      if (confirmation.kind !== "missing" && confirmation.kind !== "not-directory") {
        const reason = confirmation.kind === "directory"
          ? "directory"
          : confirmation.kind === "timeout"
            ? "timeout"
            : confirmation.kind === "transient-error"
              ? "transient-error"
              : "invalid-path";
        const code = confirmation.kind === "timeout"
          ? "STAT_TIMEOUT"
          : confirmation.kind === "transient-error"
            ? confirmation.code
            : confirmation.kind === "invalid-path"
              ? "INVALID_PATH"
              : undefined;
        retained.push({
          storedPath: stillRegistered,
          ...("runtimePath" in confirmation ? { runtimePath: confirmation.runtimePath } : {}),
          reason,
          ...(code ? { code } : {}),
        });
        if (reason !== "directory") {
          audit(options.auditLogger, options.source, "warn", {
            path: redactedPath,
            outcome: "retained",
            reason,
            ...(code ? { code } : {}),
          });
        }
        return;
      }

      const lifecycleContext: WorkspaceRootRemovalContext = {
        preserveRoots: retainedDescendantWorkspaceRoots(
          probe.runtimePath,
          current.filter((candidate) => candidate !== stillRegistered),
        ),
        globalScopeWasAuthorized: true,
      };
      let prunedGrants = 0;
      try {
        prunedGrants = (await options.beforeRemove?.(probe.runtimePath, lifecycleContext)) ?? 0;
      } catch (error: unknown) {
        const code = stableErrorCode(error);
        retained.push({
          storedPath: stillRegistered,
          runtimePath: probe.runtimePath,
          reason: "persist-error",
          code,
        });
        audit(options.auditLogger, options.source, "warn", {
          path: redactedPath,
          outcome: "retained",
          reason: "lifecycle-prepare-failed",
          code,
        });
        return;
      }

      try {
        await removeAllowedDirectoryPersist(stillRegistered, options.settingsPath);
      } catch (error: unknown) {
        const code = stableErrorCode(error);
        retained.push({
          storedPath: stillRegistered,
          runtimePath: probe.runtimePath,
          reason: "persist-error",
          code,
        });
        audit(options.auditLogger, options.source, "warn", {
          path: redactedPath,
          outcome: "retained",
          reason: "persist-error",
          code,
        });
        return;
      }

      if (!options.beforeRemove) {
        try {
          const pruned = await options.permissionManager?.prunePathGrantsUnderRoot(
            probe.runtimePath,
            { preserveRoots: lifecycleContext.preserveRoots },
          );
          prunedGrants = pruned?.length ?? 0;
        } catch (error: unknown) {
          audit(options.auditLogger, options.source, "warn", {
            path: redactedPath,
            outcome: "grant-prune-failed",
            code: stableErrorCode(error),
          });
        }
      }
      const removedRoot: RemovedWorkspaceRoot = {
        storedPath: stillRegistered,
        runtimePath: probe.runtimePath,
        reason: confirmation.kind,
        prunedGrants,
      };
      removed.push(removedRoot);
      audit(options.auditLogger, options.source, "info", {
        path: redactedPath,
        outcome: "removed",
        reason: confirmation.kind,
        prunedGrants,
      });
      try {
        await options.onRemoved?.(removedRoot, lifecycleContext);
      } catch (error: unknown) {
        audit(options.auditLogger, options.source, "warn", {
          path: redactedPath,
          outcome: "lifecycle-finalize-failed",
          code: stableErrorCode(error),
        });
      }
    });
  }

  return { removed, retained };
}
