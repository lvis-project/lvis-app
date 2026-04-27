/**
 * TaskSourceRegistry — plugin self-registration for task categories.
 *
 * Plugins declare their category labels at load time via HostApi.addTask.
 * Legacy closed-union values (email/meeting/calendar/teams/manual) are seeded
 * as "legacy" entries so existing DB records continue to display correctly.
 */

export type TaskSourceOrigin = "host-default" | "legacy" | "plugin";

export interface TaskSourceCategory {
  id: string;
  origin: TaskSourceOrigin;
  /** The plugin that registered this category (plugin origin only). */
  pluginId?: string;
  /** Human-readable label (Korean UI). Falls back to `id` when absent. */
  label?: string;
}

export class TaskSourceRegistry {
  private readonly entries = new Map<string, TaskSourceCategory>();

  constructor() {
    // Host-owned defaults
    this.entries.set("manual", { id: "manual", origin: "host-default", label: "직접" });
    this.entries.set("host", { id: "host", origin: "host-default", label: "시스템" });
    // Legacy closed-union values — seeded for backward compat with stored tasks
    for (const id of ["email", "meeting", "calendar", "teams"]) {
      this.entries.set(id, { id, origin: "legacy" });
    }
  }

  /**
   * Register a category. If the id is already registered (including legacy
   * seeds), the entry is upgraded in-place so plugins can supply a label for
   * previously label-less legacy seeds without creating a duplicate.
   */
  register(category: TaskSourceCategory): void {
    const existing = this.entries.get(category.id);
    if (existing) {
      // Allow plugin to enrich a legacy seed with a label
      if (existing.origin === "legacy" && category.origin === "plugin") {
        this.entries.set(category.id, { ...existing, ...category });
      }
      return;
    }
    this.entries.set(category.id, category);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): TaskSourceCategory | undefined {
    return this.entries.get(id);
  }

  list(): TaskSourceCategory[] {
    return [...this.entries.values()];
  }
}

/**
 * Derive a stable category ID for a plugin's addTask call.
 *
 * - If the plugin supplied an explicit source string, use it verbatim.
 * - Otherwise derive from the last segment of the plugin's dotted ID
 *   (e.g. "com.lge.meeting-recorder" → "meeting-recorder").
 */
export function deriveCategoryId(pluginId: string, explicitSource: unknown): string {
  // Guard against non-string inputs — a buggy plugin might pass a number or
  // object (e.g. `addTask({ source: { name: "x" } })`). The previous
  // truthy + `.trim()` shape would throw on those. Only trust strings.
  if (typeof explicitSource === "string" && explicitSource.trim()) {
    return explicitSource.trim();
  }
  const parts = pluginId.split(".");
  return parts[parts.length - 1] ?? pluginId;
}
