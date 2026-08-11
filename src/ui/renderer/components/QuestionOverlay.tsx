import { useEffect, useRef } from "react";
import { AskUserQuestionCard, type AskUserQuestionRequest } from "./AskUserQuestionCard.js";
import type { LvisApi } from "../types.js";

export interface QuestionOverlayProps {
  api: LvisApi;
  requests: AskUserQuestionRequest[];
  onResolved: (id: string) => void;
}

export function QuestionOverlay({ api, requests, onResolved }: QuestionOverlayProps) {
  const current = requests[0];
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!current) return;
    const root = rootRef.current;
    const composer = root?.closest<HTMLElement>('[data-composer-placement]');
    if (!root || !composer) return;

    const focusFirstChoiceWhenExposed = () => {
      if (composer.inert || composer.getAttribute("aria-hidden") === "true") return;
      if (root.contains(document.activeElement)) return;
      root.querySelector<HTMLElement>(
        '[role="option"][tabindex="0"]:not(:disabled), [role="option"]:not(:disabled)',
      )?.focus();
    };

    focusFirstChoiceWhenExposed();
    const observer = new MutationObserver(focusFirstChoiceWhenExposed);
    observer.observe(composer, { attributes: true, attributeFilter: ["inert", "aria-hidden"] });
    return () => observer.disconnect();
  }, [current?.id]);

  if (!current) return null;

  return (
    <div
      ref={rootRef}
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-40 flex justify-center"
      data-testid="question-overlay"
    >
      {/* Edge-to-edge horizontally so the chat surface behind the overlay
         doesn't peek through the padding. Bottom edge is flush with the
         status bar; StatusBar owns the only separator line. */}
      <div className="max-h-[min(360px,calc(100%_+_20dvh))] w-full min-w-0 overflow-y-auto rounded-t-lg">
        <AskUserQuestionCard
          key={current.id}
          api={api}
          request={current}
          onResolved={onResolved}
          className="rounded-none rounded-t-lg border-b-0"
        />
      </div>
    </div>
  );
}
