/**
 * Plugin config-override store.
 *
 * `ConfigOverrideStore` owns the `pluginId → config` override map (including
 * the `"*"` wildcard slot) and centralizes the set/merge/clear semantics the
 * runtime previously implemented inline. Deliberately NOT cleared by
 * `PluginRuntime.resetLoadedState()` — overrides survive a restart cycle.
 */
export class ConfigOverrideStore {
  private readonly overrides: Record<string, Record<string, unknown>>;

  constructor(initial: Record<string, Record<string, unknown>> = {}) {
    this.overrides = initial;
  }

  /**
   * Live reference to the override map — used to build plugin sandbox context.
   * Callers MUST treat it as read-only.
   */
  all(): Record<string, Record<string, unknown>> {
    return this.overrides;
  }

  /** Replace a plugin's overrides (empty config clears the entry). */
  set(pluginId: string, config: Record<string, unknown>): void {
    if (Object.keys(config).length === 0) {
      delete this.overrides[pluginId];
      return;
    }
    this.overrides[pluginId] = { ...config };
  }

  /** Merge into a plugin's existing overrides (empty config is a no-op). */
  merge(pluginId: string, config: Record<string, unknown>): void {
    if (Object.keys(config).length === 0) return;
    this.overrides[pluginId] = {
      ...(this.overrides[pluginId] ?? {}),
      ...config,
    };
  }

  /** Merge into the wildcard (`"*"`) slot (empty config is a no-op). */
  setWildcard(config: Record<string, unknown>): void {
    if (Object.keys(config).length === 0) return;
    this.overrides["*"] = {
      ...(this.overrides["*"] ?? {}),
      ...config,
    };
  }

  /** Shallow copy of the wildcard slot; callers MUST NOT mutate the result. */
  getWildcard(): Record<string, unknown> {
    return { ...(this.overrides["*"] ?? {}) };
  }

  /** Clear ONLY the named keys from the wildcard slot (empty `keys` no-op). */
  clearWildcard(keys: string[]): void {
    const current = this.overrides["*"];
    if (!current) return;
    for (const key of keys) {
      delete current[key];
    }
    if (Object.keys(current).length === 0) {
      delete this.overrides["*"];
    }
  }

  /** Drop a plugin's overrides entirely (uninstall path). */
  delete(pluginId: string): void {
    delete this.overrides[pluginId];
  }
}
