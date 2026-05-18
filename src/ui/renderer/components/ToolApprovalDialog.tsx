import { useEffect, useRef, useState } from "react";
import type { UserApprovalScope, UserApprovalVerdict } from "../../../shared/permissions-events.js";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { SOURCE_BADGE } from "../constants.js";
import type { ApprovalChoice, ApprovalRequest } from "../types.js";
import { canonicalStringify as canonicalStringifyForRenderer } from "../../../shared/canonical-json.js";
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
  riskLevelKoLabel,
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
import { isWeakSandbox } from "../../../permissions/sandbox-capability.js";

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
  // R-4: NL justification (required for HIGH verdict approvals)
  const [nlJustification, setNlJustification] = useState("");
  // R-4: Scope selector ("session" | "persistent"). HIGH forces "session".
  const [scopeChoice, setScopeChoice] = useState<UserApprovalScope>("session");
  const nlInputRef = useRef<HTMLInputElement>(null);
  const suggestedPurpose =
    request?.approvalPurpose?.confidence === "sufficient"
      ? request.approvalPurpose.text.trim()
      : "";

  // Reset R-4 state when a new request arrives.
  useEffect(() => {
    setNlJustification(suggestedPurpose);
    setScopeChoice("session");
  }, [request?.id, suggestedPurpose]);

  const finalVerdict = request?.reviewerVerdict?.level ?? riskLevelForCategory(request?.toolCategory ?? "meta");

  // R-4: HIGH verdict → focus NL field when dialog opens.
  useEffect(() => {
    if (open && finalVerdict === "high" && suggestedPurpose.length === 0) {
      // Small delay so the dialog animation completes first.
      const t = setTimeout(() => nlInputRef.current?.focus(), 100);
      return () => clearTimeout(t);
    }
  }, [open, finalVerdict, suggestedPurpose.length]);

  // R-4: Approve is disabled for HIGH when NL field is empty.
  const approveDisabled = finalVerdict === "high" && nlJustification.trim().length === 0;

  // R-4: Wrap onDecide("allow-*") to record approval before deciding.
  // R-2 Round-3 CRITICAL: use canonicalStringify for args + propagate trustOrigin
  // + approvalCacheKey so that the record key matches the lookup key in
  // dispatchReviewer. Without this, R-2 memory hit rate is 0%.
  // Fire-and-await pattern: onDecide is called synchronously so the UI
  // responds immediately; the record IPC is awaited in the background so
  // test assertions on onDecide do not need to drain microtask queues.
  async function handleApprove(choice: ApprovalChoice, pattern?: string) {
    let recordPromise: Promise<unknown> | undefined;
    if (request) {
      // canonicalStringify: sort object keys so {a,b} and {b,a} produce the
      // same string — matching how dispatchReviewer builds the lookup key.
      const canonicalArgs = canonicalStringifyForRenderer(request.args ?? {});
      recordPromise = window.lvis?.userApproval?.record({
        requestId: request.id,
        toolName: request.toolName,
        args: canonicalArgs,
        source: request.source ?? "builtin",
        scope: finalVerdict === "high" ? "session" : scopeChoice,
        verdictAtApproval: finalVerdict as UserApprovalVerdict,
        nlJustification: finalVerdict === "high" ? nlJustification.trim() : null,
        trustOrigin: request.trustOrigin,
        approvalCacheKey: request.approvalCacheKey,
      }).catch((err: unknown) => {
        console.warn("[R-2] user-approval record failed (non-fatal):", err);
      });
    }
    // Call onDecide synchronously so the UI responds immediately.
    onDecide(choice, pattern);
    // Await the record promise in the background (non-blocking for the user).
    await recordPromise;
  }

  // 키보드 단축키 (disabled for HIGH when NL field empty)
  useEffect(() => {
    if (!open || !request) return;
    const handler = (e: KeyboardEvent) => {
      if (isTextEntryShortcutTarget(e.target)) return;
      if (e.key.toLowerCase() === "a" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (!approveDisabled) void handleApprove("allow-once");
      } else if (e.key.toLowerCase() === "d" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onDecide("deny-once");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, request, onDecide, approveDisabled]);

  if (!request) return null;

  const title = request.kind === "agent-action" ? "에이전트 작업 승인" : "도구 실행 승인";
  // NOTE: argsStr uses JSON.stringify for human-readable display (pretty-printed,
  // insertion-order keys). The IPC approval record uses canonicalStringify (#828)
  // which sorts object keys — key ordering may differ between what is shown here
  // and the canonical form used for cache-key lookups in dispatchReviewer.
  const argsStr = JSON.stringify(request.args, null, 2) ?? "";
  const argsTruncated = argsStr.length > 500 && !expanded;
  const argsDisplay = argsTruncated ? argsStr.slice(0, 500) + "\n…" : argsStr;
  const source = request.source ?? "unknown";
  const sourceBadge = request.source ? SOURCE_BADGE[request.source] ?? request.source : "알 수 없음";
  const hasPending = pendingCount > 1;
  const originLabel = trustOriginLabel(request.trustOrigin);
  const category = request.toolCategory ?? "meta";
  // finalVerdict already computed above (before the null-check guard) — use it here.
  const badgeClassName = levelBadgeClass(finalVerdict as RiskLevel);
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
                {/* Round-6 UX MAJOR — risk badge translated to Korean.
                    Raw English `LOW`/`MEDIUM`/`HIGH` is opaque to non-
                    technical Korean users and was the most prominent
                    visual element in the dialog. */}
                <Badge variant="outline" className={`${badgeClassName} shrink-0`}>
                  {riskLevelKoLabel(finalVerdict as RiskLevel)}
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
                {request.kind === "agent-action" && (
                  <>
                    <br />
                    플러그인: <code>{request.sourcePluginId ?? "알 수 없음"}</code>
                    <br />
                    승인 범위: <code>{request.approvalScope ?? "알 수 없음"}</code>
                  </>
                )}
              </SummaryTile>
              <SummaryTile label="권한 분류">
                {/* Round-6 UX MINOR — drop the raw English `category`
                    token; `categoryLabel()` already conveys it in
                    Korean and the duplicate looked like a code leak. */}
                {categoryLabel(category)}
              </SummaryTile>
            </div>

            <div className={`min-w-0 overflow-hidden rounded-md border ${reviewBoxClass(finalVerdict as RiskLevel)}`}>
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
                      className="max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed"
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

            {/* MAJOR 1.6: NL justification moved above collapsible details so it's
                visible without scrolling when the HIGH verdict disables Approve. */}
            {/* R-4: NL justification — required for HIGH verdict */}
            {finalVerdict === "high" && (
              <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                <Label
                  htmlFor="nl-justification"
                  className="mb-1.5 block text-xs font-semibold text-destructive"
                >
                  {suggestedPurpose.length > 0 ? "자동 작성된 작업 목적 (필수)" : "이 작업의 목적을 한 문장으로 입력하세요 (필수)"}
                  <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                    범위: 이 세션만 (HIGH 고정)
                  </span>
                </Label>
                <Input
                  id="nl-justification"
                  ref={nlInputRef}
                  type="text"
                  value={nlJustification}
                  onChange={(e) => setNlJustification(e.target.value)}
                  placeholder="예: 사용자 요청에 따라 프로젝트 디렉터리의 빌드 결과물 삭제"
                  maxLength={500}
                  className="h-8 text-xs"
                  data-testid="nl-justification-input"
                />
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {suggestedPurpose.length > 0
                    ? "대화 맥락에서 목적을 채웠습니다. 다르면 수정하세요. 세션 종료 후 재승인이 필요합니다."
                    : "높은 위험도 작업은 승인 사유를 기록합니다. 세션 종료 후 재승인이 필요합니다."}
                </p>
              </div>
            )}

            <details className="min-w-0 rounded-md border bg-muted/20">
              <summary className="cursor-pointer px-3 py-2 text-xs font-semibold">
                전체 입력 보기
              </summary>
              <pre className="max-h-56 max-w-full overflow-auto border-t px-3 py-2 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">
                {argsDisplay}
              </pre>
              {argsStr.length > 500 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto px-3 pb-2 pt-0 text-[11px] text-primary underline hover:bg-transparent"
                  onClick={() => setExpanded((v) => !v)}
                >
                  {expanded ? "접기" : "모두 보기"}
                </Button>
              )}
            </details>
          </div>

          {/* R-4: Scope selector — LOW/MEDIUM only (HIGH is always session) */}
          {finalVerdict !== "high" && (
            <div className="mt-3">
              <p className="mb-1.5 text-xs font-semibold">승인 범위</p>
              <RadioGroup
                value={scopeChoice}
                onValueChange={(v) => setScopeChoice(v as UserApprovalScope)}
                className="flex gap-4"
              >
                <div className="flex items-center gap-1.5">
                  <RadioGroupItem value="session" id="scope-session" />
                  <Label htmlFor="scope-session" className="text-xs">이 세션만</Label>
                </div>
                <div className="flex items-center gap-1.5">
                  <RadioGroupItem value="persistent" id="scope-persistent" />
                  <Label htmlFor="scope-persistent" className="text-xs">지속 허용</Label>
                </div>
              </RadioGroup>
            </div>
          )}

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
              onClick={() => void handleApprove("allow-always", request.toolName)}
              disabled={approveDisabled}
              title={approveDisabled ? "사유를 입력하세요" : undefined}
              aria-describedby={approveDisabled ? "nl-justification-hint" : undefined}
            >
              항상 허용
            </Button>
            <Button
              size="sm"
              variant="default"
              onClick={() => void handleApprove("allow-once")}
              disabled={approveDisabled}
              title={approveDisabled ? "사유를 입력하세요" : "단축키: A"}
              aria-describedby={approveDisabled ? "nl-justification-hint" : undefined}
              data-testid="approve-button"
            >
              한 번만 허용
            </Button>
            <span id="nl-justification-hint" className="sr-only">
              HIGH 위험 작업은 NL 사유 입력이 필수입니다
            </span>
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}

function isTextEntryShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(
    'input, textarea, select, [role="textbox"], [contenteditable="true"]',
  ) !== null;
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
    ? `${riskLevelKoLabel(request.reviewerVerdict.level)} · ${request.reviewerVerdict.reason}`
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
    // MAJOR-2.1 SOT consumer fix: per-kind Korean labels instead of
    // binary weak/strong. "partial" was incorrectly shown as "OS 격리
    // 없음" (factually wrong — partial isolation IS present), and
    // "fs-only" showed the raw English token "OS 격리 활성 (fs-only)".
    // Labels mirror formatSandboxCapabilityForPrompt() in sandbox-capability.ts
    // (the SOT) so UI and reviewer prompt agree.
    let sandboxValue: string;
    if (cap.kind === "partial") {
      sandboxValue = "⚠ OS 격리 부분적 (sandbox-exec) — 일부 제한만 적용됩니다";
    } else if (cap.kind === "fs-only") {
      sandboxValue = "ℹ 파일시스템만 격리 (landlock) — 네트워크 접근은 제한되지 않습니다";
    } else if (isWeakSandbox(cap)) {
      sandboxValue = "⚠ OS 격리 없음 — 도구가 추가 제한 없이 실행됩니다";
    } else {
      sandboxValue = `OS 격리 활성 (${cap.kind})`;
    }
    rows.push({
      label: "보안 격리",
      value: sandboxValue,
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
