import { AlertTriangle, CheckCircle2, Loader2, ShieldQuestion } from "lucide-react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";

type PermissionReviewEntry = Extract<ChatEntry, { kind: "permission_review" }>;

function statusLabel(entry: PermissionReviewEntry): string {
  if (entry.status === "reviewing") return "권한 검토중...";
  if (entry.status === "auto_approved") return "권한 검토 완료 · 낮은 위험";
  if (entry.status === "failed") return "권한 검토 실패";
  const level =
    entry.verdictLevel === "high" ? "높은 위험" :
    entry.verdictLevel === "medium" ? "중간 위험" :
    entry.verdictLevel === "low" ? "낮은 위험" :
    "검토 완료";
  return `승인 필요 · ${level}`;
}

function toneClass(entry: PermissionReviewEntry): string {
  if (entry.status === "reviewing") {
    return "border-info/40 bg-info/5 text-info";
  }
  if (entry.status === "auto_approved") {
    return "border-success/40 bg-success/5 text-success";
  }
  if (entry.status === "failed" || entry.verdictLevel === "high") {
    return "border-destructive/40 bg-destructive/5 text-destructive";
  }
  return "border-warning/40 bg-warning/10 text-warning";
}

function StatusIcon({ entry }: { entry: PermissionReviewEntry }) {
  if (entry.status === "reviewing") return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />;
  if (entry.status === "auto_approved") return <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />;
  if (entry.status === "failed" || entry.verdictLevel === "high") return <AlertTriangle className="h-3.5 w-3.5 shrink-0" />;
  return <ShieldQuestion className="h-3.5 w-3.5 shrink-0" />;
}

export function PermissionReviewStatusCard({ entry }: { entry: PermissionReviewEntry }) {
  const source = entry.source === "plugin" ? "플러그인" :
    entry.source === "mcp" ? "MCP" :
    entry.source === "builtin" ? "내장" :
    "출처 미확인";
  return (
    <div
      data-testid="permission-review-status-card"
      data-status={entry.status}
      role="status"
      aria-live="polite"
      className={`w-full max-w-full min-w-0 rounded-md border px-3 py-2 text-xs lvis-anim-message-in ${toneClass(entry)}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusIcon entry={entry} />
        <span className="shrink-0 font-semibold">{statusLabel(entry)}</span>
        <span className="min-w-0 truncate text-muted-foreground">
          {entry.toolName} · {source}
        </span>
      </div>
      {entry.approvalPurpose?.confidence === "sufficient" && (
        <div className="mt-1 min-w-0 truncate pl-5 text-[11px] text-muted-foreground">
          목적: {entry.approvalPurpose.text}
        </div>
      )}
    </div>
  );
}
