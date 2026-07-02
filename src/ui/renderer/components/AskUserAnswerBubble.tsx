import { useTranslation } from "../../../i18n/react.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";

export function AskUserAnswerBubble({
  entry,
}: {
  entry: Extract<ChatEntry, { kind: "ask_user_answer" }>;
}) {
  const { t } = useTranslation();
  if (entry.dismissed) {
    return (
      <div
        className="ml-auto w-fit min-w-0 max-w-[75%] rounded-lg border border-border/(--opacity-strong) border-l-2 border-l-muted-foreground/(--opacity-strong) bg-card/(--opacity-intense) px-3 py-2 text-xs text-muted-foreground shadow-sm"
        data-testid="ask-user-answer-bubble"
      >
        <div className="text-[10.5px] text-muted-foreground/(--opacity-intense)">{t("chatView.askAnswerSkippedLabel")}</div>
        <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{t("chatView.askAnswerSkippedProceed")}</div>
      </div>
    );
  }

  return (
    <div
      className="ml-auto w-fit min-w-0 max-w-[75%] rounded-lg border border-border/(--opacity-strong) border-l-2 border-l-message-user bg-card/(--opacity-near) px-3 py-2.5 text-xs text-card-foreground shadow-sm"
      data-testid="ask-user-answer-bubble"
    >
      <div className="mb-1 text-[10.5px] text-muted-foreground">
        {entry.rows.length > 1 ? t("chatView.askAnswerMyAnswerMultiple", { count: entry.rows.length }) : t("chatView.askAnswerMyAnswerSingle")}
      </div>
      <div className="space-y-0.5">
        {entry.rows.map((row, idx) => (
          <div key={`${idx}:${row.label}`} className="flex min-w-0 items-baseline gap-2">
            <span className="w-[4.5rem] shrink-0 truncate text-[10.5px] text-muted-foreground">{row.label}</span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[12px] [overflow-wrap:anywhere]">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
