/**
 * Permission policy Phase 4 — Manifest integrity proxy (§3.5).
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3.5.
 *
 * Plugins declare a `category` per tool in `plugin.json`. When the
 * declared category is `read`, the host expects the plugin tool to be
 * non-mutating. This module provides a runtime sanity-check: a thin
 * proxy over `node:fs` whose write methods throw a synchronous
 * {@link ManifestIntegrityViolation}. The runtime catches the throw,
 * audits it, disables the offending plugin, and surfaces an IPC
 * notification to the renderer.
 *
 * Trade-off (acknowledged):
 *   A plugin that imports `node:fs` directly (rather than reading the
 *   `fs` member off its execute context) bypasses this guard. v1 is a
 *   *partial* runtime guard — the comprehensive solution lands in plugin-sandbox follow-up
 *   when the plugin runtime moves into a V8 isolated context.
 *
 * Disable semantics:
 *   - On violation, the plugin id is added to the
 *     {@link ManifestIntegrityState.disabledPluginIds} set so the next
 *     tool dispatch refuses the call (categoryBasedDecision sees the
 *     disabled flag and returns deny).
 *   - The renderer IPC `lvis:permissions:manifest-violation` channel
 *     surfaces the violation with the plugin id so the user can
 *     confirm a reinstall.
 *   - Audit log entry: `{ kind: "manifest_integrity_violation",
 *                         pluginId, toolName, attempted: <method> }`.
 */
import type { AuditLogger } from "../audit/audit-logger.js";
import { createLogger } from "../lib/logger.js";
import { randomUUID } from "node:crypto";

const log = createLogger("manifest-integrity");

/** Methods of `node:fs` that mutate the filesystem (write side). */
export const READ_ONLY_FS_DENY_METHODS: ReadonlySet<string> = new Set([
  // sync writes
  "writeFileSync",
  "appendFileSync",
  "mkdirSync",
  "rmdirSync",
  "unlinkSync",
  "rmSync",
  "renameSync",
  "copyFileSync",
  "symlinkSync",
  "chmodSync",
  "chownSync",
  "linkSync",
  "truncateSync",
  "ftruncateSync",
  "utimesSync",
  "futimesSync",
  "writeSync",
  // async (callback)
  "writeFile",
  "appendFile",
  "mkdir",
  "rmdir",
  "unlink",
  "rm",
  "rename",
  "copyFile",
  "symlink",
  "chmod",
  "chown",
  "link",
  "truncate",
  "ftruncate",
  "utimes",
  "futimes",
  "write",
  // streams
  "createWriteStream",
  // dir / open
  "open",
  "openSync",
  // promises (createReadOnlyFsPromisesProxy mirrors these — the same
  // names live there too).
]);

export class ManifestIntegrityViolation extends Error {
  readonly code = "MANIFEST_INTEGRITY_VIOLATION" as const;

  constructor(
    public readonly pluginId: string,
    public readonly toolName: string,
    public readonly attemptedMethod: string,
  ) {
    super(
      `Plugin '${pluginId}' tool '${toolName}' violated manifest integrity by ` +
      `attempting '${attemptedMethod}'. Plugin disabled — reinstall required.`,
    );
    this.name = "ManifestIntegrityViolation";
  }
}

/**
 * Build a Proxy that wraps a real `fs` module. Reading members is
 * allowed; calling any method in {@link READ_ONLY_FS_DENY_METHODS}
 * throws {@link ManifestIntegrityViolation} *synchronously* — the
 * caller's audit + disable hooks fire before the promise/callback
 * orchestration starts.
 *
 * Caller passes the {pluginId, toolName} so the violation message
 * carries enough context to drive the disable + IPC flow.
 */
