// OverlayCardRegion — mounts one surface's active OverlayCard from OverlayContext.
//
// Renders in a separate z-layer above the scroll area: inside ChatView for a
// tile, in the window's own lane for the cards no conversation owns.
// Never injects entries into chat history; routine sources remain isolated.
//
// One card renders on ONE surface — see `overlayCardTile`. The queue is the
// window's, but the SLICE of it a surface shows, and which card of that slice
// is active, belong to that surface: a window-wide counter would say "1/3"
// over a tile that has one card, and stepping next would move to a card that
// renders somewhere else entirely.
//
// Two source variants:
//   - routine: primary action opens the routine's session (only when
//     `routineSessionId` is present — notification-only routines hide it)
//   - plugin / app (insertion-type): primary action deferred to
//     `onPluginPrimaryAction`, and withheld entirely when the card's origin
//     conversation is no longer open.

import { useEffect, useMemo, useRef, useState } from "react";
import { useOverlayContext } from "../context/OverlayContext.js";
import { OverlayCard } from "./OverlayCard.js";
import { useTranslation } from "../../../i18n/react.js";
import { FLOATING_LANE_ITEM_WIDTH } from "./FloatingRightLane.js";
import type { OverlayCardPlacement } from "./chat-group-session-registry.js";

export interface OverlayCardRegionProps {
  /**
   * The tile this region renders inside, or `null` when it is the window's
   * own region — the one that draws what no conversation owns.
   */
  chatGroupId: string | null;
  /**
   * The conversation this region's primary action runs in. A tile's region
   * acts in its own tile. The window's region has no conversation of its own,
   * so it names the focused one — the conversation the user is looking at,
   * the same rule an unowned question already follows. Stated here rather
   * than inferred from where the card happens to be drawn.
   */
  actionChatGroupId: string;
  /**
   * Where a card belongs, given the conversation it came from, and whether
   * that conversation is still open. The window answers it, because only the
   * window can see every tile.
   */
  overlayCardTile: (card: { originSessionId?: string; adoptedChatGroupId?: string }) => OverlayCardPlacement;
  /**
   * Called when the user confirms a plugin overlay item, with the tile that
   * showed the card — the conversation the staged prompt is inserted into and
   * the turn is started in.
   */
  onPluginPrimaryAction: (overlayItemId: string, chatGroupId: string) => void;
  onRoutineAcknowledge?: (routineId: string, firedAt: string) => void;
}

export function OverlayCardRegion({
  chatGroupId, actionChatGroupId, overlayCardTile, onPluginPrimaryAction, onRoutineAcknowledge,
}: OverlayCardRegionProps) {
  const { t } = useTranslation();
  const { queue, dismiss, openSession, expandedCardIds, setCardExpanded } =
    useOverlayContext();

  // This surface's slice of the window queue. Every tile mounts a region, the
  // window mounts one more, and each keeps only the cards attributed to it, so
  // a card is shown — and so dismissed or confirmed — exactly once however
  // many tiles are open.
  const mine = useMemo(
    () => queue.filter((item) => overlayCardTile(item).chatGroupId === chatGroupId),
    [queue, overlayCardTile, chatGroupId],
  );

  // Where this region sits decides its box. A tile's region hangs in the
  // tile's floating lane at the lane's own width; the window's region is one
  // occupant of the window band, so it takes the band's reading column the way
  // the dock beside it does.
  const inWindowBand = chatGroupId === null;
  const regionClassName = inWindowBand
    ? "pointer-events-none mx-auto w-full min-w-0 max-w-(--reading-column-max)"
    : `pointer-events-none ${FLOATING_LANE_ITEM_WIDTH}`;

  const [activeIndex, setActiveIndex] = useState(0);
  // Clamped rather than corrected in an effect: the slice can shrink between
  // renders (a card dismissed, or one that followed focus to another tile),
  // and rendering `undefined` for a frame would flash the card away and back.
  const index = mine.length === 0 ? 0 : Math.min(activeIndex, mine.length - 1);
  const active = mine[index] ?? null;

  // A card that just arrived is the one the user means. Kept in an effect
  // rather than inside a state updater because StrictMode double-invokes
  // updaters, which would advance twice.
  const previousCountRef = useRef(0);
  useEffect(() => {
    if (mine.length > previousCountRef.current) setActiveIndex(mine.length - 1);
    previousCountRef.current = mine.length;
  }, [mine.length]);

  if (!active) return null;

  const queueIndex = index + 1;
  const queueTotal = mine.length;
  const prev = () => setActiveIndex(Math.max(0, index - 1));
  const next = () => setActiveIndex(Math.min(mine.length - 1, index + 1));
  const expanded = expandedCardIds.has(active.id);
  const onExpandedChange = (value: boolean) => setCardExpanded(active.id, value);

  if (active.source.kind === "routine") {
    const { routineId, firedAt } = active.source;

    const hasSession = !!active.routineSessionId;
    return (
      <div
        data-testid="overlay-card-region"
        data-overlay-surface={chatGroupId ?? "window"}
        // In a tile, position comes from `FloatingRightLane`, which is also what
        // kept the old tool-activity rail from landing on top of this card's
        // controls. In the window band the card is in flow — see
        // `regionClassName`.
        className={regionClassName}
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
            expanded={expanded}
            onExpandedChange={onExpandedChange}
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
    const kind = active.source.kind;
    // The card outlived the conversation it was staged for. Confirming would
    // start the turn in whatever tile happens to be focused, which is the very
    // mismatch main refuses on the way in — so the card keeps only its dismiss,
    // and says why.
    const { orphaned } = overlayCardTile(active);
    return (
      <div
        data-testid="overlay-card-region"
        data-overlay-surface={chatGroupId ?? "window"}
        // In a tile, position comes from `FloatingRightLane`, which is also what
        // kept the old tool-activity rail from landing on top of this card's
        // controls. In the window band the card is in flow — see
        // `regionClassName`.
        className={regionClassName}
      >
        <div className="pointer-events-auto">
          <OverlayCard
            key={active.id}
            title={active.title}
            summary={active.summary}
            firedAt={active.createdAt}
            running={active.running}
            queueIndex={queueIndex}
            queueTotal={queueTotal}
            onPrev={prev}
            onNext={next}
            onDismiss={() => dismiss(active.id)}
            expanded={expanded}
            onExpandedChange={onExpandedChange}
            onPrimaryAction={orphaned ? undefined : () => {
              // Dismiss from queue first, then notify App for chat insert
              dismiss(active.id);
              onPluginPrimaryAction(active.id, actionChatGroupId);
            }}
            {...(orphaned ? { notice: t("overlayCardRegion.originConversationClosed") } : {})}
            primaryActionLabel={active.primaryActionLabel ?? t("overlayCardRegion.confirm")}
            kind={kind}
          />
        </div>
      </div>
    );
  }

  return null;
}
