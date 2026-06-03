import type { PermissionEvaluationContext } from "../../types.js";
import { useTranslation } from "../../../../i18n/react.js";
import { t } from "../../../../i18n/runtime.js";
import { categoryLabel, ReviewRow } from "./PermissionDecisionCard.js";

function formatList(values: readonly string[], emptyText: string): string {
  return values.length > 0 ? values.join("\n") : emptyText;
}

export function formatEvaluationLimits(context?: PermissionEvaluationContext): string {
  if (!context) return t("permissionEvaluationContextPanel.noContext");
  return [
    `policy=${context.policyMode}`,
    `headless=${context.headless ? "yes" : "no"}`,
    `cwd=${context.executionCwd}`,
    `allowedDirectories=${context.allowedDirectories.length}`,
  ].join(" · ");
}

export function PermissionEvaluationContextPanel({
  context,
}: {
  context?: PermissionEvaluationContext;
}) {
  const { t } = useTranslation();

  if (!context) {
    return (
      <section
        className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs"
        data-testid="permission-evaluation-context-missing"
      >
        {t("permissionEvaluationContextPanel.missingPayload")}
      </section>
    );
  }

  return (
    <details
      className="min-w-0 rounded-md border bg-muted/20"
      data-testid="permission-evaluation-context"
    >
      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold">
        {t("permissionEvaluationContextPanel.title")}
      </summary>
      <div className="border-t">
        <ReviewRow label={t("permissionEvaluationContextPanel.labelPolicy")}>
          {context.policyMode} · {context.headless ? "headless" : "foreground"} · {context.version}
        </ReviewRow>
        <ReviewRow label={t("permissionEvaluationContextPanel.labelSource")}>
          {context.source} · {categoryLabel(context.category)} · {context.trustOrigin}
        </ReviewRow>
        <ReviewRow label={t("permissionEvaluationContextPanel.labelWorkingDir")}>
          <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
            {context.executionCwd}
          </pre>
        </ReviewRow>
        <ReviewRow label={t("permissionEvaluationContextPanel.labelAllowedPaths")}>
          <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
            {formatList(context.allowedDirectories, t("permissionEvaluationContextPanel.emptyAllowedPaths"))}
          </pre>
        </ReviewRow>
        <ReviewRow label={t("permissionEvaluationContextPanel.labelTargetPaths")}>
          <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
            {formatList(context.targetFilePaths, t("permissionEvaluationContextPanel.emptyTargetPaths"))}
          </pre>
        </ReviewRow>
        <ReviewRow label={t("permissionEvaluationContextPanel.labelReviewerInput")}>
          <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
            {[
              `framework=${context.reviewerFrameworkVersion}`,
              `pathFields=${context.pathFields.join(", ") || "(none)"}`,
              `sensitive=${context.sensitivePathsAdjacent.join(", ") || "(none)"}`,
            ].join("\n")}
          </pre>
        </ReviewRow>
      </div>
    </details>
  );
}
