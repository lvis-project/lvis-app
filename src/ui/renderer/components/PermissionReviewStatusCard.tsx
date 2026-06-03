import { AlertTriangle, CheckCircle2, Loader2, ShieldQuestion } from "lucide-react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { t } from "../../../i18n/runtime.js";
import { useTranslation } from "../../../i18n/react.js";

type PermissionReviewEntry = Extract<ChatEntry, { kind: "permission_review" }>;

function statusLabel(entry: PermissionReviewEntry): string {
  if (entry.status === "reviewing") return t("permissionReviewStatusCard.reviewing");
  if (entry.status === "auto_approved") return t("permissionReviewStatusCard.autoApproved");
  if (entry.status === "failed") return t("permissionReviewStatusCard.failed");
  const level =
    entry.verdictLevel === "high" ? t("permissionReviewStatusCard.riskHigh") :
    entry.verdictLevel === "medium" ? t("permissionReviewStatusCard.riskMedium") :
    entry.verdictLevel === "low" ? t("permissionReviewStatusCard.riskLow") :
    t("permissionReviewStatusCard.reviewComplete");
  return t("permissionReviewStatusCard.approvalRequired", { level });
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
  const { t: tComp } = useTranslation();
  const source = entry.source === "plugin" ? tComp("permissionReviewStatusCard.sourcePlugin") :
    entry.source === "mcp" ? "MCP" :
    entry.source === "builtin" ? tComp("permissionReviewStatusCard.sourceBuiltin") :
    tComp("permissionReviewStatusCard.sourceUnknown");
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
          {tComp("permissionReviewStatusCard.purposeLabel")} {entry.approvalPurpose.text}
        </div>
      )}
    </div>
  );
}
