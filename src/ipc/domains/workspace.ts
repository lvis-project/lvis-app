/**
 * Workspace file-browser domain IPC handlers.
 * Covers: lvis:workspace:pick-root, lvis:workspace:list-roots,
 *         lvis:workspace:list-dir, lvis:workspace:remove-root,
 *         lvis:workspace:reveal
 *
 * Renderer reaches these via window.lvis.workspace.*.
 *
 * Project-root SOT: there is NO new root store. A picked project folder is
 * persisted to `permissions.additionalDirectories` (~/.lvis/settings.json) —
 * the SAME list the executor's Layer 1 allow-list consumes — so a folder that
 * shows up in the browser is automatically readable by `read_file` and the
 * preview IPC, and vice-versa. Adding a separate store would create a
 * "visible but not readable" divergence (No-Fallback).
 *
 * The default root is process.cwd() (anchored to ~/.lvis/workspace by
 * ensureWorkspaceCwd) — deterministic across dev/packaged, unlike the bare
 * `process.cwd()` a Finder-launched app used to inherit.
 *
 * listDir re-validates every requested path against the same scope guard so a
 * compromised renderer cannot list outside the selected roots.
 */
import { dialog, ipcMain, shell } from "electron";
import { t } from "../../i18n/index.js";
import { promises as fs } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { randomBytes } from "node:crypto";
import { validateSender, auditUnauthorized } from "../gated.js";
import { CHANNELS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import { assertReadableFilePath } from "../../tools/file-read-core.js";
import {
  readPermissionSettings,
  addAllowedDirectoryPersist,
} from "../../permissions/permission-settings-store.js";
import {
  buildRuntimeAllowedDirectories,
  sanitizeRuntimeAllowedDirectories,
  validateDirectoryAddition,
} from "../../permissions/allowed-directories.js";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
  isSensitivePath,
} from "../../permissions/sensitive-paths.js";
import { getDefaultWorkspaceRoot } from "../../main/default-workspace-root.js";
import {
  reconcileWorkspaceRoots,
  removeWorkspaceRootWithIntent,
  retainedDescendantWorkspaceRoots,
  opaqueWorkspaceRootAuditRef,
} from "../../permissions/workspace-root-reconciler.js";
import { withWorkspaceRootLifecycleLock } from "../../permissions/workspace-root-lifecycle-lock.js";
import { detachWorkspaceRootSessions } from "../../memory/workspace-root-session-lifecycle.js";

/** Max directory entries returned per lazy listing (bounds huge dirs). */
const MAX_DIR_ENTRIES = 1_000;

/** A minted acknowledgement token is valid for this window before it expires. */
const ACK_TOKEN_TTL_MS = 60_000;

/**
 * Main-process-held pending picks awaiting adjacency acknowledgement.
 *
 * Keyed by a one-time token minted only AFTER a real `showOpenDialog` returned a
 * warned path. The stored `path` is the MAIN-OWNED dialog result — never a
 * renderer-supplied string — so the acknowledgement pass can only ever persist a
 * directory the user actually chose in the native picker. Without this binding a
 * compromised renderer could hand back an arbitrary path with `acknowledge=true`
 * and silently widen the Layer-1 read allow-list.
 */
const pendingPicks = new Map<string, { path: string; expires: number; gesture: PickGesture }>();

/**
 * How the pending path entered the ack flow — recorded in the widening audit so
 * a native-picker widening (`dialog`) and a drag-drop widening (`drop`) are
 * distinguishable in the log. A dropped path is renderer-NAMED, so its audit
 * trail matters more than a native `showOpenDialog` result the OS vouched for.
 */
type PickGesture = "dialog" | "drop";

/** Drop expired tokens so a stream of un-acknowledged picks can't grow the map. */
function prunePendingPicks(now: number): void {
  for (const [token, pending] of pendingPicks) {
    if (now > pending.expires) pendingPicks.delete(token);
  }
}

/**
 * Map a {@link validateDirectoryAddition} hard-deny `reason` (raw English prose)
 * to a STABLE renderer error code. The IPC boundary emits English, but only a
 * discrete code — never the prose — must reach the UI, which maps it to Korean
 * (CLAUDE.md "IPC Error Message Language Convention"). Returning `verdict.reason`
 * verbatim leaked untranslated English into the ChatSidePanel drop toast; these
 * codes route through the renderer's existing formatOpError code map instead.
 *
 * The prose is a closed set produced by `validateDirectoryAddition`:
 *   - "directory path is empty"          → `invalid-path`
 *   - "filesystem root is not allowed"   → `path-not-allowed`
 *   - "path matches sensitive pattern …" → `sensitive-path`
 */
function directoryDenyCode(reason: string): "invalid-path" | "path-not-allowed" | "sensitive-path" {
  if (reason.startsWith("path matches sensitive pattern")) return "sensitive-path";
  if (reason === "filesystem root is not allowed") return "path-not-allowed";
  return "invalid-path";
}

export interface WorkspaceRoot {
  path: string;
  /** The default workspace root (`process.cwd()`), badged in the UI. */
  isDefault: boolean;
}

export interface WorkspaceListRootsResult {
  ok: boolean;
  defaultRoot?: string;
  roots?: WorkspaceRoot[];
  cleanupPending?: number;
  error?: string;
}

