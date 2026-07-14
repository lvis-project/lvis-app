import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";

import type { AuditEntry } from "../audit/audit-logger.js";
import { sanitizeRuntimeAllowedDirectories } from "./allowed-directories.js";
import {
  beginWorkspaceRootRemovalPersist,
  completeWorkspaceRootRemovalPersist,
  readPermissionSettings,
  type PendingWorkspaceRootRemoval,
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
  /** Roots already inactive whose durable cleanup will be retried. */
  pending?: PendingWorkspaceRootCleanup[];
  /** Every root kept out of runtime scope during this reconciliation. */
  inactiveRoots?: string[];
}

export interface PendingWorkspaceRootCleanup {
  operationId: string;
  storedPath: string;
  runtimePath: string;
  code: string;
  prunedGrants: number;
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
  /** Session detach/index repair after durable scope pruning, before completion. */
  beforeComplete?: (
    runtimeRoot: string,
    context: WorkspaceRootRemovalContext,
  ) => Promise<void>;
  /** Runs immediately after active→pending cutover, before durable cleanup. */
  onInactive?: (
    intent: PendingWorkspaceRootRemoval,
    context: WorkspaceRootRemovalContext,
  ) => Promise<void>;
  /** Runs after persistence/grant cleanup while the canonical root lock is held. */
  onRemoved?: (
    removed: RemovedWorkspaceRoot,
    context: WorkspaceRootRemovalContext,
  ) => Promise<void>;
}

