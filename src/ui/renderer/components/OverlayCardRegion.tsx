// OverlayCardRegion — mounts the single active OverlayCard from OverlayContext.
//
// Renders in a separate z-layer inside ChatView above the scroll area.
// Never injects entries into chat history; routine sources remain isolated.
//
// Active item is resolved from OverlayContext queue. App.tsx also maintains an
// overlayItemsRef Map for items that persist after dismiss.
//
// Two source variants:

//     — only shown when routineSessionId is present (notification-only routines hide the button)
//   - plugin (insertion-type): primary action deferred to onPluginPrimaryAction prop

import { useOverlayContext } from "../context/OverlayContext.js";
import { OverlayCard } from "./OverlayCard.js";
import { useTranslation } from "../../../i18n/react.js";

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
  const { t } = useTranslation();
  const { active, queueIndex, queueTotal, prev, next, dismiss, openSession } =
    useOverlayContext();

  if (!active) return null;

  if (active.source.kind === "routine") {
    const { routineId, firedAt } = active.source;

    const hasSession = !!active.routineSessionId;
    return (
      <div
        data-testid="overlay-card-region"
        className="pointer-events-none absolute right-4 top-2 z-20 w-[380px] max-w-[calc(100vw-2rem)]"
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
              onPluginPrimaryAction(active.id);
            }}
            primaryActionLabel={active.primaryActionLabel ?? t("overlayCardRegion.confirm")}
            kind="plugin"
          />
        </div>
      </div>
    );
  }

  return null;
}
