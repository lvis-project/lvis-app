/**
 * AskUserQuestionCard — inline chat-side question prompt for the
 * `ask_user_question` LLM tool. Renders the question, choice buttons, and
 * an optional free-text input. Selecting a choice / submitting the text /
 * dismissing fires the renderer→main response and removes the card.
 */
import { useEffect, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { Textarea } from "../../../components/ui/textarea.js";
import type { LvisApi } from "../types.js";

export interface AskUserQuestionRequest {
  id: string;
  question: string;
  choices?: string[];
  allowFreeText: boolean;
  urgent: boolean;
  createdAt: number;
}

export interface AskUserQuestionCardProps {
  api: LvisApi;
  request: AskUserQuestionRequest;
  onResolved: (id: string) => void;
}

export function AskUserQuestionCard({
  api,
  request,
  onResolved,
}: AskUserQuestionCardProps) {
  const [freeText, setFreeText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setFreeText("");
  }, [request.id]);

  const respond = async (
    body: { choice?: string; freeText?: string; dismissed?: boolean },
  ) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await api.respondAskUserQuestion({
        requestId: request.id,
        ...body,
      });
      onResolved(request.id);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card
      className={`max-w-[85%] border ${request.urgent ? "border-amber-500/60 bg-amber-500/5" : ""}`}
      data-testid="ask-user-question-card"
    >
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          {request.urgent ? "🟠 긴급 질문" : "❓ 질문"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="whitespace-pre-wrap text-sm">{request.question}</div>
        {request.choices && request.choices.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {request.choices.map((c) => (
              <Button
                key={c}
                size="sm"
                variant="outline"
                disabled={submitting}
                onClick={() => void respond({ choice: c })}
              >
                {c}
              </Button>
            ))}
          </div>
        )}
        {request.allowFreeText && (
          <div className="space-y-2">
            <Textarea
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              placeholder="직접 입력..."
              className="min-h-[60px] text-sm"
              disabled={submitting}
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={submitting}
                onClick={() => void respond({ dismissed: true })}
              >
                건너뛰기
              </Button>
              <Button
                size="sm"
                disabled={submitting || !freeText.trim()}
                onClick={() => void respond({ freeText: freeText.trim() })}
              >
                보내기
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
