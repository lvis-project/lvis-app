// OverlayCardRegion — mounts the single active OverlayCard from OverlayContext.
//
// Renders in a separate z-layer inside ChatView above the scroll area.
// Never injects entries into chat history (Q9 isolation maintained for routine source).
//
// Q11: Two source variants:
//   - routine: primary action opens RoutineSessionView modal ("결과 보기")
//     — only shown when routineSessionPath is present (notification-only routines hide the button)
//   - plugin (insertion-type): primary action deferred to onPluginPrimaryAction prop

import { useOverlayContext } from "../context/OverlayContext.js";
import { OverlayCard } from "./OverlayCard.js";

export interface OverlayCardRegionProps {
  /**
   * Q11 — called when the user confirms a plugin overlay item.
   * Receives the overlay item id; App.tsx resolves it to the full item
   * via OverlayContext and inserts pendingPrompt into main chat.
   */
  onPluginPrimaryAction: (overlayItemId: string) => void;
}

export function OverlayCardRegion({ onPluginPrimaryAction }: OverlayCardRegionProps) {
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
            onDismiss={() => dismiss(active.id)}
            onPrimaryAction={hasJsonl ? () => openSession(routineId, firedAt) : undefined}
            primaryActionLabel="결과 보기"
          />
        </div>
      </div>
    );
  }

  if (active.source.kind === "plugin") {
    // Q11 plugin (insertion-type) variant — user confirm → main chat insert
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
            primaryActionLabel={active.primaryActionLabel ?? "지금 답하기"}
          />
        </div>
      </div>
    );
  }

  return null;
}
