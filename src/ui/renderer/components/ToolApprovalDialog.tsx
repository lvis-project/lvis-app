import { useEffect, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { SOURCE_BADGE } from "../constants.js";
import type { ApprovalChoice, ApprovalRequest } from "../types.js";
import { isNonUserTrustOrigin, trustOriginLabel } from "../utils/trust-origin-label.js";
import {
  SummaryTile,
  ReviewRow,
  categoryLabel,
  inputVolumeLabel,
  levelBadgeClass,
  payloadLabel,
  pickSummary,
  reviewBoxClass,
  reviewTitleForCategory,
  scopeLabel,
  sensitivityLabel,
  type ParsedSummary,
  type PermissionDecisionCategory,
  type ReviewBasisRow,
  type RiskLevel,
} from "./permissions/PermissionDecisionCard.js";
import {
  formatEvaluationLimits,
  PermissionEvaluationContextPanel,
} from "./permissions/PermissionEvaluationContextPanel.js";

export function ToolApprovalDialog({
  open,
  request,
  pendingCount = 1,
  onDecide,
}: {
  open: boolean;
  request: ApprovalRequest | null;
  pendingCount?: number;
  onDecide: (choice: ApprovalChoice, pattern?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // 키보드 단축키
  useEffect(() => {
    if (!open || !request) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "a" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onDecide("allow-once");
      } else if (e.key.toLowerCase() === "d" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onDecide("deny-once");
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onDecide("allow-once");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, request, onDecide]);

  if (!request) return null;

  const title = "도구 실행 승인";
  const argsStr = JSON.stringify(request.args, null, 2) ?? "";
  const argsTruncated = argsStr.length > 500 && !expanded;
  const argsDisplay = argsTruncated ? argsStr.slice(0, 500) + "\n…" : argsStr;
  const source = request.source ?? "unknown";
  const sourceBadge = request.source ? SOURCE_BADGE[request.source] ?? request.source : "알 수 없음";
  const hasPending = pendingCount > 1;
  const originLabel = trustOriginLabel(request.trustOrigin);
  const category = request.toolCategory ?? "meta";
  const riskLevel = request.reviewerVerdict?.level ?? riskLevelForCategory(category);
  const badgeClassName = levelBadgeClass(riskLevel);
  const rows = approvalReviewRows(request, category, argsStr, originLabel, source, sourceBadge);

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        size="lg"
        className="flex min-w-0 flex-col gap-0 overflow-hidden p-0"
        data-testid="tool-approval-dialog"
        onInteractOutside={(e) => {
          if (request.requireExplicit) {
            e.preventDefault();
          } else {
            void onDecide("deny-once");
          }
        }}
        onEscapeKeyDown={(e) => {
          if (request.requireExplicit) {
            e.preventDefault();
          } else {
            void onDecide("deny-once");
          }
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>현재 대화 루프에서 실행 전 사용자 승인이 필요한 도구 요청입니다.</DialogDescription>
        </DialogHeader>

        <section className="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-testid="tool-approval-card">
          <div className="flex min-w-0 items-start pb-3">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Badge variant="outline" className={`${badgeClassName} shrink-0`}>
                  {riskLevel.toUpperCase()}
                </Badge>
                <h3 className="min-w-0 flex-1 text-base font-semibold">
                  {title}
                </h3>
                {hasPending && (
                  <Badge variant="outline" className="shrink-0 text-[11px] text-muted-foreground">
                    대기 중 {pendingCount - 1}개
                  </Badge>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <div className="grid min-w-0 gap-2 sm:grid-cols-2">
              <SummaryTile label="도구 / 출처">
                <code>{request.toolName}</code>
                <br />
                출처: {sourceLabel(source)}
              </SummaryTile>
              <SummaryTile label="권한 분류">
                {categoryLabel(category)}
                <br />
                {category}
              </SummaryTile>
            </div>

            <div className={`min-w-0 overflow-hidden rounded-md border ${reviewBoxClass(riskLevel)}`}>
              <h4 className="border-b px-3 py-2 text-xs font-semibold">
                {reviewTitleForCategory(category)}
              </h4>
              {rows.map((row) => (
                <ReviewRow
                  key={row.label}
                  label={row.label}
                  // Round-3 UX MAJOR — prose rows now carry the testId
                  // on the row wrapper so we don't have to force human-
                  // readable text through `<pre>`.
                  testId={row.monospace ? undefined : row.testId}
                >
                  {row.monospace ? (
                    <pre
                      className="max-h-24 max-w-full overflow-hidden whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed"
                      data-testid={row.testId}
                    >
                      {row.value}
                    </pre>
                  ) : (
                    row.value
                  )}
                </ReviewRow>
              ))}
            </div>

            <PermissionEvaluationContextPanel context={request.evaluationContext} />

            <details className="min-w-0 rounded-md border bg-muted/20">
              <summary className="cursor-pointer px-3 py-2 text-xs font-semibold">
                전체 입력 보기
              </summary>
              <pre className="max-h-56 max-w-full overflow-auto border-t px-3 py-2 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">
                {argsDisplay}
              </pre>
              {argsStr.length > 500 && (
                <button
                  className="px-3 pb-2 text-[11px] text-primary underline"
                  onClick={() => setExpanded((v) => !v)}
                >
                  {expanded ? "접기" : "모두 보기"}
                </button>
              )}
            </details>
          </div>

          <div className="mt-4 flex flex-wrap justify-end gap-2 border-t pt-3">
            <Button
              size="sm"
              variant="outline"
              className="border-destructive text-destructive hover:bg-destructive/15"
              onClick={() => onDecide("deny-always", request.toolName)}
            >
              항상 거부
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onDecide("deny-once")}
              title="단축키: D"
            >
              거부
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onDecide("allow-always", request.toolName)}
            >
              항상 허용
            </Button>
            <Button
              size="sm"
              variant="default"
              onClick={() => onDecide("allow-once")}
              title="단축키: A 또는 Enter"
            >
              한 번만 허용
            </Button>
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}

function riskLevelForCategory(category: PermissionDecisionCategory): RiskLevel {
  if (category === "shell") return "high";
  if (category === "write" || category === "network" || category === "meta") return "medium";
  return "low";
}

function parseArgs(args: unknown): ParsedSummary | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  return args as ParsedSummary;
}

function approvalReviewRows(
  request: ApprovalRequest,
  category: PermissionDecisionCategory,
  inputSummary: string,
  originLabel: string,
  source: string,
  sourceBadge: string,
): ReviewBasisRow[] {
  const parsed = parseArgs(request.args);
  const reviewer = request.reviewerVerdict
    ? `${request.reviewerVerdict.level.toUpperCase()} · ${request.reviewerVerdict.reason}`
    : request.reason;
  const rows: ReviewBasisRow[] = [
    {
      label: "출처",
      value: `${sourceBadge} · ${originLabel}`,
    },
  ];
  // Issue #691 round-1 user request — surface the OS-level execution
  // sandbox so the user sees how this tool will be isolated (or not).
  // `kind: "none"` is the current real-world state; the row stays
  // present so users learn to look for it once isolation lands.
  if (request.sandboxCapability) {
    const cap = request.sandboxCapability;
    const weak = cap.kind === "none" || cap.confidence === "assumed";
    rows.push({
      label: "격리",
      // Round-3 UX MAJOR — human-readable prose, not terminal output.
      // Now that `ReviewRow` accepts `testId` directly, the row renders
      // in the normal prose branch with proper line-wrap and screen-
      // reader semantics.
      value: weak
        ? `⚠ ${cap.kind} (${cap.confidence}, ${cap.platform}) — ${cap.reason}`
        : `${cap.kind} (${cap.confidence}, ${cap.platform})`,
      testId: "tool-approval-sandbox",
    });
  }
  if (isNonUserTrustOrigin(request.trustOrigin)) {
    rows.push({
      label: "주의",
      value: `이 요청은 사용자가 직접 입력한 명령이 아니라 ${originLabel}에서 시작되었습니다. 도구 인자와 대상 경로를 확인한 뒤 승인하세요.`,
    });
  }

  if (category === "read") {
    rows.push(
      { label: "대상", value: request.target?.filePath ?? pickSummary(parsed, ["path", "paths", "target", "targets", "file", "directory", "resource", "query", "url", "uri"], inputSummary), monospace: true, testId: "tool-approval-input" },
      { label: "범위", value: `${sourceLabel(source)} · ${categoryLabel(category)} · ${scopeLabel(parsed)}` },
      { label: "민감도", value: sensitivityLabel(parsed) },
      { label: "양", value: inputVolumeLabel(inputSummary) },
    );
  } else if (category === "write") {
    rows.push(
      { label: "대상", value: request.target?.filePath ?? pickSummary(parsed, ["path", "paths", "target", "targets", "file", "configKey", "taskId", "id"], inputSummary), monospace: true, testId: "tool-approval-input" },
      { label: "변경", value: pickSummary(parsed, ["operation", "action", "mode", "patch", "content", "body", "text"], "변경 내용은 입력 요약 기준으로 확인합니다."), monospace: true },
      { label: "영향", value: `${sourceLabel(source)} · ${categoryLabel(category)} · 파일/설정/사용자 데이터 변경 가능성` },
      { label: "복구", value: pickSummary(parsed, ["diff", "backup", "rollback", "undo"], "복구 정보는 입력 요약에 명시되지 않음") },
    );
  } else if (category === "network") {
    rows.push(
      { label: "엔드포인트", value: pickSummary(parsed, ["endpoint", "url", "uri", "host", "baseUrl"], "엔드포인트 정보는 입력 요약에 명시되지 않음"), monospace: true, testId: "tool-approval-input" },
      { label: "메서드", value: pickSummary(parsed, ["method", "httpMethod"], "메서드 정보는 입력 요약에 명시되지 않음") },
      { label: "전송 내용", value: pickSummary(parsed, ["payload", "body", "message", "text", "input", "params", "args"], payloadLabel(inputSummary)), monospace: true },
      { label: "인증 범위", value: pickSummary(parsed, ["auth", "scope", "scopes", "tenant", "account"], "인증 범위 정보는 입력 요약에 명시되지 않음") },
    );
  } else if (category === "shell") {
    rows.push(
      { label: "명령", value: pickSummary(parsed, ["command", "cmd", "args", "script", "argv"], inputSummary), monospace: true, testId: "tool-approval-input" },
      { label: "작업 디렉토리/환경", value: pickSummary(parsed, ["cwd", "workingDirectory", "env", "environment"], "작업 디렉토리/환경 정보는 입력 요약에 명시되지 않음"), monospace: true },
      { label: "부작용", value: "파일 변경, 네트워크 호출, dependency install, background process 가능성을 명령 기준으로 확인합니다." },
      { label: "제한", value: formatEvaluationLimits(request.evaluationContext) },
    );
  } else {
    rows.push({
      label: "입력",
      value: inputSummary,
      monospace: true,
      testId: "tool-approval-input",
    });
  }

  rows.push(
    { label: "판단", value: reviewer },
    { label: "선택", value: "이번만 허용, 항상 허용, 거부, 항상 거부를 선택할 수 있습니다." },
  );
  return rows;
}

function sourceLabel(source: string): string {
  return SOURCE_BADGE[source] ?? source;
}
