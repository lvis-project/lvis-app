import type { PermissionEvaluationContext } from "../../types.js";
import { categoryLabel, ReviewRow } from "./PermissionDecisionCard.js";

function formatList(values: readonly string[], emptyText: string): string {
  return values.length > 0 ? values.join("\n") : emptyText;
}

export function formatEvaluationLimits(context?: PermissionEvaluationContext): string {
  if (!context) return "검증 환경 context 없음";
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
  if (!context) {
    return (
      <section
        className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs"
        data-testid="permission-evaluation-context-missing"
      >
        검증 환경 payload 가 포함되지 않았습니다. 이 요청은 권한 평가 context 를 재구성하지 않습니다.
      </section>
    );
  }

  return (
    <details
      className="min-w-0 rounded-md border bg-muted/20"
      data-testid="permission-evaluation-context"
    >
      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold">
        검증 환경 / 샌드박스 평가
      </summary>
      <div className="border-t">
        <ReviewRow label="정책">
          {context.policyMode} · {context.headless ? "headless" : "foreground"} · {context.version}
        </ReviewRow>
        <ReviewRow label="출처">
          {context.source} · {categoryLabel(context.category)} · {context.trustOrigin}
        </ReviewRow>
        <ReviewRow label="작업 위치">
          <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
            {context.executionCwd}
          </pre>
        </ReviewRow>
        <ReviewRow label="허용 경로">
          <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
            {formatList(context.allowedDirectories, "허용 경로 없음")}
          </pre>
        </ReviewRow>
        <ReviewRow label="대상 경로">
          <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
            {formatList(context.targetFilePaths, "대상 경로 없음")}
          </pre>
        </ReviewRow>
        <ReviewRow label="리뷰어 입력">
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
