




import type { CheckpointTrigger } from "../../../lib/chat-stream-state.js";
import { useTranslation } from "../../../i18n/react.js";

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
    label: "checkpointDivider.statusSummarized",
    icon: "📦",
    lineCls: "bg-action-compact/(--opacity-muted)",
    textCls: "text-action-compact/(--opacity-intense)",
  },
  content_truncated: {
    label: "checkpointDivider.statusContentTruncated",
    icon: "✂️",
    lineCls: "bg-warning/(--opacity-medium)",
    textCls: "text-warning/(--opacity-near)",
  },
  noop: {
    label: "checkpointDivider.statusNoop",
    icon: "✓",
    lineCls: "bg-muted-foreground/25",
    textCls: "text-muted-foreground/(--opacity-stronger)",
  },
  reduced_insufficient_forced: {
    label: "checkpointDivider.statusReducedInsufficient",
    icon: "⚠️",
    lineCls: "bg-destructive/(--opacity-medium)",
    textCls: "text-destructive/(--opacity-near)",
  },
};

const TRIGGER_VARIANTS: Record<CheckpointTrigger | "default", Variant> = {
  "auto-compact": {
    label: "checkpointDivider.triggerAutoCompact",
    icon: "📌",
    lineCls: "bg-action-compact/(--opacity-muted)",
    textCls: "text-action-compact/(--opacity-intense)",
  },
  "manual": {
    label: "checkpointDivider.triggerManual",
    icon: "✋",
    lineCls: "bg-muted-foreground/35",
    textCls: "text-muted-foreground/(--opacity-intense)",
  },
  default: {
    label: "checkpointDivider.triggerAutoCompact",
    icon: "📌",
    lineCls: "bg-action-compact/(--opacity-muted)",
    textCls: "text-action-compact/(--opacity-intense)",
  },
};

export function CheckpointDivider({
  trigger,
  messageCount,
  compactNum,
  compactStatus,
  truncatedDir,
  onEnterView,
  onBranchFrom,
}: {
  trigger?: CheckpointTrigger;
  messageCount: number;
  /** Compact sequence number — enables view/branch action buttons. */
  compactNum?: number;

  compactStatus?: CompactStatus;

  truncatedDir?: string;
  /** Enter view-mode for this checkpoint. */
  onEnterView?: (compactNum: number) => void | Promise<void>;
  /** Fork a new session from this checkpoint. */
  onBranchFrom?: (compactNum: number) => void | Promise<void>;
}) {
  const { t } = useTranslation();

  const variant: Variant = compactStatus !== undefined
    ? STATUS_VARIANTS[compactStatus]
    : TRIGGER_VARIANTS[trigger ?? "default"];


  const hasBoundary = compactStatus === undefined
    || compactStatus === "summarized"
    || compactStatus === "reduced_insufficient_forced";
  const hasActions =
    hasBoundary && compactNum !== undefined && (onEnterView !== undefined || onBranchFrom !== undefined);
  return (
    <div
      data-testid="checkpoint-divider"
      data-trigger={trigger ?? "default"}
      data-compact-status={compactStatus ?? "summarized"}
      data-compact-num={compactNum}
      className="my-2 flex flex-col gap-1.5 py-2"
    >
      <div className="flex items-center gap-2">
        <span className={`h-px flex-1 ${variant.lineCls}`} />
        <span className={`text-[10px] ${variant.textCls} font-medium`}>
          {"───"} {variant.icon} {t("checkpointDivider.checkpoint")}{compactNum !== undefined ? ` #${compactNum}` : ""} · {t(variant.label)} ({t("checkpointDivider.messageCount", { count: messageCount })}) {"───"}
        </span>
        <span className={`h-px flex-1 ${variant.lineCls}`} />
      </div>
      {truncatedDir !== undefined && (
        <div className="px-4 text-center text-[9.5px] text-muted-foreground/(--opacity-stronger)">
          {t("checkpointDivider.originalPreserved", { dir: truncatedDir })}
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
              aria-label={t("checkpointDivider.viewAriaLabel", { num: compactNum })}
            >
              📖 {t("checkpointDivider.viewButton")}
            </button>
          )}
          {onBranchFrom !== undefined && compactNum !== undefined && (
            <button
              type="button"
              data-testid="ck-btn-fork"
              onClick={() => { void onBranchFrom(compactNum); }}
              className="rounded-md border border-[hsl(var(--action-branch)/0.35)] bg-[hsl(var(--action-branch)/0.08)] px-3 py-1 text-[10.5px] font-medium text-[hsl(var(--action-branch))] transition-colors hover:bg-[hsl(var(--action-branch)/0.18)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--action-branch)/0.4)]"
              aria-label={t("checkpointDivider.branchAriaLabel", { num: compactNum })}
            >
              ↩ {t("checkpointDivider.branchButton")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
