// OverlayCardRegion — mounts the single active OverlayCard from OverlayContext.
//
// Renders in a separate z-layer inside ChatView above the scroll area.
// Never injects entries into chat history; routine sources remain isolated.
//
// Active item is resolved from OverlayContext queue. App.tsx also maintains an
// overlayItemsRef Map for items that persist after dismiss — e.g. to keep the
// routine session path available for RoutineSessionView modal after the overlay card
// is removed from the queue (notification-only routines omit routineSessionPath).
//
// Two source variants:
//   - routine: primary action opens RoutineSessionView modal ("결과 보기")
//     — only shown when routineSessionPath is present (notification-only routines hide the button)
//   - plugin (insertion-type): primary action deferred to onPluginPrimaryAction prop

import { useOverlayContext } from "../context/OverlayContext.js";
import { OverlayCard } from "./OverlayCard.js";

export interface OverlayCardRegionProps {
  /**
   * Called when the user confirms a plugin overlay item.
   * Receives the overlay item id; App.tsx resolves it to the full item
   * via OverlayContext and inserts pendingPrompt into main chat.
   */
  onPluginPrimaryAction: (overlayItemId: string) => void;
  onRoutineAcknowledge?: (routineId: string, firedAt: string) => void;
}

export function OverlayCardRegion({ onPluginPrimaryAction, onRoutineAcknowledge }: OverlayCardRegionProps) {
  const { active, queueIndex, queueTotal, prev, next, dismiss, openSession } =
    useOverlayContext();

  if (!active) return null;

  if (active.source.kind === "routine") {
    const { routineId, firedAt } = active.source;
    // Only show "결과 보기" when there is a JSONL session file (notification-only routines have none)
    const hasJsonl = !!active.routineSessionPath;
    return (
      <div
        data-testid="overlay-card-region"
        className="pointer-events-none absolute right-4 top-2 z-20 w-[380px] max-w-[calc(100vw-2rem)]"
      >
        <div className="pointer-events-auto">
          <OverlayCard
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
            onPrimaryAction={hasJsonl ? () => {
              onRoutineAcknowledge?.(routineId, firedAt);
              openSession(routineId, firedAt);
            } : undefined}
            primaryActionLabel="결과 보기"
            kind="routine"
          />
        </div>
      </div>
    );
  }

  if (active.source.kind === "plugin") {
    // Plugin insertion variant — user confirm → main chat insert.
    const pluginFiredAt = active.createdAt ?? new Date().toISOString();
    return (
      <div
        data-testid="overlay-card-region"
        className="pointer-events-none absolute right-4 top-2 z-20 w-[380px] max-w-[calc(100vw-2rem)]"
      >
        <div className="pointer-events-auto">
          <OverlayCard
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
              onPluginPrimaryAction(active.id);
            }}
            primaryActionLabel={active.primaryActionLabel ?? "확인하기"}
            kind="plugin"
          />
        </div>
      </div>
    );
  }

  return null;
}
