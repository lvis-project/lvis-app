// OverlayCardRegion — mounts the single active OverlayCard from OverlayContext.
//
// Renders in a separate z-layer inside ChatView above the scroll area.
// Never injects entries into chat history; routine sources remain isolated.
//
// Active item is resolved from OverlayContext queue. App.tsx also maintains an
// overlayItemsRef Map for items that persist after dismiss.
//
// One card renders in ONE tile — see `overlayCardTile`.
//
// Two source variants:

//     — only shown when routineSessionId is present (notification-only routines hide the button)
//   - plugin (insertion-type): primary action deferred to onPluginPrimaryAction prop

import { useOverlayContext } from "../context/OverlayContext.js";
import { OverlayCard } from "./OverlayCard.js";
import { useTranslation } from "../../../i18n/react.js";
import { FLOATING_LANE_ITEM_WIDTH } from "./FloatingRightLane.js";

export interface OverlayCardRegionProps {
  /** The tile this region renders inside. */
  chatGroupId: string;
  /**
   * Which tile a card belongs in, given the conversation it came from. The
   * window answers it, because only the window can see every tile.
   */
  overlayCardTile: (originSessionId: string | undefined) => string;
  /**
   * Called when the user confirms a plugin overlay item, with the tile that
   * showed the card — the conversation the staged prompt is inserted into and
   * the turn is started in.
   */
  onPluginPrimaryAction: (overlayItemId: string, chatGroupId: string) => void;
  onRoutineAcknowledge?: (routineId: string, firedAt: string) => void;
}

export function OverlayCardRegion({
  chatGroupId, overlayCardTile, onPluginPrimaryAction, onRoutineAcknowledge,
}: OverlayCardRegionProps) {
  const { t } = useTranslation();
  const { active, queueIndex, queueTotal, prev, next, dismiss, openSession } =
    useOverlayContext();

  if (!active) return null;
  // The queue is the window's; the card is one tile's. Every tile mounts a
  // region and all but one of them stands down, so a dismiss or a confirm
  // happens once no matter how many conversations are open.
  if (overlayCardTile(active.originSessionId) !== chatGroupId) return null;

  if (active.source.kind === "routine") {
    const { routineId, firedAt } = active.source;

    const hasSession = !!active.routineSessionId;
    return (
      <div
        data-testid="overlay-card-region"
        // Position comes from `FloatingRightLane`, which is also what keeps the
        // action-panel rail from landing on top of this card's controls.
        className={`pointer-events-none ${FLOATING_LANE_ITEM_WIDTH}`}
      >
        <div className="pointer-events-auto">
          <OverlayCard
            key={active.id}
            title={active.title}
            summary={active.summary}
            firedAt={firedAt}
            running={active.running}
            queueIndex={queueIndex}
            queueTotal={queueTotal}
            onPrev={prev}
            onNext={next}
            onDismiss={() => {
              if (!active.running) onRoutineAcknowledge?.(routineId, firedAt);
              dismiss(active.id);
            }}
            onPrimaryAction={hasSession ? () => {
              void (async () => {
                const opened = await openSession(active.routineSessionId!);
                if (opened) {
                  onRoutineAcknowledge?.(routineId, firedAt);
                  dismiss(active.id);
                }
              })();
            } : undefined}
            primaryActionLabel={t("overlayCardRegion.viewResult")}
            kind="routine"
          />
        </div>
      </div>
    );
  }

  // Insertion variants — plugin overlay trigger and MCP-app `ui/message`. Both stage a
  // `pendingPrompt` that only a user CLICK turns into a chat turn; they differ solely in
  // provenance (the envelope in `pendingPrompt` and the badge below).
  if (active.source.kind === "plugin" || active.source.kind === "app") {
    const pluginFiredAt = active.createdAt ?? new Date().toISOString();
    const kind = active.source.kind;
    return (
      <div
        data-testid="overlay-card-region"
        // Position comes from `FloatingRightLane`, which is also what keeps the
        // action-panel rail from landing on top of this card's controls.
        className={`pointer-events-none ${FLOATING_LANE_ITEM_WIDTH}`}
      >
        <div className="pointer-events-auto">
          <OverlayCard
            key={active.id}
            title={active.title}
            summary={active.summary}
            firedAt={pluginFiredAt}
            running={active.running}
            queueIndex={queueIndex}
            queueTotal={queueTotal}
            onPrev={prev}
            onNext={next}
            onDismiss={() => dismiss(active.id)}
            onPrimaryAction={() => {
              // Dismiss from queue first, then notify App for chat insert
              dismiss(active.id);
              onPluginPrimaryAction(active.id, chatGroupId);
            }}
            primaryActionLabel={active.primaryActionLabel ?? t("overlayCardRegion.confirm")}
            kind={kind}
          />
        </div>
      </div>
    );
  }

  return null;
}
