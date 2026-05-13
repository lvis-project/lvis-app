import { AskUserQuestionCard, type AskUserQuestionRequest } from "./AskUserQuestionCard.js";
import type { LvisApi } from "../types.js";

export interface QuestionOverlayProps {
  api: LvisApi;
  requests: AskUserQuestionRequest[];
  onResolved: (id: string) => void;
}

export function QuestionOverlay({ api, requests, onResolved }: QuestionOverlayProps) {
  const current = requests[0];
  if (!current) return null;

  return (
    <div
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-40 flex justify-center"
      data-testid="question-overlay"
    >
      {/* Edge-to-edge horizontally so the chat surface behind the overlay
         doesn't peek through the padding. Bottom edge is flush with the
         status bar; StatusBar owns the only separator line. */}
      <div className="max-h-[min(360px,calc(100%_+_20dvh))] w-full min-w-0 overflow-y-auto rounded-t-lg">
        <AskUserQuestionCard
          api={api}
          request={current}
          onResolved={onResolved}
          className="rounded-none rounded-t-lg border-b-0"
        />
      </div>
    </div>
  );
}