export interface WorkspacePickRootResult {
  ok: boolean;
  canceled?: boolean;
  added?: string;
  roots?: WorkspaceRoot[];
  /** Adjacency warnings (`.env`/`.git`/…) surfaced to the renderer. */
  warnings?: string[];
  /**
   * The pick had adjacency warnings and was NOT persisted — the renderer must
   * surface {@link warnings} and re-invoke `pickRoot({ ackToken })` with the
   * one-time {@link ackToken} to confirm. Mirrors the two-step
   * `/permission dir allow … --ack-warnings` gate in permission-slash.ts, so a
   * folder pick can never silently widen the Layer-1 read allow-list.
   */
  requiresAcknowledgement?: boolean;
  /** Picked path awaiting acknowledgement — display only (never sent back). */
  pendingPath?: string;
  /**
   * One-time token that binds an acknowledgement to the exact dialog-picked path
   * the main process holds. The renderer confirms by presenting THIS token (not
   * a path), so it can never persist a directory the native picker did not
   * return. Expires after {@link ACK_TOKEN_TTL_MS}; consumed on first use.
   */
  ackToken?: string;
  error?: string;
}

/**
 * Result of the drag-drop add-root prepare step (#1458). A dropped folder path
 * is renderer-NAMED (resolved in preload via webUtils.getPathForFile), so unlike
 * a native picker it is NEVER persisted immediately: this step re-validates the
 * path and — on success — hands back a one-time ack token bound to the path the
 * MAIN process now owns. The renderer confirms via `pickRoot({ ackToken })`,
 * echoing the token (never a path), so it can never widen the Layer-1 read
 * allow-list to a directory of its own choosing without an explicit user ack.
 */
export interface WorkspaceDropPrepareResult {
  ok: boolean;
  /**
   * A hard deny (Layer-0 sensitive/root path) OR the dropped entry is not a
   * directory (`not-a-dir` — a dropped file is rejected; the renderer never
   * guesses a parent dir). Present only when `ok` is false.
   */
  error?: string;
  /** Adjacency warnings (`.env`/`.git`/…) to surface alongside the ack prompt. */
  warnings?: string[];
  /** The validated, MAIN-OWNED path awaiting acknowledgement — display only. */
  pendingPath?: string;
  /**
   * One-time token bound to {@link pendingPath}. The renderer confirms the add
   * by presenting THIS token to `pickRoot`, never a path — mirroring the native
   * warned-pick ack so the drop trust tier equals the #1448 ack tier.
   */
  ackToken?: string;
}

export interface WorkspaceDirEntry {
  name: string;
  path: string;
  type: "file" | "directory";
}

export interface WorkspaceListDirResult {
  ok: boolean;
  path?: string;
  entries?: WorkspaceDirEntry[];
  truncated?: boolean;
  error?: "unauthorized" | "path-not-allowed" | "sensitive-path" | "not-a-dir" | "read-failed";
  message?: string;
}

export interface WorkspaceRemoveRootResult {
  ok: boolean;
  removed?: string;
  roots?: WorkspaceRoot[];
  /**
   * #1493 — count of orphaned path-scoped "Allow always" grants pruned because
   * they targeted a path strictly under the removed root (`rules[].tier` is an
   * independent grant surface from `additionalDirectories`; without this they
   * would silently revive on re-add). 0 when none matched. The renderer mentions
   * a non-zero count in its removal toast (Korean via i18n).
   */
  prunedGrants?: number;
  /** Durable cleanup remains journaled, while the root is already inactive. */
  cleanupPending?: boolean;
  error?: "unauthorized" | "invalid-path" | "not-an-additional-root" | "cannot-remove-default" | "lifecycle-failed";
  message?: string;
}

export interface WorkspaceRevealResult {
  ok: boolean;
  error?: "unauthorized" | "path-not-allowed" | "sensitive-path" | "not-found";
  message?: string;
}

function currentScope(): { cwd: string; extraAllowed: string[] } {
  const cwd = getDefaultWorkspaceRoot();
  const additional = readPermissionSettings().permissions.additionalDirectories;
  return { cwd, extraAllowed: buildRuntimeAllowedDirectories(additional) };
}

function computeRoots(): WorkspaceRoot[] {
  const defaultRoot = getDefaultWorkspaceRoot();
  const additional = readPermissionSettings().permissions.additionalDirectories;
  const canonicalAdds = sanitizeRuntimeAllowedDirectories(additional);
  const seen = new Set<string>([defaultRoot]);
  const roots: WorkspaceRoot[] = [{ path: defaultRoot, isDefault: true }];
  for (const dir of canonicalAdds) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    roots.push({ path: dir, isDefault: false });
  }
  return roots;
}

