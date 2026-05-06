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
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-3"
      data-testid="question-overlay"
    >
      <div className="max-h-[min(360px,calc(100%_+_20dvh))] w-full max-w-[720px] min-w-0 overflow-y-auto rounded-lg">
        <AskUserQuestionCard
          api={api}
          request={current}
          onResolved={onResolved}
        />
      </div>
    </div>
  );
}
