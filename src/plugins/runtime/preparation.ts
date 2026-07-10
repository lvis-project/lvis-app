/**
 * Dependency-preparation lifecycle for deferred plugin starts.
 *
 * `PreparationTracker` owns the MONOTONIC preparation generation counter plus
 * every map/set that tracks an in-flight `preparePluginStart` gate:
 * preparing ids, per-plugin status, failures, and pending prepared-start
 * handles. It calls back into the runtime for the three effects it cannot own
 * itself — `instantiateAndStartSinglePlugin`, `markFailed`, and `onDisable` —
 * which are injected at construction.
 *
 * Generation semantics: each defer/cancel/reset bumps the counter and stamps
 * the plugin's generation. Any in-flight task that observes a generation
 * mismatch is stale and silently aborts, so a reset that rejects pending
 * readiness promises BEFORE clearing the maps (see {@link clear}) can never be
 * clobbered by a late-arriving prepared start.
 */
import { dirname } from "node:path";
import type { PluginAccessSpec, PluginManifest } from "../types.js";
import type { ManifestLoadPlan, SinglePluginStartResult } from "./types.js";
import type {
  PluginPreparationProgressInput,
  PluginPreparationStatus,
  PluginStartPreparationContext,
} from "./index.js";
import { plog, PluginPhase } from "../lifecycle-log.js";
import { t } from "../../i18n/index.js";

interface PendingPreparedStart {
  generation: number;
  task: Promise<void>;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (err: Error) => void;
}

interface PreparationTrackerDeps {
  preparePluginStart?: (
    context: PluginStartPreparationContext,
  ) => Promise<void> | void | null | undefined;
  instantiateAndStartSinglePlugin: (
    plan: ManifestLoadPlan,
    manifest: PluginManifest,
    approvedPluginAccess: PluginAccessSpec | undefined,
    opts: { skipPreparation?: boolean; cacheBust?: boolean; shouldCommit?: () => boolean },
  ) => Promise<SinglePluginStartResult>;
  markFailed: (pluginId: string, stub?: { name: string; description: string }) => void;
  onDisable?: (pluginId: string) => void;
}

export class PreparationTracker {
  private readonly preparingPluginIds = new Set<string>();
  private readonly preparationStatuses = new Map<string, PluginPreparationStatus>();
  private readonly preparationFailures = new Map<string, string>();
  private readonly pendingPreparedStarts = new Map<string, PendingPreparedStart>();
  private readonly preparationGenerations = new Map<string, number>();
  private nextPreparationGeneration = 0;

  constructor(private readonly deps: PreparationTrackerDeps) {}

