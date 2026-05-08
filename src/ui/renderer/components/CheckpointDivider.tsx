/**
 * CheckpointDivider — Layer 2 compact / manual checkpoint 표시 horizontal divider.
 *
 * post-infinity-session-v3 — 2 trigger:
 *   - auto-compact → 📌 자동 정리 (blue) — Layer 0 preflight 가 Layer 2 compact 실행
 *   - manual       → ✋ 수동 정리 (slate) — 사용자 `/compact` 트리거
 *
 * fork-based revert (PR-2-F-2 폐지) → revertSessionId/onRevert 제거. same-session
 * 안 numbered checkpoint chain (Copilot 패턴) — sessionId 불변.
 */

import type { CheckpointTier } from "../../../lib/chat-stream-state.js";

const TIER_VARIANTS: Record<CheckpointTier | "default", { label: string; icon: string; lineCls: string; textCls: string }> = {
  "auto-compact": {
    label: "자동 정리",
    icon: "📌",
    lineCls: "bg-blue-500/30",
    textCls: "text-blue-400/65",
  },
  "manual": {
    label: "수동 정리",
    icon: "✋",
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
}: {
  tier?: CheckpointTier;
  messageCount: number;
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
      <span className={`h-px flex-1 ${variant.lineCls}`} />
    </div>
  );
}
