/**
 * E4 — global-shortcut settings SoT (pure, zero-import).
 *
 * Lives in `src/shared/` so BOTH the settings store (main-process patch
 * validation) and the renderer StartupTab (accelerator capture UX) enforce the
 * same accelerator-shape contract without pulling `electron`. Electron's own
 * `globalShortcut.register` Accelerator parser remains the runtime SoT for
 * whether an accelerator actually binds — this module only rejects obviously
 * malformed strings at the trust boundary so a corrupt settings.json / crafted
 * IPC payload never reaches `globalShortcut.register`.
 */

/** Persisted global-shortcut block. */
export interface ShortcutSettings {
  /**
   * Accelerator string for the show/hide window toggle, in Electron
   * Accelerator syntax (e.g. `"CommandOrControl+Shift+Space"`), or `null` when
   * the user has not chosen a combination. `null` + `enabled:true` registers
   * nothing (there is no accelerator to bind).
   */
  toggleWindow: string | null;
  /** Master on/off for global shortcut registration. Default `false`. */
  enabled: boolean;
}

/** Patch shape — every field optional so a UI save can touch one field. */
export interface ShortcutSettingsPatch {
  toggleWindow?: string | null;
  enabled?: boolean;
}

const MAX_ACCELERATOR_LEN = 128;

/**
 * Reject ASCII control chars (C0 0x00–0x1F + DEL 0x7F). A valid accelerator is
 * printable modifier/key tokens joined by '+'.
 */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Electron Accelerator modifier tokens — a lone modifier is not bindable. */
const MODIFIERS: ReadonlySet<string> = new Set([
  "command", "cmd", "control", "ctrl", "commandorcontrol", "cmdorctrl",
  "alt", "option", "altgr", "shift", "super", "meta",
]);

/**
 * Validate an accelerator string's shape. Returns the trimmed string when it is
 * plausibly a valid Electron accelerator, else `null`. Callers treat `null` as
 * "reject / keep previous value" (No-Fallback: reject at the boundary rather
 * than persist a bad value and drop it later).
 *
 * This is a superset shape-check, NOT a full grammar: `globalShortcut.register`
 * is the authority on whether the string binds. We reject empty / oversized /
 * control-char inputs, strings with an empty '+'-segment, and lone modifiers.
 */
export function normalizeAccelerator(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ACCELERATOR_LEN) return null;
  if (hasControlChars(trimmed)) return null;
  const parts = trimmed.split("+").map((p) => p.trim());
  if (parts.some((p) => p.length === 0)) return null;
  const key = parts[parts.length - 1];
  if (MODIFIERS.has(key.toLowerCase())) return null;
  return trimmed;
}

/** Coerce an unknown `shortcuts` block to a complete {@link ShortcutSettings}. */
export function normalizeShortcuts(
  input: unknown,
  fallback: ShortcutSettings,
): ShortcutSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...fallback };
  }
  const obj = input as { toggleWindow?: unknown; enabled?: unknown };
  const result: ShortcutSettings = { ...fallback };
  if (obj.toggleWindow === null) {
    result.toggleWindow = null;
  } else if (obj.toggleWindow !== undefined) {
    const accel = normalizeAccelerator(obj.toggleWindow);
    // Invalid accelerator: keep the fallback value rather than clobber it.
    if (accel !== null) result.toggleWindow = accel;
  }
  if (typeof obj.enabled === "boolean") {
    result.enabled = obj.enabled;
  }
  return result;
}
