/**
 * SummaryToast — blue-tinted compact card that surfaces the rolling
 * summary attached to a checkpoint entry. Restored from the deleted
 * StackedChatView (issue #547 visual absorption). Truncated to 120 chars
 * so it stays a *toast*, not a competing message bubble.
 */
export function SummaryToast({ summary }: { summary: string }) {
  const trimmed = summary.length > 120 ? `${summary.slice(0, 117)}…` : summary;
  return (
    <div
      data-testid="summary-toast"
      className="mx-auto max-w-[70%] border-l-2 border-blue-500/40 bg-card/50 px-3 py-1.5 mb-3 rounded-r text-[11px] text-muted-foreground/70"
    >
      📝 이전 요약: {trimmed}
    </div>
  );
}
