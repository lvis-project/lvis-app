// OverlayCardRegion — mounts the single active OverlayCard from OverlayContext.
//
// Renders in a separate z-layer inside ChatView above the scroll area.
// Never injects entries into chat history (Q9 isolation maintained).

import { useOverlayContext } from "../context/OverlayContext.js";
import { OverlayCard } from "./OverlayCard.js";

export function OverlayCardRegion() {
  const { active, queueIndex, queueTotal, prev, next, dismiss, snooze, openSession } =
    useOverlayContext();

  if (!active) return null;

  // Routine source 만 RoutineSessionView 모달 가능. plugin source 는 자체 onPrimaryAction 사용.
  if (active.source.kind !== "routine") return null;

  const { routineId, firedAt } = active.source;

  return (
    <div
      data-testid="overlay-card-region"
      className="pointer-events-none absolute right-4 top-2 z-20 w-[380px] max-w-[calc(100vw-2rem)]"
    >
      <div className="pointer-events-auto">
        <OverlayCard
          routineTitle={active.title}
          summary={active.summary}
          firedAt={firedAt}
          running={active.running}
          queueIndex={queueIndex}
          queueTotal={queueTotal}
          onPrev={prev}
          onNext={next}
          onDismiss={() => dismiss(active.id)}
          onSnooze={() => snooze(active.id)}
          onOpenSession={() => openSession(routineId, firedAt)}
        />
      </div>
    </div>
  );
}
