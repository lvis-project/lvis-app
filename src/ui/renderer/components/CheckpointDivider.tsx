/**
 * CheckpointDivider — tier-aware horizontal-line divider that marks rotation
 * checkpoints in the chat stream (§457 PR-A, restored from the deleted
 * StackedChatView in issue #547 visual absorption).
 *
 * Three semantically different rotation events share the same UI element:
 *   - hard-token   → 🚨 긴급 정리   (orange) — emergency, ctxUsage ≥ 85%
 *   - semantic-llm → 🔀 주제 전환   (violet) — LLM hinted topic shift
 *   - soft-time    → 🌙 이전 세션 정리 (slate)  — natural rest checkpoint
 *
 * Falls back to 📌 자동 정리 (blue) when tier is absent — plain auto/reactive
 * compaction outside the rotation pipeline.
 *
 * §457 Phase 3: when `onRevert` is supplied (i.e., the checkpoint entry
 * carried a `revertSessionId`), an inline "여기로 되돌아가기" link is shown
 * for resuming the parent session.
 */

import type { CheckpointTier } from "../../../lib/chat-stream-state.js";

const TIER_VARIANTS: Record<CheckpointTier | "default", { label: string; icon: string; lineCls: string; textCls: string }> = {
  "hard-token": {
    label: "긴급 정리",
    icon: "🚨",
    lineCls: "bg-orange-500/40",
    textCls: "text-orange-400/80",
  },
  "semantic-llm": {
    label: "주제 전환",
    icon: "🔀",
    lineCls: "bg-violet-500/35",
    textCls: "text-violet-300/80",
  },
  "soft-time": {
    label: "이전 세션 정리",
    icon: "🌙",
    lineCls: "bg-slate-500/35",
    textCls: "text-slate-300/80",
  },
  default: {
    label: "자동 정리",
    icon: "📌",
    lineCls: "bg-blue-500/30",
    textCls: "text-blue-400/65",
  },
};

export function CheckpointDivider({
  tier,
  messageCount,
  onRevert,
}: {
  tier?: CheckpointTier;
  messageCount: number;
  /** When supplied, render the "여기로 되돌아가기" action button. */
  onRevert?: () => void | Promise<void>;
}) {
  const variant = TIER_VARIANTS[tier ?? "default"];
  return (
    <div
      data-testid="checkpoint-divider"
      data-tier={tier ?? "default"}
      className="flex items-center gap-2 py-2 my-2"
    >
      <span className={`h-px flex-1 ${variant.lineCls}`} />
      <span className={`text-[10px] ${variant.textCls} font-medium`}>
        {"───"} {variant.icon} 체크포인트 · {variant.label} ({messageCount} messages) {"───"}
      </span>
      {onRevert && (
        <button
          type="button"
          data-testid="checkpoint-revert-btn"
          onClick={() => { void onRevert(); }}
          className={`text-[10px] ${variant.textCls} font-medium underline-offset-2 hover:underline cursor-pointer`}
          aria-label="이 체크포인트 이전 세션으로 되돌아가기"
        >
          ↩ 여기로 되돌아가기
        </button>
      )}
      <span className={`h-px flex-1 ${variant.lineCls}`} />
    </div>
  );
}
