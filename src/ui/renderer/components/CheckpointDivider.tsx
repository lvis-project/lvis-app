/**
 * CheckpointDivider — Layer 2 compact / manual checkpoint 표시 horizontal divider.
 *
 * post-infinity-session-v3 — 2 trigger:
 *   - auto-compact → 📌 자동 정리 (blue) — Layer 0 preflight 가 Layer 2 compact 실행
 *   - manual       → ✋ 수동 정리 (slate) — 사용자 `/compact` 트리거
 *
 * §PR-5: Two action buttons exposed when compactNum + callbacks are provided:
 *   - 📖 이 시점 보기      (violet / --action-view)   — enter view-mode
 *   - ↩ 여기부터 다시 시작  (orange / --action-branch) — fork a new session
 */

import type { CheckpointTier } from "../../../lib/chat-stream-state.js";

const TIER_VARIANTS: Record<CheckpointTier | "default", { label: string; icon: string; lineCls: string; textCls: string }> = {
  "auto-compact": {
    label: "자동 정리",
    icon: "📌",
    lineCls: "bg-action-compact/30",
    textCls: "text-action-compact/80",
  },
  "manual": {
    label: "수동 정리",
    icon: "✋",
    lineCls: "bg-muted-foreground/35",
    textCls: "text-muted-foreground/80",
  },
  default: {
    label: "자동 정리",
    icon: "📌",
    lineCls: "bg-action-compact/30",
    textCls: "text-action-compact/80",
  },
};

export function CheckpointDivider({
  tier,
  messageCount,
  compactNum,
  onEnterView,
  onBranchFrom,
}: {
  tier?: CheckpointTier;
  messageCount: number;
  /** §PR-5: compact sequence number — enables view/branch action buttons. */
  compactNum?: number;
  /** §PR-5: enter view-mode for this checkpoint. */
  onEnterView?: (compactNum: number) => void | Promise<void>;
  /** §PR-5: fork a new session from this checkpoint. */
  onBranchFrom?: (compactNum: number) => void | Promise<void>;
}) {
  const variant = TIER_VARIANTS[tier ?? "default"];
  const hasActions = compactNum !== undefined && (onEnterView !== undefined || onBranchFrom !== undefined);
  return (
    <div
      data-testid="checkpoint-divider"
      data-tier={tier ?? "default"}
      data-compact-num={compactNum}
      className="my-2 flex flex-col gap-1.5 py-2"
    >
      {/* ── Divider line + label row ── */}
      <div className="flex items-center gap-2">
        <span className={`h-px flex-1 ${variant.lineCls}`} />
        <span className={`text-[10px] ${variant.textCls} font-medium`}>
          {"───"} {variant.icon} 체크포인트{compactNum !== undefined ? ` #${compactNum}` : ""} · {variant.label} ({messageCount} messages) {"───"}
        </span>
        <span className={`h-px flex-1 ${variant.lineCls}`} />
      </div>
      {/* ── §PR-5 action buttons ── */}
      {hasActions && (
        <div
          data-testid="checkpoint-actions"
          className="flex items-center justify-center gap-2 px-4"
        >
          {onEnterView !== undefined && compactNum !== undefined && (
            <button
              type="button"
              data-testid="ck-btn-view"
              onClick={() => { void onEnterView(compactNum); }}
              className="rounded-md border border-[hsl(var(--action-view)/0.35)] bg-[hsl(var(--action-view)/0.08)] px-3 py-1 text-[10.5px] font-medium text-[hsl(var(--action-view))] transition-colors hover:bg-[hsl(var(--action-view)/0.18)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--action-view)/0.4)]"
              aria-label={`체크포인트 #${compactNum} 시점 보기`}
            >
              📖 이 시점 보기
            </button>
          )}
          {onBranchFrom !== undefined && compactNum !== undefined && (
            <button
              type="button"
              data-testid="ck-btn-fork"
              onClick={() => { void onBranchFrom(compactNum); }}
              className="rounded-md border border-[hsl(var(--action-branch)/0.35)] bg-[hsl(var(--action-branch)/0.08)] px-3 py-1 text-[10.5px] font-medium text-[hsl(var(--action-branch))] transition-colors hover:bg-[hsl(var(--action-branch)/0.18)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--action-branch)/0.4)]"
              aria-label={`체크포인트 #${compactNum} 에서 새 세션 시작`}
            >
              ↩ 여기부터 다시 시작
            </button>
          )}
        </div>
      )}
    </div>
  );
}
