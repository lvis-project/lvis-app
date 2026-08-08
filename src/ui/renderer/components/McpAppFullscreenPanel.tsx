/**
 * McpAppFullscreenPanel — the in-renderer surface for an MCP-app card that requested
 * (or was moved into) `fullscreen`.
 *
 * ─── Why in-renderer, not a separate window ───────────────────────────────────
 * `fullscreen` has no normative definition in the confirmed MCP Apps revision — that
 * revision defines only `inline` ("embedded within the host's content flow") and `pip`
 * ("floating overlay"). The draft that adds it describes the view as TAKING OVER the
 * full screen/window, which is a claim about how much surface the view occupies, not
 * about spawning a second one. Both the ext-apps SDK's own documented example and the
 * reference host realize it the same way: the app keeps its existing container and the
 * host swaps one CSS class on it, calling the transition an inline↔fullscreen panel
 * toggle. So this host presents `fullscreen` as a surface INSIDE the renderer that
 * takes over the app window's content area — the same shape `McpAppPipPanel` already
 * has for `pip`, one slot in the shared location store with one component subscribed
 * to it.
 *
 * ─── Why this remounts the card ───────────────────────────────────────────────
 * Same trade-off, and the same reasons, as `McpAppPipPanel`: an away surface rendered
 * by a DIFFERENT component means React mounts a fresh `<McpAppView>`, so the card gets
 * a fresh bridge + `<webview>` and app state does not survive the move. Preserving it
 * would need a single always-mounted overlay layer with anchor-tracked CSS-only
 * repositioning — a materially larger subsystem than this feature. Eyes open.
 *
 * Renders nothing when no card occupies the fullscreen slot. One McpAppView instance
 * per occupant, keyed by `cardId` so a DIFFERENT card claiming the slot is a clean
 * remount, never a payload swap on a stale instance.
 */
import { useCallback, useSyncExternalStore } from "react";
import { Minimize2 } from "lucide-react";
import { McpAppView } from "./McpAppView.js";
import { useTranslation } from "../../../i18n/react.js";
import {
  getSlotOccupant,
  reviveCardIfAt,
  subscribeSlotOccupant,
} from "../state/mcp-app-card-location-store.js";

export function McpAppFullscreenPanel() {
  const { t } = useTranslation();
  const subscribe = useCallback(
    (listener: () => void) => subscribeSlotOccupant("fullscreen", listener),
    [],
  );
  const getSnapshot = useCallback(() => getSlotOccupant("fullscreen"), []);
  const occupant = useSyncExternalStore(subscribe, getSnapshot);

  if (!occupant) return null;

  return (
    <div
      data-testid="mcp-app-fullscreen-panel"
      // Below `McpAppPipPanel`'s z-50: a card in pip and a DIFFERENT card in
      // fullscreen can occupy their slots at the same time, and the floating overlay
      // is the one that must stay on top of the surface that took over.
      className="fixed inset-0 z-40 flex flex-col overflow-hidden bg-background"
    >
      <div className="flex items-center justify-end border-b bg-muted/(--opacity-muted) px-1 py-1">
        <button
          type="button"
          data-testid="mcp-app-fullscreen-exit"
          aria-label={t("mcpAppFullscreenPanel.exit")}
          className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => reviveCardIfAt(occupant.cardId, { kind: "fullscreen" })}
        >
          <Minimize2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <McpAppView
          key={occupant.cardId}
          payload={occupant.payload}
          displayMode="fullscreen"
          originSessionId={occupant.originSessionId}
          locationId={occupant.cardId}
        />
      </div>
    </div>
  );
}
