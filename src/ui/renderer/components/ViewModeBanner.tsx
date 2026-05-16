/**
 * ViewModeBanner — sticky top banner shown when the user is viewing a checkpoint slice.
 *
 * When the user clicks "이 시점 보기" on a CheckpointDivider, the chat
 * view slices messages to [0..slicedRangeEnd] and shows this banner at the top.
 * The banner is dismissible via "▶ 라이브 시점으로 복귀" which calls onExit.
 *
 * Design tokens: --action-view (violet) for the banner accent.
 * backdrop-blur(10px) so the chat content is partially visible underneath.
 */

export interface ViewModeState {
  compactNum: number;
  /**
   * Exclusive slice end — use as `messages.slice(0, slicedRangeEnd)`.
   * Equal to `messageCountAtTrigger` stored in the checkpoint metadata.
   */
  slicedRangeEnd: number;
}

export function ViewModeBanner({
  viewMode,
  onExit,
}: {
  viewMode: ViewModeState | null;
  onExit: () => void;
}) {
  if (!viewMode) return null;

  return (
    <div
      data-testid="view-mode-banner"
      className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-[hsl(var(--action-view)/0.3)] bg-[hsl(var(--action-view)/0.08)] px-4 py-2 backdrop-blur-[10px]"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span
          data-testid="view-mode-banner-title"
          className="text-[12px] font-semibold text-[hsl(var(--action-view))]"
        >
          📖 #{viewMode.compactNum} 시점 보기 모드
        </span>
        <span className="text-[10px] text-muted-foreground">
          첫 {viewMode.slicedRangeEnd}개 메시지 · 이 시점 이후 메시지는 숨겨짐
        </span>
      </div>
      <button
        type="button"
        data-testid="view-mode-exit-btn"
        onClick={onExit}
        className="shrink-0 rounded-md border border-[hsl(var(--action-view)/0.4)] bg-[hsl(var(--action-view)/0.12)] px-3 py-1.5 text-[11px] font-medium text-[hsl(var(--action-view))] transition-colors hover:bg-[hsl(var(--action-view)/0.2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--action-view)/0.5)]"
        aria-label="라이브 시점으로 복귀"
      >
        ▶ 라이브 시점으로 복귀
      </button>
    </div>
  );
}