/** Stable, opaque audit identity that never reveals `/tmp` or another root. */
export function opaqueWorkspaceRootAuditRef(root: string): string {
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return `<workspace-root:${digest}>`;
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

export interface WorkspaceRootRemovalExecution {
  intent: PendingWorkspaceRootRemoval;
  context: WorkspaceRootRemovalContext;
  prunedGrants: number;
  completed: boolean;
  code?: string;
}

async function finishCommittedWorkspaceRootRemoval(
  intent: PendingWorkspaceRootRemoval,
  options: ReconcileWorkspaceRootsOptions,
): Promise<WorkspaceRootRemovalExecution> {
  const activeRoots = readPermissionSettings(
    options.settingsPath,
  ).permissions.additionalDirectories;
  const context: WorkspaceRootRemovalContext = {
    preserveRoots: retainedDescendantWorkspaceRoots(intent.runtimePath, activeRoots),
    globalScopeWasAuthorized: true,
  };
  let prunedGrants = 0;
  const cleanupErrors: unknown[] = [];

  try {
    await options.onInactive?.(intent, context);
  } catch (error: unknown) {
    cleanupErrors.push(error);
  }

  try {
    if (options.beforeRemove) {
      prunedGrants = (await options.beforeRemove(intent.runtimePath, context)) ?? 0;
    } else {
      const pruned = await options.permissionManager?.prunePathGrantsUnderRoot(
        intent.runtimePath,
        { preserveRoots: context.preserveRoots },
      );
      prunedGrants = pruned?.length ?? 0;
    }
  } catch (error: unknown) {
    cleanupErrors.push(error);
  }

  try {
    await options.beforeComplete?.(intent.runtimePath, context);
  } catch (error: unknown) {
    cleanupErrors.push(error);
  }

  if (cleanupErrors.length > 0) {
    const aggregate = Object.assign(
      new AggregateError(cleanupErrors, "workspace-root-cleanup-failed"),
      { code: stableErrorCode(cleanupErrors[0]) },
    );
    return {
      intent,
      context,
      prunedGrants,
      completed: false,
      code: stableErrorCode(aggregate),
    };
  }

  try {
    const completed = await completeWorkspaceRootRemovalPersist(
      intent.operationId,
      options.settingsPath,
    );
    if (!completed) {
      const stillPending = (
        readPermissionSettings(options.settingsPath).permissions.pendingWorkspaceRootRemovals ?? []
      ).some(
        (candidate) => candidate.operationId === intent.operationId,
      );
      if (stillPending) {
        return { intent, context, prunedGrants, completed: false, code: "PERSIST_ERROR" };
      }
    }
    return { intent, context, prunedGrants, completed: true };
  } catch (error: unknown) {
    return {
      intent,
      context,
      prunedGrants,
      completed: false,
      code: stableErrorCode(error),
    };
  }
}

/**
 * User/slash removal entry point. The active→pending cutover commits before
 * live revocation and idempotent durable cleanup, so every post-commit failure
 * is reported as pending rather than rolling the root back into active scope.
 */
export async function removeWorkspaceRootWithIntent(
  root: string,
  options: ReconcileWorkspaceRootsOptions,
): Promise<WorkspaceRootRemovalExecution | null> {
  return withWorkspaceRootLifecycleLock(root, async () => {
    const begun = await beginWorkspaceRootRemovalPersist(
      root,
      options.source,
      options.settingsPath,
    );
    if (!begun) return null;
    return finishCommittedWorkspaceRootRemoval(begun.intent, options);
  });
}

async function resumePendingWorkspaceRootRemovals(
  options: ReconcileWorkspaceRootsOptions,
): Promise<WorkspaceRootRemovalExecution[]> {
  const snapshot = readPermissionSettings(
    options.settingsPath,
  ).permissions.pendingWorkspaceRootRemovals ?? [];
  const results: WorkspaceRootRemovalExecution[] = [];
  for (const intent of snapshot) {
    const result = await withWorkspaceRootLifecycleLock(intent.runtimePath, async () => {
      const current = (
        readPermissionSettings(options.settingsPath).permissions.pendingWorkspaceRootRemovals ?? []
      ).find(
        (candidate) => candidate.operationId === intent.operationId,
      );
      return current ? finishCommittedWorkspaceRootRemoval(current, options) : null;
    });
    if (result) results.push(result);
  }
  return results;
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
  const removed: RemovedWorkspaceRoot[] = [];
  const retained: RetainedWorkspaceRoot[] = [];
  const pending: PendingWorkspaceRootCleanup[] = [];
  const inactiveRoots = new Set<string>();
  const resumed = await resumePendingWorkspaceRootRemovals(options);
  for (const result of resumed) {
    inactiveRoots.add(result.intent.runtimePath);
    const path = opaqueWorkspaceRootAuditRef(result.intent.runtimePath);
    if (result.completed) {
      audit(options.auditLogger, options.source, "info", {
        path,
        operationId: result.intent.operationId,
        outcome: "cleanup-complete",
        prunedGrants: result.prunedGrants,
      });
    } else {
      pending.push({
        operationId: result.intent.operationId,
        storedPath: result.intent.storedPath,
        runtimePath: result.intent.runtimePath,
        code: result.code ?? "UNKNOWN",
        prunedGrants: result.prunedGrants,
      });
      audit(options.auditLogger, options.source, "warn", {
        path,
        operationId: result.intent.operationId,
        outcome: "cleanup-pending",
        code: result.code ?? "UNKNOWN",
      });
    }
  }
  const storedPaths = readPermissionSettings(options.settingsPath).permissions.additionalDirectories;
  if (storedPaths.length === 0) {
    return {
      removed,
      retained,
      ...(pending.length > 0 ? { pending } : {}),
      ...(inactiveRoots.size > 0 ? { inactiveRoots: [...inactiveRoots] } : {}),
    };
  }

  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const concurrency = Math.min(
    MAX_CONCURRENCY,
    Math.max(1, Math.trunc(options.concurrency ?? DEFAULT_CONCURRENCY)),
  );
  const probes = await probeRootsBounded(storedPaths, options.statFn ?? stat, timeoutMs, concurrency);
  for (const probe of probes) {
    const runtimePath = "runtimePath" in probe ? probe.runtimePath : undefined;
    const redactedPath = opaqueWorkspaceRootAuditRef(runtimePath ?? probe.storedPath);
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

      let begun;
      try {
        begun = await beginWorkspaceRootRemovalPersist(
          stillRegistered,
          options.source,
          options.settingsPath,
        );
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
          reason: "intent-persist-failed",
          code,
        });
        return;
      }
      if (!begun) return;
      inactiveRoots.add(begun.intent.runtimePath);
      const execution = await finishCommittedWorkspaceRootRemoval(begun.intent, options);
      if (!execution.completed) {
        pending.push({
          operationId: execution.intent.operationId,
          storedPath: execution.intent.storedPath,
          runtimePath: execution.intent.runtimePath,
          code: execution.code ?? "UNKNOWN",
          prunedGrants: execution.prunedGrants,
        });
        audit(options.auditLogger, options.source, "warn", {
          path: redactedPath,
          operationId: execution.intent.operationId,
          outcome: "cleanup-pending",
          reason: confirmation.kind,
          code: execution.code ?? "UNKNOWN",
        });
        return;
      }
      const removedRoot: RemovedWorkspaceRoot = {
        storedPath: execution.intent.storedPath,
        runtimePath: execution.intent.runtimePath,
        reason: confirmation.kind,
        prunedGrants: execution.prunedGrants,
      };
      removed.push(removedRoot);
      audit(options.auditLogger, options.source, "info", {
        path: redactedPath,
        operationId: execution.intent.operationId,
        outcome: "removed",
        reason: confirmation.kind,
        prunedGrants: execution.prunedGrants,
      });
      try {
        await options.onRemoved?.(removedRoot, execution.context);
      } catch (error: unknown) {
        audit(options.auditLogger, options.source, "warn", {
          path: redactedPath,
          outcome: "lifecycle-finalize-failed",
          code: stableErrorCode(error),
        });
      }
    });
  }

  return {
    removed,
    retained,
    ...(pending.length > 0 ? { pending } : {}),
    ...(inactiveRoots.size > 0 ? { inactiveRoots: [...inactiveRoots] } : {}),
  };
}
