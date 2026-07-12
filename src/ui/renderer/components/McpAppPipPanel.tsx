/**
 * McpAppPipPanel — the in-page, draggable picture-in-picture surface for an MCP-app
 * card that requested (or was moved into) `pip`.
 *
 * ─── Why in-page, not an OS window ────────────────────────────────────────────
 * Surveyed prior art (goose — an Electron desktop MCP host, our closest structural
 * analog) realizes `pip` exactly this way: an in-page draggable panel, keeping the
 * SAME container and swapping presentation via CSS rather than remounting. goose
 * DOES have a real OS `BrowserWindow` for MCP apps, but calls it `standalone` — a
 * goose-only name OUTSIDE the spec vocabulary, launched from an app launcher rather
 * than `ui/request-display-mode`, with display-mode negotiation disabled inside it.
 * ChatGPT's `pip` is a floating window INSIDE ChatGPT, not an OS window. The ext-apps
 * reference host doesn't implement `pip` at all. No surveyed host maps `pip` onto an
 * OS-level always-on-top window — so this one doesn't either.
 *
 * ─── Why this remounts the card (does not carry the same <webview> across modes) ──
 * Ideally the SAME `<webview>` would survive an inline<->pip move (goose's approach,
 * and the reason ChatGPT's remount-on-mode-change is called out as a known bug
 * there — it re-triggers the tool call and resets widget state). That requires
 * either portaling the SAME DOM node between containers, or a single, ALWAYS-mounted
 * overlay layer with CSS-only repositioning (an anchor-tracking "floating UI" system).
 * Verified empirically (a throwaway React-portal probe): swapping a portal's TARGET
 * container does NOT preserve the DOM node — React unmounts and recreates it, which
 * would force the Electron `<webview>` guest to reload regardless. The anchor-
 * tracking alternative avoids that, but is a materially larger subsystem (tracking a
 * transcript card's on-screen position through scroll/resize to keep an
 * always-mounted overlay visually aligned with it) than this feature's scope. So:
 * this card, like the existing inline<->fullscreen transition, REMOUNTS on every
 * move — a fresh bridge + <webview>, app state does not survive the move. Eyes open.
 *
 * Renders nothing when no card occupies the pip slot (`getPipOccupant`). One
 * McpAppView instance per occupant, keyed by `cardId` so a DIFFERENT card claiming
 * the slot is a clean remount, never a payload swap on a stale instance.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { GripHorizontal, X } from "lucide-react";
import { McpAppView } from "./McpAppView.js";
import { useTranslation } from "../../../i18n/react.js";
import {
  getPipOccupant,
  reviveCardIfAt,
  subscribePipOccupant,
} from "../state/mcp-app-card-location-store.js";

/** Panel chrome default size — mirrors goose's PIP_WIDTH/PIP_HEIGHT convention. */
const PIP_WIDTH = 400;
const PIP_HEIGHT = 300;
const PIP_MARGIN = 16;
/** Bottom clearance so the panel never sits on top of the chat composer — the same
 *  "near the bottom edge" heuristic the transcript's own scroll store uses. */
const PIP_BOTTOM_CLEARANCE = 96;
const PIP_KEY_STEP = 16;

interface Position {
  x: number;
  y: number;
}

function viewportSize(): { width: number; height: number } {
  if (typeof window === "undefined") {
    return { width: PIP_WIDTH + PIP_MARGIN * 2, height: PIP_HEIGHT + PIP_BOTTOM_CLEARANCE };
  }
  return { width: window.innerWidth, height: window.innerHeight };
}

function defaultPosition(): Position {
  const { width, height } = viewportSize();
  return {
    x: Math.max(PIP_MARGIN, width - PIP_WIDTH - PIP_MARGIN),
    y: Math.max(PIP_MARGIN, height - PIP_HEIGHT - PIP_BOTTOM_CLEARANCE),
  };
}

/** Clamp so the panel is always fully on-screen — goose clamps to window.inner{Width,Height} too. */
function clampPosition(pos: Position): Position {
  const { width, height } = viewportSize();
  const maxX = Math.max(PIP_MARGIN, width - PIP_WIDTH - PIP_MARGIN);
  const maxY = Math.max(PIP_MARGIN, height - PIP_HEIGHT - PIP_MARGIN);
  return {
    x: Math.min(Math.max(PIP_MARGIN, pos.x), maxX),
    y: Math.min(Math.max(PIP_MARGIN, pos.y), maxY),
  };
}

export function McpAppPipPanel() {
  const { t } = useTranslation();
  const occupant = useSyncExternalStore(subscribePipOccupant, getPipOccupant);
  const [position, setPosition] = useState<Position>(defaultPosition);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  // Re-clamp on viewport resize so the panel is never stranded off-screen.
  useEffect(() => {
    const onResize = () => setPosition((prev) => clampPosition(prev));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Release any in-flight drag listeners on unmount (e.g. the card left pip mid-drag).
  useEffect(() => () => dragCleanupRef.current?.(), []);

  const onDragPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
      dragCleanupRef.current?.();
      const startX = event.clientX;
      const startY = event.clientY;
      const startPos = position;
      const onMove = (moveEvent: PointerEvent) => {
        setPosition(
          clampPosition({
            x: startPos.x + (moveEvent.clientX - startX),
            y: startPos.y + (moveEvent.clientY - startY),
          }),
        );
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("pointercancel", cleanup);
        dragCleanupRef.current = null;
      };
      dragCleanupRef.current = cleanup;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", cleanup);
      window.addEventListener("pointercancel", cleanup);
    },
    [position],
  );

  // Arrow-key move on the drag handle — the same a11y affordance goose provides for
  // users who cannot (or prefer not to) drag with a pointer.
  const onDragKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const deltas: Partial<Record<string, Position>> = {
      ArrowLeft: { x: -PIP_KEY_STEP, y: 0 },
      ArrowRight: { x: PIP_KEY_STEP, y: 0 },
      ArrowUp: { x: 0, y: -PIP_KEY_STEP },
      ArrowDown: { x: 0, y: PIP_KEY_STEP },
    };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    setPosition((prev) => clampPosition({ x: prev.x + delta.x, y: prev.y + delta.y }));
  }, []);

  if (!occupant) return null;

  return (
    <div
      data-testid="mcp-app-pip-panel"
      className="fixed z-50 flex flex-col overflow-hidden rounded-lg border bg-background shadow-lg"
      style={{ left: position.x, top: position.y, width: PIP_WIDTH, maxHeight: PIP_HEIGHT }}
    >
      <div className="flex items-center justify-between gap-1 border-b bg-muted/(--opacity-muted) px-1 py-1">
        <div
          role="button"
          tabIndex={0}
          aria-label={t("mcpAppPipPanel.dragHandle")}
          data-testid="mcp-app-pip-drag-handle"
          className="flex flex-1 cursor-grab items-center justify-center rounded px-1 py-0.5 active:cursor-grabbing"
          onPointerDown={onDragPointerDown}
          onKeyDown={onDragKeyDown}
        >
          <GripHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <button
          type="button"
          data-testid="mcp-app-pip-close"
          aria-label={t("mcpAppPipPanel.close")}
          className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => reviveCardIfAt(occupant.cardId, { kind: "pip" })}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <McpAppView
          key={occupant.cardId}
          payload={occupant.payload}
          displayMode="pip"
          originSessionId={occupant.originSessionId}
          locationId={occupant.cardId}
        />
      </div>
    </div>
  );
}