export function registerWorkspaceHandlers(deps: IpcDeps): void {
  const { auditLogger, getMainWindow } = deps;
  type WorkspaceMemoryLifecycle = {
    allowProjectRoot?: (root: string) => unknown;
    detachSessionsFromProject?: (root: string) => unknown;
  };
  type WorkspaceRootRevocationOptions = {
    globalScopeWasAuthorized?: boolean;
    preserveRoots?: readonly string[];
  };
  type WorkspaceLoopLifecycle = {
    revokeWorkspaceRoot?: (root: string, options?: WorkspaceRootRevocationOptions) => unknown;
  };

  const stableErrorCode = (error: unknown): string => {
    const candidate =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : error instanceof Error
          ? error.name
          : undefined;
    const code = String(candidate ?? "UNKNOWN").toUpperCase();
    return /^[A-Z0-9_-]{1,64}$/.test(code) ? code : "UNKNOWN";
  };
  const isLifecycleCount = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

  const auditLifecycleWarning = (
    source: string,
    root: string,
    phase:
      | "allow"
      | "revoke-live-scopes"
      | "prune-path-grants"
      | "prune-routine-scopes"
      | "detach-sessions",
    error: unknown,
  ): void => {
    try {
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "workspace-root-lifecycle",
        type: "warn",
        input: JSON.stringify({
          channel: source,
          path: opaqueWorkspaceRootAuditRef(root),
          lifecyclePhase: phase,
          errorCode: stableErrorCode(error),
        }),
      });
    } catch {
      // An audit sink failure must not mask the lifecycle decision itself.
    }
  };

  const sessionMemoryManagers = (
    source: string = CHANNELS.workspace.listRoots,
    root: string = getDefaultWorkspaceRoot(),
    failClosed = false,
  ): WorkspaceMemoryLifecycle[] => {
    const managers: WorkspaceMemoryLifecycle[] = [];
    const add = (candidate: unknown): void => {
      if (
        candidate &&
        (typeof candidate === "object" || typeof candidate === "function") &&
        !managers.includes(candidate as WorkspaceMemoryLifecycle)
      ) {
        managers.push(candidate as WorkspaceMemoryLifecycle);
      }
    };
    const primary = deps.memoryManager as unknown as WorkspaceMemoryLifecycle | undefined;
    if (failClosed && typeof primary?.detachSessionsFromProject !== "function") {
      const error = Object.assign(new Error("workspace memory manager unavailable"), {
        code: "MEMORY_MANAGER_UNAVAILABLE",
      });
      auditLifecycleWarning(source, root, "detach-sessions", error);
      throw error;
    }
    add(primary);
    try {
      const sideLoop = deps.sideChatConversationLoop as
        | { deps?: { memoryManager?: unknown } }
        | undefined;
      add(sideLoop?.deps?.memoryManager);
    } catch (error: unknown) {
      auditLifecycleWarning(source, root, "detach-sessions", error);
      if (failClosed) throw error;
    }
    try {
      add(deps.getSubAgentRunner?.());
    } catch (error: unknown) {
      auditLifecycleWarning(source, root, "detach-sessions", error);
      if (failClosed) throw error;
    }
    return managers;
  };

  async function detachWorkspaceRootSessionsBeforeRemoval(
    root: string,
    source: string,
  ): Promise<number> {
    try {
      return await detachWorkspaceRootSessions(
        root,
        sessionMemoryManagers(source, root, true),
      );
    } catch (error: unknown) {
      auditLifecycleWarning(source, root, "detach-sessions", error);
      throw Object.assign(new Error("workspace-root-session-detach-failed"), {
        code: stableErrorCode(error),
      });
    }
  }
  const allowWorkspaceRoot = (root: string, source: string, allowRoutine = true): void => {
    for (const manager of sessionMemoryManagers(source, root)) {
      if (typeof manager.allowProjectRoot !== "function") continue;
      try {
        manager.allowProjectRoot(root);
      } catch (error: unknown) {
        auditLifecycleWarning(source, root, "allow", error);
      }
    }
    if (allowRoutine && typeof deps.routineEngine?.allowWorkspaceRoot === "function") {
      try {
        deps.routineEngine.allowWorkspaceRoot(root);
      } catch (error: unknown) {
        auditLifecycleWarning(source, root, "allow", error);
      }
    }
  };

  async function finalizeRemovedWorkspaceRoot(
    root: string,
    source: string,
    options: WorkspaceRootRevocationOptions,
  ): Promise<{ liveScopesRevoked: number }> {
    let liveScopesRevoked = 0;
    const errors: unknown[] = [];
    const liveScopeOwners: unknown[] = [
      deps.conversationLoop,
      deps.sideChatConversationLoop,
      deps.routineEngine,
    ];
    try {
      liveScopeOwners.push(deps.getSubAgentRunner?.());
    } catch (error: unknown) {
      errors.push(error);
      auditLifecycleWarning(source, root, "revoke-live-scopes", error);
    }
    for (const candidate of liveScopeOwners) {
      const loop = candidate as WorkspaceLoopLifecycle | undefined;
      if (typeof loop?.revokeWorkspaceRoot !== "function") continue;
      try {
        const result = await Promise.resolve(loop.revokeWorkspaceRoot(root, options)) as
          | {
              sessionDirectoriesRemoved?: unknown;
              turnDirectoriesRemoved?: unknown;
              liveScopesRevoked?: unknown;
            }
          | null
          | undefined;
        const hasDirectResult = Boolean(
          result && typeof result === "object" && "liveScopesRevoked" in result,
        );
        let removed: number | null = null;
        if (hasDirectResult) {
          if (isLifecycleCount(result?.liveScopesRevoked)) {
            removed = result.liveScopesRevoked;
          }
        } else if (
          isLifecycleCount(result?.sessionDirectoriesRemoved) &&
          isLifecycleCount(result?.turnDirectoriesRemoved)
        ) {
          const combined = result.sessionDirectoriesRemoved + result.turnDirectoriesRemoved;
          if (Number.isSafeInteger(combined)) removed = combined;
        }
        if (removed === null) {
          const invalidResult = Object.assign(
            new Error("workspace-root-live-scope-revoke-invalid-result"),
            { code: "WORKSPACE_ROOT_LIVE_SCOPE_REVOKE_INVALID_RESULT" },
          );
          errors.push(invalidResult);
          auditLifecycleWarning(source, root, "revoke-live-scopes", invalidResult);
          continue;
        }
        liveScopesRevoked += removed;
      } catch (error: unknown) {
        errors.push(error);
        auditLifecycleWarning(source, root, "revoke-live-scopes", error);
      }
    }

    if (errors.length > 0) {
      throw Object.assign(
        new AggregateError(errors, "workspace-root-live-scope-revoke-failed"),
        { code: "WORKSPACE_ROOT_LIVE_SCOPE_REVOKE_FAILED" },
      );
    }

    return { liveScopesRevoked };
  }
  async function pruneWorkspaceRootGrants(
    root: string,
    source: string,
    preserveRoots: readonly string[] = [],
  ): Promise<{
    count: number;
    audit: Array<{ tool: string; tier: string; path: string }>;
  }> {
    const permissionManager = deps.conversationLoop?.permissionManager;
    if (!permissionManager) {
      const error = Object.assign(new Error("workspace permission manager unavailable"), {
        code: "PERMISSION_MANAGER_UNAVAILABLE",
      });
      auditLifecycleWarning(source, root, "prune-path-grants", error);
      throw error;
    }
    try {
      const pruned = await permissionManager.prunePathGrantsUnderRoot(root, { preserveRoots });
      return {
        count: pruned.length,
        audit: pruned.map((grant) => ({
          tool: grant.toolName,
          tier: grant.tier,
          path: opaqueWorkspaceRootAuditRef(grant.path),
        })),
      };
    } catch (error: unknown) {
      auditLifecycleWarning(source, root, "prune-path-grants", error);
      const lifecycleError = new Error("workspace-root-grant-prune-failed");
      (lifecycleError as Error & { code: string }).code = stableErrorCode(error);
      throw lifecycleError;
    }
  }

  async function pruneWorkspaceRootRoutineScopes(
    root: string,
    source: string,
    preserveRoots: readonly string[],
  ): Promise<void> {
    const routinesStore = deps.routinesStore;
    if (typeof routinesStore?.revokeWorkspaceRoot !== "function") {
      const error = Object.assign(new Error("workspace routines store unavailable"), {
        code: "ROUTINES_STORE_UNAVAILABLE",
      });
      auditLifecycleWarning(source, root, "prune-routine-scopes", error);
      throw error;
    }
    try {
      await routinesStore.revokeWorkspaceRoot(root, { preserveRoots });
    } catch (error: unknown) {
      auditLifecycleWarning(source, root, "prune-routine-scopes", error);
      const lifecycleError = new Error("workspace-root-routine-prune-failed");
      (lifecycleError as Error & { code: string }).code = stableErrorCode(error);
      throw lifecycleError;
    }
  }

  async function pruneWorkspaceRootDurableScopes(
    root: string,
    source: string,
    preserveRoots: readonly string[],
  ): Promise<Awaited<ReturnType<typeof pruneWorkspaceRootGrants>>> {
    const errors: unknown[] = [];
    let grants: Awaited<ReturnType<typeof pruneWorkspaceRootGrants>> = {
      count: 0,
      audit: [],
    };
    try {
      await pruneWorkspaceRootRoutineScopes(root, source, preserveRoots);
    } catch (error: unknown) {
      errors.push(error);
    }
    try {
      grants = await pruneWorkspaceRootGrants(root, source, preserveRoots);
    } catch (error: unknown) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw Object.assign(
        new AggregateError(errors, "workspace-root-durable-scope-cleanup-failed"),
        { code: "WORKSPACE_ROOT_DURABLE_SCOPE_CLEANUP_FAILED" },
      );
    }
    return grants;
  }

  type WorkspaceRootRemoval = {
    storedPath: string;
    runtimePath: string;
    persisted: string[];
    prunedGrants: number;
    prunedAudit: Array<{ tool: string; tier: string; path: string }>;
    detachedSessions: number;
    liveScopesRevoked: number;
    cleanupPending: boolean;
    operationId: string;
  };

  async function allowPersistedWorkspaceRoot(root: string, source: string): Promise<string[]> {
    const runtimeRoot = canonicalizePathForMatch(resolvePath(root));
    return withWorkspaceRootLifecycleLock(runtimeRoot, async () => {
      // Every persistent add path (picker, slash command, and Settings) reaches
      // this choke point. Validate inside the same-root lifecycle lock so a
      // non-existent path or regular file can never enter the durable registry,
      // even when the caller did not originate from the native picker.
      const stat = await fs.stat(runtimeRoot).catch(() => null);
      if (!stat) {
        throw new Error("workspace-root-not-found");
      }
      if (!stat.isDirectory()) {
        throw new Error("workspace-root-not-directory");
      }
      const current = readPermissionSettings().permissions.additionalDirectories;
      const runtimeKey = caseFoldForMatch(runtimeRoot);
      const alreadyRegistered = current.some(
        (candidate) =>
          caseFoldForMatch(canonicalizePathForMatch(candidate)) === runtimeKey,
      );
      if (alreadyRegistered) return current;
      const preserveRoots = retainedDescendantWorkspaceRoots(runtimeRoot, current);
      await pruneWorkspaceRootGrants(runtimeRoot, source, preserveRoots);
      try {
        // Re-add must not persist until stale durable routine scopes are gone.
        // Otherwise a restart could lose an in-memory deny and revive them.
        await pruneWorkspaceRootRoutineScopes(runtimeRoot, source, preserveRoots);
      } catch (error: unknown) {
        try {
          deps.routineEngine?.revokeWorkspaceRoot(runtimeRoot, { preserveRoots });
        } catch (revokeError: unknown) {
          auditLifecycleWarning(source, runtimeRoot, "revoke-live-scopes", revokeError);
        }
        throw error;
      }
      const persisted = await addAllowedDirectoryPersist(runtimeRoot);
      allowWorkspaceRoot(runtimeRoot, source);
      return persisted;
    });
  }

  async function removePersistedWorkspaceRoot(
    root: string,
    source: string,
  ): Promise<WorkspaceRootRemoval | null> {
    const target = canonicalizePathForMatch(resolvePath(root));
    let grantResult: Awaited<ReturnType<typeof pruneWorkspaceRootGrants>> = {
      count: 0,
      audit: [],
    };
    let detachedSessions = 0;
    let liveScopesRevoked = 0;
    const execution = await removeWorkspaceRootWithIntent(target, {
      source,
      auditLogger,
      beforeRemove: async (runtimePath, context) => {
        grantResult = await pruneWorkspaceRootDurableScopes(
          runtimePath,
          source,
          context.preserveRoots,
        );
        return grantResult.count;
      },
      beforeComplete: async (runtimePath) => {
        detachedSessions = await detachWorkspaceRootSessionsBeforeRemoval(
          runtimePath,
          source,
        );
      },
      onInactive: async (intent, context) => {
        const finalized = await finalizeRemovedWorkspaceRoot(
          intent.runtimePath,
          source,
          context,
        );
        liveScopesRevoked = finalized.liveScopesRevoked;
      },
    });
    if (!execution) return null;
    return {
      storedPath: execution.intent.storedPath,
      runtimePath: execution.intent.runtimePath,
      persisted: readPermissionSettings().permissions.additionalDirectories,
      prunedGrants: execution.prunedGrants,
      prunedAudit: grantResult.audit,
      detachedSessions,
      liveScopesRevoked,
      cleanupPending: !execution.completed,
      operationId: execution.intent.operationId,
    };
  }

  const permissionDirectoryLifecycle = {
    allowDirectory: (root: string, source: "permission-slash") =>
      allowPersistedWorkspaceRoot(root, source),
    denyDirectory: async (root: string, source: "permission-slash") =>
      (await removePersistedWorkspaceRoot(root, source))?.persisted ??
        readPermissionSettings().permissions.additionalDirectories,
  };
  deps.workspaceRootLifecycle = permissionDirectoryLifecycle;
  if (deps.conversationLoop?.deps) {
    deps.conversationLoop.deps.workspaceRootLifecycle = permissionDirectoryLifecycle;
  }
  if (deps.sideChatConversationLoop) {
    deps.sideChatConversationLoop.deps.workspaceRootLifecycle = permissionDirectoryLifecycle;
  }



  /**
   * Persist a MAIN-OWNED directory path into `permissions.additionalDirectories`
   * (the executor's Layer-1 read allow-list SOT) after re-validating it. This is
   * the single choke point through which a folder pick widens the read scope.
   *
   *   1. `validateDirectoryAddition` — hard-refuses filesystem root / Layer 0
   *      sensitive dirs. Re-run even on the acknowledgement pass: a valid token
   *      clears adjacency warnings, NEVER a hard deny.
   *   2. `fs.stat` is-a-directory — re-run at THIS (ack/persist) pass, not only
   *      at prepare time. `dropPrepare` verified is-a-dir when it minted the
   *      token, but the entry could be swapped for a file/symlink between prepare
   *      and ack (a narrow TOCTOU). Re-checking here — the single choke point —
   *      also covers a native warned-pick whose target changed after the dialog.
   *   3. Persist, then audit the widening (redacted path) — the read scope grew,
   *      so the WRITE is recorded, mirroring the preview-read audit.
   *
   * `picked` is ALWAYS a path the main process owns (a `showOpenDialog` result or
   * the token-bound pending path) — never a raw renderer string.
   */
  async function persistValidatedRoot(
    picked: string,
    gesture: PickGesture,
  ): Promise<WorkspacePickRootResult> {
    const canonicalPicked = canonicalizePathForMatch(picked);
    const verdict = validateDirectoryAddition(canonicalPicked);
    if (!verdict.ok) {
      return { ok: false, error: directoryDenyCode(verdict.reason), warnings: verdict.adjacencyWarnings };
    }
    // Re-verify the path is STILL an existing directory at the moment of persist.
    // The is-a-dir check at prepare time can be invalidated by a swap-to-file /
    // swap-to-symlink race before the ack lands; a non-directory must never enter
    // the Layer-1 read allow-list.
    try {
      const stat = await fs.stat(canonicalPicked);
      if (!stat.isDirectory()) {
        return { ok: false, error: "not-a-dir", warnings: verdict.adjacencyWarnings };
      }
    } catch {
      return { ok: false, error: "not-found", warnings: verdict.adjacencyWarnings };
    }
    // Persist the identity that passed validation, freezing symlink aliases.
    try {
      await allowPersistedWorkspaceRoot(canonicalPicked, CHANNELS.workspace.pickRoot);
    } catch {
      return { ok: false, error: "persist-failed", warnings: verdict.adjacencyWarnings };
    }
    // Audit the allow-list widening: the permission SOT just grew the executor's
    // Layer-1 read scope. Mirrors the preview-read audit (redacted path via the
    // shared DLP filter) so a read-scope WRITE is recorded, not only READS. The
    // `gesture` marker distinguishes a native-picker widening from a drag-drop
    // widening (a renderer-named path) in the audit trail.
    auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: "workspace-pick-root",
      type: "info",
      input: JSON.stringify({
        channel: CHANNELS.workspace.pickRoot,
        path: opaqueWorkspaceRootAuditRef(picked),
        gesture,
      }),
    });
    return {
      ok: true,
      added: canonicalPicked,
      roots: computeRoots(),
      warnings: verdict.adjacencyWarnings,
    };
  }

  ipcMain.handle(CHANNELS.workspace.listRoots, async (e): Promise<WorkspaceListRootsResult> => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.workspace.listRoots, e);
      return { ok: false, error: "unauthorized" };
    }
    const reconciliation = await reconcileWorkspaceRoots({
      source: "list-roots",
      auditLogger,
      permissionManager: deps.conversationLoop?.permissionManager,
      beforeRemove: async (runtimeRoot, context) => {
        const grants = await pruneWorkspaceRootDurableScopes(
          runtimeRoot,
          CHANNELS.workspace.listRoots,
          context.preserveRoots,
        );
        return grants.count;
      },
      beforeComplete: async (runtimeRoot) => {
        await detachWorkspaceRootSessionsBeforeRemoval(
          runtimeRoot,
          CHANNELS.workspace.listRoots,
        );
      },
      onInactive: async (intent, context) => {
        await finalizeRemovedWorkspaceRoot(
          intent.runtimePath,
          CHANNELS.workspace.listRoots,
          context,
        );
      },
    });
    return {
      ok: true,
      defaultRoot: getDefaultWorkspaceRoot(),
      roots: computeRoots(),
      ...(reconciliation.pending?.length
        ? { cleanupPending: reconciliation.pending.length }
        : {}),
    };
  });

  ipcMain.handle(
    CHANNELS.workspace.pickRoot,
    async (e, opts?: { ackToken?: string }): Promise<WorkspacePickRootResult> => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.workspace.pickRoot, e);
        return { ok: false, error: "unauthorized" };
      }
      // Acknowledgement pass — the renderer presents the one-time token it was
      // handed on the initial warned pick (NOT an arbitrary path). We look the
      // token up, consume it (one-time — no replay), and persist the MAIN-OWNED
      // path it was bound to. A token the main process never minted (forged),
      // already spent, or past its TTL is refused — so a compromised renderer
      // cannot self-clear adjacency warnings for a directory of its own choosing
      // and silently widen the Layer-1 read allow-list. The re-validation inside
      // persistValidatedRoot still hard-refuses a Layer 0 / root path even with a
      // valid token (acknowledgement clears warnings, never a hard deny).
      const ackToken =
        typeof opts?.ackToken === "string" && opts.ackToken.length > 0 ? opts.ackToken : null;
      if (ackToken) {
        const now = Date.now();
        const pending = pendingPicks.get(ackToken);
        if (pending) pendingPicks.delete(ackToken); // consume regardless of validity
        if (!pending) return { ok: false, error: "ack-unknown" };
        if (now > pending.expires) return { ok: false, error: "ack-expired" };
        return persistValidatedRoot(pending.path, pending.gesture);
      }

      // Initial pick — the native folder picker IS the user gesture.
      const win = getMainWindow();
      const { filePaths, canceled } = win
        ? await dialog.showOpenDialog(win, {
            title: t("chatPreviewRail.pickRootTitle"),
            properties: ["openDirectory", "createDirectory"],
          })
        : await dialog.showOpenDialog({
            title: t("chatPreviewRail.pickRootTitle"),
            properties: ["openDirectory", "createDirectory"],
          });
      if (canceled || !filePaths[0]) return { ok: true, canceled: true, roots: computeRoots() };

      const dialogPath = filePaths[0];
      const verdict = validateDirectoryAddition(dialogPath);
      if (!verdict.ok) {
        return { ok: false, error: directoryDenyCode(verdict.reason), warnings: verdict.adjacencyWarnings };
      }
      if (verdict.adjacencyWarnings.length > 0) {
        // Withhold the pick: mint a one-time token bound to the MAIN-OWNED dialog
        // path and require the renderer to confirm by presenting the token. The
        // renderer never names the path that will ultimately be persisted.
        const now = Date.now();
        prunePendingPicks(now);
        const token = randomBytes(32).toString("base64url");
        pendingPicks.set(token, {
          path: dialogPath,
          expires: now + ACK_TOKEN_TTL_MS,
          gesture: "dialog",
        });
        return {
          ok: true,
          requiresAcknowledgement: true,
          pendingPath: dialogPath,
          ackToken: token,
          warnings: verdict.adjacencyWarnings,
          roots: computeRoots(),
        };
      }
      // No adjacency warnings — persist immediately (still audited).
      return persistValidatedRoot(dialogPath, "dialog");
    },
  );

  ipcMain.handle(
    CHANNELS.workspace.listDir,
    async (e, rawPath: string): Promise<WorkspaceListDirResult> => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.workspace.listDir, e);
        return { ok: false, error: "unauthorized", message: "sender frame not authorized" };
      }
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        return { ok: false, error: "not-a-dir", message: "path must be a non-empty string" };
      }
      const { cwd, extraAllowed } = currentScope();
      const verdict = assertReadableFilePath(rawPath, cwd, extraAllowed);
      if (!verdict.ok) {
        const error = verdict.error === "not-a-file" ? "not-a-dir" : verdict.error;
        return { ok: false, error, message: `scope guard rejected: ${verdict.error}` };
      }
      const dir = verdict.resolved;
      try {
        const stat = await fs.stat(dir);
        if (!stat.isDirectory()) {
          return { ok: false, error: "not-a-dir", path: dir, message: "not a directory" };
        }
        const dirents = await fs.readdir(dir, { withFileTypes: true });
        const entries: WorkspaceDirEntry[] = [];
        let truncated = false;
        for (const ent of dirents) {
          if (entries.length >= MAX_DIR_ENTRIES) {
            truncated = true;
            break;
          }
          const full = join(dir, ent.name);
          // Layer 0 filtering, identical to the read/list tools (file-tools.ts
          // walk): a `.env`/`.ssh`/`secrets`/… entry inside an allowed root is
          // never enumerated, so the browser can't surface a path the preview /
          // read_file guard would then hard-block.
          if (isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(full)))) continue;
          // Only surface plain files and directories; skip symlinks/sockets/etc
          // so a symlink can't advertise an out-of-scope target as an entry.
          if (ent.isFile()) entries.push({ name: ent.name, path: full, type: "file" });
          else if (ent.isDirectory()) entries.push({ name: ent.name, path: full, type: "directory" });
        }
        entries.sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return { ok: true, path: dir, entries, truncated };
      } catch (err) {
        return {
          ok: false,
          error: "read-failed",
          path: dir,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  /**
   * Remove a project root from `permissions.additionalDirectories` (the
   * executor's Layer-1 read allow-list SOT). Security: a removal can ONLY target
   * a path already present in that list — never an arbitrary renderer-supplied
   * path — and the default root (`process.cwd()`, which is not stored in the
   * list) can never be removed. Matching is canonical/case-folded so a trailing
   * slash or case variant of a stored path still resolves to its entry. The
   * shrink is audited, mirroring the widening audit in persistValidatedRoot: the
   * read scope narrowed, so the WRITE is recorded.
   */
  ipcMain.handle(
    CHANNELS.workspace.removeRoot,
    async (e, rawPath: string): Promise<WorkspaceRemoveRootResult> => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.workspace.removeRoot, e);
        return { ok: false, error: "unauthorized", message: "sender frame not authorized" };
      }
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        return { ok: false, error: "invalid-path", message: "path must be a non-empty string" };
      }
      const targetCanon = caseFoldForMatch(canonicalizePathForMatch(resolvePath(rawPath)));
      const defaultCanon = caseFoldForMatch(canonicalizePathForMatch(getDefaultWorkspaceRoot()));
      if (targetCanon === defaultCanon) {
        return { ok: false, error: "cannot-remove-default", message: "default root cannot be removed" };
      }
      let removal: WorkspaceRootRemoval | null;
      try {
        removal = await removePersistedWorkspaceRoot(rawPath, CHANNELS.workspace.removeRoot);
      } catch {
        return {
          ok: false,
          error: "lifecycle-failed",
          message: "workspace lifecycle update failed",
        };
      }
      if (!removal) {
        return { ok: false, error: "not-an-additional-root", message: "path is not a removable project root" };
      }
      // #1493 — the read allow-list just shrank, but path-scoped #1481 tier
      // grants (`rules[].tier` patterns of the form `<tool>:path:<absPath>`) for
      // files UNDER the removed root are a SEPARATE grant surface: without this
      // they stay orphaned and silently revive if the same root is re-added.
      // The active→pending cutover already made the root inaccessible; cleanup
      // failures remain journaled and do not re-add it to the UI/runtime.
      const prunedGrants = removal.prunedGrants;
      // #1494 item-4 — redacted per-pattern provenance for the success audit.
      // prunePathGrantsUnderRoot returns the pruned grant tuples; we keep the
      // count derivable (`.length`) for the IPC response + renderer toast, but
      // ALSO record which grants were revoked (tool name, tier, redacted path)
      // so forensics can see exactly what a root removal disowned. The pattern
      // list is audit-only — the IPC response still carries a bare number, so the
      // renderer is unchanged (No-Fallback: no renderer-side type widening).
      const prunedAudit = removal.prunedAudit;
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "workspace-remove-root",
        type: "info",
        input: JSON.stringify({
          channel: CHANNELS.workspace.removeRoot,
          path: opaqueWorkspaceRootAuditRef(removal.runtimePath),
          operationId: removal.operationId,
          cleanupPending: removal.cleanupPending,
          prunedGrants,
          detachedSessions: removal.detachedSessions,
          liveScopesRevoked: removal.liveScopesRevoked,
          // Redacted per-pattern tuples (empty when nothing pruned). Audit-only;
          // never returned to the renderer.
          ...(prunedAudit.length > 0 ? { prunedPatterns: prunedAudit } : {}),
        }),
      });
      return {
        ok: true,
        removed: removal.storedPath,
        roots: computeRoots(),
        prunedGrants,
        ...(removal.cleanupPending ? { cleanupPending: true } : {}),
      };
    },
  );

  /**
   * Reveal a file/folder in the OS file manager (Finder / Explorer). This is a
   * strictly WEAKER capability than "open": `showItemInFolder` only selects the
   * item's location, it never launches/executes it — consistent with the
   * `canOpenExternal:false` policy that deliberately disables the OS "open"
   * button in the preview pane.
   *
   * Trust boundary (identical to listDir): the renderer-supplied `rawPath` is
   * NOT trusted. `assertReadableFilePath` re-validates it against the SAME scope
   * (cwd + additionalDirectories), rejecting globs, Layer 0 sensitive paths, and
   * anything outside the allowed roots. Only `verdict.resolved` — the main-owned,
   * realpath'd, scope-checked absolute path — is ever handed to the shell, never
   * the raw renderer string.
   */
  ipcMain.handle(
    CHANNELS.workspace.reveal,
    async (e, rawPath: string): Promise<WorkspaceRevealResult> => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.workspace.reveal, e);
        return { ok: false, error: "unauthorized", message: "sender frame not authorized" };
      }
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        return { ok: false, error: "not-found", message: "path must be a non-empty string" };
      }
      const { cwd, extraAllowed } = currentScope();
      const verdict = assertReadableFilePath(rawPath, cwd, extraAllowed);
      if (!verdict.ok) {
        const error = verdict.error === "not-a-file" ? "not-found" : verdict.error;
        return { ok: false, error, message: `scope guard rejected: ${verdict.error}` };
      }
      const target = verdict.resolved;
      try {
        await fs.stat(target);
      } catch {
        return { ok: false, error: "not-found", message: "path no longer exists" };
      }
      shell.showItemInFolder(target);
      return { ok: true };
    },
  );

  /**
   * Drag-drop add-root, step 1 (#1458). A dropped folder path is renderer-NAMED
   * — the preload webUtils bridge turned a dropped `File` into a candidate path,
   * which carries no capability on its own. This handler is the trust gate that
   * gives the drop the SAME defense as the #1448 native warned-pick:
   *
   *   1. `validateSender` — a plugin-ui-shell / external frame is refused.
   *   2. `validateDirectoryAddition` — Layer-0 HARD-DENY (filesystem root /
   *      sensitive dir). An ack can NEVER clear a hard deny, so a dropped
   *      `~/.lvis/secrets` is rejected here and never reaches persistence.
   *   3. `fs.stat` is-a-directory — a dropped FILE is rejected (`not-a-dir`);
   *      the renderer never guesses a parent dir (No-Fallback).
   *
   * On success it mints a one-time ack token and stores it in `pendingPicks`
   * bound to the (renderer-NAMED) validated path. A drop ALWAYS requires
   * acknowledgement (even with zero adjacency warnings): unlike a native picker,
   * the OS dialog never vouched for the path, so the explicit user ack is that
   * missing vouch. The renderer confirms via `pickRoot({ ackToken })`, echoing
   * the MAIN-OWNED token — never a path. That is the actual trust model: the
   * path string is renderer-originated (the renderer chose which directory to
   * name), but the deny/persist decision is made entirely in main — Layer-0
   * hard-deny before any token is minted, an always-explicit user ack, and a
   * one-time main-owned token that binds the ack to the exact string validated
   * here. The renderer can never hand back an arbitrary path with
   * `acknowledge=true`: on the ack pass it presents the token, and main persists
   * the string the token was bound to (re-validated + re-stat'd), so the renderer
   * cannot substitute a different directory after the fact. The widening is
   * audited (`gesture:"drop"`).
   */
  ipcMain.handle(
    CHANNELS.workspace.dropPrepare,
    async (e, rawPath: string): Promise<WorkspaceDropPrepareResult> => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.workspace.dropPrepare, e);
        return { ok: false, error: "unauthorized" };
      }
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        return { ok: false, error: "invalid-path" };
      }
      // Layer-0 hard-deny FIRST — a sensitive/root path is refused outright and
      // no token is ever minted, so it can never be acknowledged into scope. The
      // deny surfaces a STABLE code (not the validator's English prose) so the
      // renderer can map it to Korean.
      const verdict = validateDirectoryAddition(rawPath);
      if (!verdict.ok) {
        return { ok: false, error: directoryDenyCode(verdict.reason), warnings: verdict.adjacencyWarnings };
      }
      // A dropped FILE is not a root — reject rather than inferring its parent.
      try {
        const stat = await fs.stat(rawPath);
        if (!stat.isDirectory()) return { ok: false, error: "not-a-dir" };
      } catch {
        return { ok: false, error: "not-found" };
      }
      // Mint a MAIN-OWNED ack token bound to the validated path. The path is now
      // owned by the main process; the renderer can only echo the token back.
      const now = Date.now();
      prunePendingPicks(now);
      const token = randomBytes(32).toString("base64url");
      pendingPicks.set(token, {
        path: rawPath,
        expires: now + ACK_TOKEN_TTL_MS,
        gesture: "drop",
      });
      return {
        ok: true,
        pendingPath: rawPath,
        ackToken: token,
        warnings: verdict.adjacencyWarnings,
      };
    },
  );
}
