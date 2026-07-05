/**
 * E4 — translate a renderer KeyboardEvent into an Electron Accelerator string.
 *
 * Pure + DOM-KeyboardEvent-shaped (accepts anything with the modifier booleans
 * + `key`), so it's testable without React. Returns `null` for a modifier-only
 * press (the capture UI keeps waiting for a real key). The result still passes
 * through `normalizeAccelerator` at the call site as the final gate.
 *
 * We build `CommandOrControl` (rather than platform-specific `Command`/`Control`)
 * for the primary modifier so a captured accelerator is portable across macOS
 * and Windows/Linux — matching how the default suggestion is expressed.
 */

/** Minimal shape of the fields we read — DOM + React SyntheticEvent compatible. */
export interface AcceleratorKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const MODIFIER_KEYS = new Set([
  "Control", "Shift", "Alt", "Meta", "OS", "AltGraph", "CapsLock",
]);

/** Map a `KeyboardEvent.key` to an Electron accelerator key token. */
function keyToken(key: string): string | null {
  if (key === " " || key === "Spacebar") return "Space";
  if (key === "Escape") return "Esc";
  if (key === "ArrowUp") return "Up";
  if (key === "ArrowDown") return "Down";
  if (key === "ArrowLeft") return "Left";
  if (key === "ArrowRight") return "Right";
  if (key === "+") return "Plus";
  // Single printable char → uppercase (Electron accepts a-z/0-9 case-insensitively).
  if (key.length === 1) return key.toUpperCase();
  // Named keys already in Electron form (F1–F24, Tab, Enter, Home, End, PageUp,
  // PageDown, Delete, Backspace, etc.) pass through verbatim.
  return key;
}

/**
 * Build an Electron accelerator from a key event, or `null` if the event is a
 * bare modifier press.
 */
export function eventToAccelerator(e: AcceleratorKeyEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const token = keyToken(e.key);
  if (token === null || token.length === 0) return null;

  const parts: string[] = [];
  // `CommandOrControl` collapses Cmd (mac) / Ctrl (win/linux) into one portable
  // token. If both meta and ctrl are somehow held, one CommandOrControl covers it.
  if (e.metaKey || e.ctrlKey) parts.push("CommandOrControl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(token);
  return parts.join("+");
}