  /**
   * Attempt to defer a plugin's start behind its `preparePluginStart` gate.
   * Returns `true` when the start was deferred (an async preparation is now
   * pending, or preparation failed synchronously) and `false` when no
   * preparation applies and the caller should start the plugin inline.
   */
  deferStart(
    plan: ManifestLoadPlan,
    manifest: PluginManifest,
    approvedPluginAccess: PluginAccessSpec | undefined,
    startOpts: { cacheBust?: boolean } = {},
  ): boolean {
    if (!this.deps.preparePluginStart) return false;
    if (this.pendingPreparedStarts.has(manifest.id)) return true;
    const pluginRoot = dirname(plan.manifestPath);
    const generation = ++this.nextPreparationGeneration;
    this.preparationGenerations.set(manifest.id, generation);
    let result: Promise<void> | void | null | undefined;
    try {
      result = this.deps.preparePluginStart({
        pluginId: manifest.id,
        manifest,
        manifestPath: plan.manifestPath,
        pluginRoot,
        reportProgress: (status) => this.setStatus(manifest.id, status, generation),
      });
    } catch (err) {
      this.markPreparationFailed(manifest, err);
      return true;
    }
    if (!result || typeof (result as Promise<void>).then !== "function") {
      this.preparationStatuses.delete(manifest.id);
      return false;
    }

    this.preparingPluginIds.add(manifest.id);
    this.preparationFailures.delete(manifest.id);
    if (!this.preparationStatuses.has(manifest.id)) {
      this.setStatus(manifest.id, {
        phase: "pending",
        message: t("be_runtimeIndex.preparingRuntimeMessage"),
        progressPct: 5,
      }, generation);
    }
    let resolveReady!: () => void;
    let rejectReady!: (err: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const task = Promise.resolve(result)
      .then(async () => {
        if (this.preparationGenerations.get(manifest.id) !== generation) return;
        const startResult = await this.deps.instantiateAndStartSinglePlugin(plan, manifest, approvedPluginAccess, {
          skipPreparation: true,
          cacheBust: startOpts.cacheBust,
          shouldCommit: () => this.preparationGenerations.get(manifest.id) === generation,
        });
        if (this.preparationGenerations.get(manifest.id) !== generation) {
          return;
        }
        if (startResult !== "started") {
          const err = new Error(`plugin '${manifest.id}' failed to start after runtime dependencies were prepared`);
          this.markPreparationFailed(manifest, err);
          rejectReady(err);
          return;
        }
        this.preparingPluginIds.delete(manifest.id);
        this.preparationStatuses.delete(manifest.id);
        this.preparationFailures.delete(manifest.id);
        resolveReady();
      })
      .catch((err: unknown) => {
        if (this.preparationGenerations.get(manifest.id) !== generation) return;
        this.markPreparationFailed(manifest, err);
        rejectReady(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (this.pendingPreparedStarts.get(manifest.id)?.generation === generation) {
          this.pendingPreparedStarts.delete(manifest.id);
        }
      });
    this.pendingPreparedStarts.set(manifest.id, { generation, task, ready, resolveReady, rejectReady });
    void ready.catch(() => {});
    return true;
  }

  private setStatus(pluginId: string, status: PluginPreparationProgressInput, generation: number): void {
    if (this.preparationGenerations.get(pluginId) !== generation) return;
    const progressPct = typeof status.progressPct === "number"
      ? Math.max(0, Math.min(100, Math.round(status.progressPct)))
      : undefined;
    this.preparationStatuses.set(pluginId, {
      phase: status.phase,
      message: status.message,
      progressPct,
      updatedAt: new Date().toISOString(),
    });
  }

  private markPreparationFailed(manifest: PluginManifest, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.preparingPluginIds.delete(manifest.id);
    this.preparationStatuses.delete(manifest.id);
    this.preparationFailures.set(manifest.id, message);
    this.deps.markFailed(manifest.id, {
      name: manifest.name ?? manifest.id,
      description: `Plugin dependencies failed: ${message}`,
    });
    this.deps.onDisable?.(manifest.id);
    plog("error", { pluginId: manifest.id, phase: PluginPhase.START_FAIL, reason: message }, "plugin dependency preparation failed");
  }

  /** Cancel and forget a single plugin's preparation state (uninstall path). */
  clearFor(pluginId: string): void {
    const pending = this.pendingPreparedStarts.get(pluginId);
    pending?.rejectReady(new Error(`plugin '${pluginId}' runtime dependency preparation was cancelled`));
    this.preparationGenerations.set(pluginId, ++this.nextPreparationGeneration);
    this.preparingPluginIds.delete(pluginId);
    this.preparationStatuses.delete(pluginId);
    this.preparationFailures.delete(pluginId);
    this.pendingPreparedStarts.delete(pluginId);
  }

  /**
   * Readiness promise for a plugin that is preparing (not yet loaded). The
   * caller is responsible for the already-loaded fast path.
   */
  waitForReady(pluginId: string): Promise<void> {
    const pending = this.pendingPreparedStarts.get(pluginId);
    if (pending) {
      return pending.ready;
    }
    const failure = this.preparationFailures.get(pluginId);
    if (failure) return Promise.reject(new Error(failure));
    return Promise.reject(new Error(`plugin '${pluginId}' is not preparing or loaded`));
  }

  isPreparing(pluginId: string): boolean {
    return this.preparingPluginIds.has(pluginId);
  }

  preparingIds(): IterableIterator<string> {
    return this.preparingPluginIds.values();
  }

  getStatus(pluginId: string): PluginPreparationStatus | undefined {
    return this.preparationStatuses.get(pluginId);
  }

  getFailure(pluginId: string): string | undefined {
    return this.preparationFailures.get(pluginId);
  }

  /**
   * Runtime-reset clear: reject every pending readiness promise and bump its
   * generation BEFORE clearing the maps, so no in-flight prepared start can
   * resurrect state after the reset.
   */
  clear(): void {
    for (const [pluginId, pending] of this.pendingPreparedStarts) {
      pending.rejectReady(new Error(`plugin '${pluginId}' runtime dependency preparation was cancelled by runtime reset`));
      this.preparationGenerations.set(pluginId, ++this.nextPreparationGeneration);
    }
    this.preparingPluginIds.clear();
    this.preparationStatuses.clear();
    this.preparationFailures.clear();
    this.pendingPreparedStarts.clear();
    this.preparationGenerations.clear();
  }
}
