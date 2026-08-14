import { AlertTriangle, CheckCircle2, Loader2, ShieldQuestion } from "lucide-react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { t } from "../../../i18n/runtime.js";
import { useTranslation } from "../../../i18n/react.js";

type PermissionReviewEntry = Extract<ChatEntry, { kind: "permission_review" }>;

function statusLabel(entry: PermissionReviewEntry): string {
  if (entry.status === "reviewing") return t("permissionReviewStatusCard.reviewing");
  if (entry.status === "auto_approved") return t("permissionReviewStatusCard.autoApproved");
  if (entry.status === "failed") return t("permissionReviewStatusCard.failed");
  // A parent agent answered this one. Without these two the fall-through below
  // would label a decided call "approval required", which is the opposite of
  // what happened.
  if (entry.status === "parent_approved") {
    return t("permissionReviewStatusCard.parentApproved");
  }
  if (entry.status === "parent_denied") {
    return t("permissionReviewStatusCard.parentDenied");
  }
  const level =
    entry.verdictLevel === "high" ? t("permissionReviewStatusCard.riskHigh") :
    entry.verdictLevel === "medium" ? t("permissionReviewStatusCard.riskMedium") :
    entry.verdictLevel === "low" ? t("permissionReviewStatusCard.riskLow") :
    t("permissionReviewStatusCard.reviewComplete");
  return t("permissionReviewStatusCard.approvalRequired", { level });
}

function toneClass(entry: PermissionReviewEntry): string {
  if (entry.status === "reviewing") {
    return "border-info/(--opacity-medium) bg-info/(--opacity-faint) text-info";
  }
  if (entry.status === "auto_approved" || entry.status === "parent_approved") {
    return "border-success/(--opacity-medium) bg-success/(--opacity-faint) text-success";
  }
  if (
    entry.status === "failed" ||
    entry.status === "parent_denied" ||
    entry.verdictLevel === "high"
  ) {
    return "border-destructive/(--opacity-medium) bg-destructive/(--opacity-faint) text-destructive";
  }
  return "border-warning/(--opacity-medium) bg-warning/(--opacity-subtle) text-warning";
}

function StatusIcon({ entry }: { entry: PermissionReviewEntry }) {
  if (entry.status === "reviewing") return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />;
  if (entry.status === "auto_approved" || entry.status === "parent_approved") {
    return <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />;
  }
  if (
    entry.status === "failed" ||
    entry.status === "parent_denied" ||
    entry.verdictLevel === "high"
  ) {
    return <AlertTriangle className="h-3.5 w-3.5 shrink-0" />;
  }
  return <ShieldQuestion className="h-3.5 w-3.5 shrink-0" />;
}

/**
 * `attached` is the variant rendered inside the tool row that the verdict
 * belongs to (ToolGroupCard). Tool name and source are already on that row, so
 * the chip carries only the verdict — which is also the exact field set that
 * survives persistence, keeping live and reloaded transcripts identical.
 */
export function PermissionReviewStatusCard({
  entry,
  variant = "standalone",
}: {
  entry: PermissionReviewEntry;
  variant?: "standalone" | "attached";
}) {
  const { t: tComp } = useTranslation();
  const source = entry.source === "plugin" ? tComp("permissionReviewStatusCard.sourcePlugin") :
    entry.source === "mcp" ? "MCP" :
    entry.source === "builtin" ? tComp("permissionReviewStatusCard.sourceBuiltin") :
    tComp("permissionReviewStatusCard.sourceUnknown");
  if (variant === "attached") {
    return (
      <div
        data-testid="permission-review-status-card"
        data-status={entry.status}
        data-variant="attached"
        role="status"
        aria-live="polite"
        className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] [&_svg]:h-3 [&_svg]:w-3 ${toneClass(entry)}`}
      >
        <StatusIcon entry={entry} />
        <span className="min-w-0 truncate font-medium">{statusLabel(entry)}</span>
      </div>
    );
  }
  return (
    <div
      data-testid="permission-review-status-card"
      data-status={entry.status}
      data-variant="standalone"
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
