/**
 * CheckpointDivider — Layer 2 compact / manual checkpoint 표시 horizontal divider.
 *
 * Phase 3 (compact pipeline rewrite) — status 별 visual variant:
 *   - SUMMARIZED          → 📦 정상 요약 (blue/slate)
 *   - CONTENT_TRUNCATED   → ✂️ 부분 절단됨 (yellow) — LLM 호출 skip
 *   - NOOP                → ✓ 불필요 (gray) — small history
 *   - REDUCED_INSUFFICIENT_FORCED → ⚠️ 강제 절단됨 (red) — last-resort raw drop
 *
 * §PR-5: action buttons (view / branch) only rendered for SUMMARIZED + FORCED
 *   (둘 다 boundary 가 truthy 인 경로). NOOP / CONTENT_TRUNCATED 에선 숨김.
 */

import type { CheckpointTier } from "../../../lib/chat-stream-state.js";

type CompactStatus =
  | "summarized"
  | "content_truncated"
  | "noop"
  | "reduced_insufficient_forced";

interface Variant {
  label: string;
  icon: string;
  lineCls: string;
  textCls: string;
}

const STATUS_VARIANTS: Record<CompactStatus, Variant> = {
  summarized: {
    label: "요약 완료",
    icon: "📦",
    lineCls: "bg-action-compact/30",
    textCls: "text-action-compact/80",
  },
  content_truncated: {
    label: "부분 절단",
    icon: "✂️",
    lineCls: "bg-warning/40",
    textCls: "text-warning/90",
  },
  noop: {
    label: "압축 불필요",
    icon: "✓",
    lineCls: "bg-muted-foreground/25",
    textCls: "text-muted-foreground/70",
  },
  reduced_insufficient_forced: {
    label: "강제 절단",
    icon: "⚠️",
    lineCls: "bg-destructive/40",
    textCls: "text-destructive/90",
  },
};

const TIER_VARIANTS: Record<CheckpointTier | "default", Variant> = {
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
  compactStatus,
  truncatedDir,
  onEnterView,
  onBranchFrom,
}: {
  tier?: CheckpointTier;
  messageCount: number;
  /** §PR-5: compact sequence number — enables view/branch action buttons. */
  compactNum?: number;
  /** Phase 3: compact 결과 status. status variant 가 tier variant 보다 우선. */
  compactStatus?: CompactStatus;
  /** Phase 2: Layer A truncation 원본 디렉토리 — banner footnote 에 표시. */
  truncatedDir?: string;
  /** §PR-5: enter view-mode for this checkpoint. */
  onEnterView?: (compactNum: number) => void | Promise<void>;
  /** §PR-5: fork a new session from this checkpoint. */
  onBranchFrom?: (compactNum: number) => void | Promise<void>;
}) {
  // Status 가 명시되면 status variant 우선, 아니면 tier variant (legacy 호환).
  const variant: Variant = compactStatus !== undefined
    ? STATUS_VARIANTS[compactStatus]
    : TIER_VARIANTS[tier ?? "default"];
  // Action buttons: SUMMARIZED 또는 REDUCED_INSUFFICIENT_FORCED (boundary 가
  // truthy 한 경로) + compactNum 있을 때만 노출. NOOP / CONTENT_TRUNCATED 는
  // boundary 가 없어 view/branch 불가.
  const hasBoundary = compactStatus === undefined
    || compactStatus === "summarized"
    || compactStatus === "reduced_insufficient_forced";
  const hasActions =
    hasBoundary && compactNum !== undefined && (onEnterView !== undefined || onBranchFrom !== undefined);
  return (
    <div
      data-testid="checkpoint-divider"
      data-tier={tier ?? "default"}
      data-compact-status={compactStatus ?? "summarized"}
      data-compact-num={compactNum}
      className="my-2 flex flex-col gap-1.5 py-2"
    >
      <div className="flex items-center gap-2">
        <span className={`h-px flex-1 ${variant.lineCls}`} />
        <span className={`text-[10px] ${variant.textCls} font-medium`}>
          {"───"} {variant.icon} 체크포인트{compactNum !== undefined ? ` #${compactNum}` : ""} · {variant.label} (메시지 {messageCount}개) {"───"}
        </span>
        <span className={`h-px flex-1 ${variant.lineCls}`} />
      </div>
      {truncatedDir !== undefined && (
        <div className="px-4 text-center text-[9.5px] text-muted-foreground/70">
          원본 보존: {truncatedDir}
        </div>
      )}
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
