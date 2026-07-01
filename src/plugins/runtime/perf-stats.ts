/**
 * Per-plugin performance statistics.
 *
 * `PerfStatsTracker` owns the perf accounting Map and exposes the exact same
 * numbers the runtime previously computed inline. Deliberately NOT cleared by
 * `PluginRuntime.resetLoadedState()` — perf history survives a restart cycle,
 * matching the pre-extraction behavior.
 */

/**
 * Per-plugin performance statistics collected at runtime.
 */
export interface PluginPerfStats {
  startupMs: number;
  toolCallCount: number;
  errorCount: number;
  totalExecMs: number;
  lastCallAt: number | null;
}

function zeroed(startupMs = 0): PluginPerfStats {
  return { startupMs, toolCallCount: 0, errorCount: 0, totalExecMs: 0, lastCallAt: null };
}

export class PerfStatsTracker {
  private readonly stats = new Map<string, PluginPerfStats>();

  has(pluginId: string): boolean {
    return this.stats.has(pluginId);
  }

  /** Create a zeroed entry if none exists yet. No-op when already present. */
  ensure(pluginId: string): void {
    if (!this.stats.has(pluginId)) {
      this.stats.set(pluginId, zeroed());
    }
  }

  /** Set `startupMs` on an existing entry. No-op when the entry is absent. */
  setStartupMs(pluginId: string, startupMs: number): void {
    const stats = this.stats.get(pluginId);
    if (stats) stats.startupMs = startupMs;
  }

  /**
   * Record a startup measurement: create the entry (seeded with `startupMs`)
   * when absent, otherwise overwrite only `startupMs` on the existing entry.
   */
  recordStartup(pluginId: string, startupMs: number): void {
    const existing = this.stats.get(pluginId);
    if (!existing) {
      this.stats.set(pluginId, zeroed(startupMs));
    } else {
      existing.startupMs = startupMs;
    }
  }

  /**
   * Account the start of a tool call: get-or-create the entry, bump
   * `toolCallCount`, stamp `lastCallAt`, and return the live entry so the
   * caller can finalize `errorCount` / `totalExecMs` around the invocation.
   */
  beginCall(pluginId: string): PluginPerfStats {
    let stats = this.stats.get(pluginId);
    if (!stats) {
      stats = zeroed();
      this.stats.set(pluginId, stats);
    }
    stats.toolCallCount += 1;
    stats.lastCallAt = Date.now();
    return stats;
  }

  /** Deep-copied snapshot — mutations by callers never affect internal state. */
  snapshot(): Record<string, PluginPerfStats> {
    const result: Record<string, PluginPerfStats> = {};
    for (const [id, stats] of this.stats) {
      result[id] = { ...stats };
    }
    return result;
  }
}
