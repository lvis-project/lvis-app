import { useEffect, useRef } from "react";
import { isDarwin } from "../api-client.js";

/**
 * Keyboard bindings for visit history.
 *
 * The chord is platform-dependent for a concrete reason, not for taste: on
 * macOS `Option`+←/→ is word-wise caret movement inside text fields, so
 * binding it globally would break editing in the composer. macOS therefore
 * gets its conventional `Cmd`+`[` / `Cmd`+`]`; Windows and Linux get the
 * `Alt`+←/→ they expect.
 *
 * Either way the chord is ignored while an editable element has focus. That
 * guard is new here — the existing global shortcuts do not have one — because
 * navigating away mid-sentence is the worst outcome this feature can produce.
 */
export interface ViewHistoryShortcutHandlers {
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
}

/** True when the keystroke belongs to whatever the user is typing into. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return el.isContentEditable === true;
}

/**
 * Which navigation a keystroke asks for, or null. Exported so the decision can
 * be tested directly on both platforms without synthesizing a whole app.
 */
export function viewHistoryIntent(
  event: Pick<KeyboardEvent, "key" | "altKey" | "metaKey" | "ctrlKey" | "shiftKey">,
  darwin: boolean,
): "back" | "forward" | null {
  if (event.shiftKey) return null;
  if (darwin) {
    if (!event.metaKey || event.altKey || event.ctrlKey) return null;
    if (event.key === "[") return "back";
    if (event.key === "]") return "forward";
    return null;
  }
  if (!event.altKey || event.metaKey || event.ctrlKey) return null;
  if (event.key === "ArrowLeft") return "back";
  if (event.key === "ArrowRight") return "forward";
  return null;
}

export function useViewHistoryShortcuts(handlers: ViewHistoryShortcutHandlers): void {
  // Stable ref so the listener attaches once instead of re-binding on every
  // navigation (the handlers change identity whenever history moves).
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const darwin = isDarwin();
    const onKey = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const intent = viewHistoryIntent(event, darwin);
      if (!intent) return;
      const current = handlersRef.current;
      if (intent === "back" && current.canGoBack) {
        event.preventDefault();
        current.goBack();
      } else if (intent === "forward" && current.canGoForward) {
        event.preventDefault();
        current.goForward();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