export function createReadOnlyFsProxy(
  realFs: Record<string, unknown>,
  ctx: { pluginId: string; toolName: string },
): Record<string, unknown> {
  return new Proxy(realFs, {
    get(target, prop, receiver) {
      const key = typeof prop === "symbol" ? prop.description ?? "" : String(prop);
      if (READ_ONLY_FS_DENY_METHODS.has(key)) {
        // Return a function so the caller fails inside the call site
        // (preserving stack trace context) rather than at property
        // lookup time. Some callers do `const w = fs.writeFile;` then
        // call `w(...)`; we want the throw to fire at the *call*.
        return (..._args: unknown[]) => {
          throw new ManifestIntegrityViolation(ctx.pluginId, ctx.toolName, key);
        };
      }
      // Pass through everything else (read methods, constants, …).
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * Mirror of {@link createReadOnlyFsProxy} for the `fs/promises` API.
 * Same deny-list, but every guarded member is *async-throw* (returns a
 * rejected promise) — matches the upstream contract where promise
 * methods don't synchronously throw.
 */
export function createReadOnlyFsPromisesProxy(
  realFsPromises: Record<string, unknown>,
  ctx: { pluginId: string; toolName: string },
): Record<string, unknown> {
  return new Proxy(realFsPromises, {
    get(target, prop, receiver) {
      const key = typeof prop === "symbol" ? prop.description ?? "" : String(prop);
      if (READ_ONLY_FS_DENY_METHODS.has(key)) {
        return async (..._args: unknown[]) => {
          throw new ManifestIntegrityViolation(ctx.pluginId, ctx.toolName, key);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * Process-wide state — set of plugin ids that violated their
 * declared `read` category. Disabled plugins fail-deny on every
 * subsequent tool dispatch.
 */
export class ManifestIntegrityState {
  private readonly disabledPluginIds = new Set<string>();
  private readonly listeners = new Set<(pluginId: string, toolName: string, attemptedMethod: string) => void | Promise<void>>();

  isDisabled(pluginId: string): boolean {
    return this.disabledPluginIds.has(pluginId);
  }

  /** Add a violator. Idempotent. */
  async recordViolation(pluginId: string, toolName: string, attemptedMethod: string): Promise<void> {
    this.disabledPluginIds.add(pluginId);
    const failures: unknown[] = [];
    for (const listener of this.listeners) {
      try {
        await listener(pluginId, toolName, attemptedMethod);
      } catch (err) {
        log.warn(
          "manifest-integrity: listener threw: %s",
          (err as Error).message,
        );
        failures.push(err);
      }
    }
    if (failures.length > 0) {
      throw failures[0];
    }
  }

  /** Subscribe to violation events. Returns disposer. */
  onViolation(
    listener: (pluginId: string, toolName: string, attemptedMethod: string) => void | Promise<void>,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Test helper. */
  resetForTests(): void {
    this.disabledPluginIds.clear();
    this.listeners.clear();
  }

  /** Diagnostic — list disabled plugin ids. */
  listDisabled(): string[] {
    return [...this.disabledPluginIds];
  }
}

/** Process-wide singleton. */
export const manifestIntegrityState = new ManifestIntegrityState();

/**
 * Wire an audit logger to record every violation. Idempotent —
 * subsequent calls replace the prior subscription. Returns disposer.
 */
export function bindManifestIntegrityAudit(
  audit: AuditLogger,
  state: ManifestIntegrityState = manifestIntegrityState,
): () => void {
  return state.onViolation(async (pluginId, toolName, attemptedMethod) => {
    try {
      audit.log({
        timestamp: new Date().toISOString(),
        sessionId: "manifest-integrity",
        type: "error",
        input: JSON.stringify({
          kind: "manifest_integrity_violation",
          pluginId,
          toolName,
          attempted: attemptedMethod,
        }),
      });
    } catch (err) {
      log.warn(
        "manifest-integrity audit write failed: %s",
        (err as Error).message,
      );
      throw err;
    }
    if (audit.isPermissionAuditChainReady()) {
      await audit.appendPermissionAuditEntry({
        ts: new Date().toISOString(),
        auditId: randomUUID(),
        trustOrigin: "plugin-emitted",
        decision: "manifest_violation",
        pluginId,
        toolName,
        attemptedOperation: attemptedMethod,
      });
    }
  });
}
