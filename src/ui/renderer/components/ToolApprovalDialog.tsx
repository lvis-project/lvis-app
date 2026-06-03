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
import { useTranslation } from "../../../i18n/react.js";
import { t } from "../../../i18n/runtime.js";

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
  const { t: tHook } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  // NL justification (required for HIGH verdict approvals)
  const [nlJustification, setNlJustification] = useState("");
  // Scope selector ("session" | "persistent"). HIGH forces "session".
  const [scopeChoice, setScopeChoice] = useState<UserApprovalScope>("session");
  const nlInputRef = useRef<HTMLInputElement>(null);
  const suggestedPurpose =
    request?.approvalPurpose?.source === "conversation" &&
    request.approvalPurpose.confidence === "sufficient"
      ? request.approvalPurpose.text.trim()
      : "";

  // Reset NL/scope state when a new request arrives.
  useEffect(() => {
    setNlJustification(suggestedPurpose);
    setScopeChoice("session");
  }, [request?.id, suggestedPurpose]);

  const finalVerdict = request?.reviewerVerdict?.level ?? riskLevelForCategory(request?.toolCategory ?? "meta");

  // HIGH verdict → focus NL field when dialog opens.
  useEffect(() => {
    if (open && finalVerdict === "high" && suggestedPurpose.length === 0) {
      // Small delay so the dialog animation completes first.
      const t = setTimeout(() => nlInputRef.current?.focus(), 100);
      return () => clearTimeout(t);
    }
  }, [open, finalVerdict, suggestedPurpose.length]);

  // Approve is disabled for HIGH when NL field is empty.
  const approveDisabled = finalVerdict === "high" && nlJustification.trim().length === 0;

  // Wrap onDecide("allow-*") to record approval before deciding.
  // CRITICAL: use canonicalStringify for args + propagate trustOrigin
  // + approvalCacheKey so that the record key matches the lookup key in
  // dispatchReviewer. Without this, user-approval memory hit rate is 0%.
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
        console.warn("[user-approval] record failed (non-fatal):", err);
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

  const title = request.kind === "agent-action" ? tHook("toolApprovalDialog.agentActionTitle") : tHook("toolApprovalDialog.toolApprovalTitle");
  // NOTE: argsStr uses JSON.stringify for human-readable display (pretty-printed,
  // insertion-order keys). The IPC approval record uses canonicalStringify (#828)
  // which sorts object keys — key ordering may differ between what is shown here
  // and the canonical form used for cache-key lookups in dispatchReviewer.
  const argsStr = JSON.stringify(request.args, null, 2) ?? "";
  const argsTruncated = argsStr.length > 500 && !expanded;
  const argsDisplay = argsTruncated ? argsStr.slice(0, 500) + "\n…" : argsStr;
  const source = request.source ?? "unknown";
  const sourceBadge = request.source ? SOURCE_BADGE[request.source] ?? request.source : tHook("toolApprovalDialog.unknown");
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
          <DialogDescription>{tHook("toolApprovalDialog.dialogDescription")}</DialogDescription>
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
                    {tHook("toolApprovalDialog.pendingCount", { count: pendingCount - 1 })}
                  </Badge>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <div className="grid min-w-0 gap-2 sm:grid-cols-2">
              <SummaryTile label={tHook("toolApprovalDialog.tileToolSource")}>
                <code>{request.toolName}</code>
                <br />
                {tHook("toolApprovalDialog.sourcePrefix")}: {sourceLabel(source)}
                {request.kind === "agent-action" && (
                  <>
                    <br />
                    {tHook("toolApprovalDialog.pluginPrefix")}: <code>{request.sourcePluginId ?? tHook("toolApprovalDialog.unknown")}</code>
                    <br />
                    {tHook("toolApprovalDialog.approvalScopePrefix")}: <code>{request.approvalScope ?? tHook("toolApprovalDialog.unknown")}</code>
                  </>
                )}
              </SummaryTile>
              <SummaryTile label={tHook("toolApprovalDialog.tilePermissionCategory")}>
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
            {/* NL justification — required for HIGH verdict */}
            {finalVerdict === "high" && (
              <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                <Label
                  htmlFor="nl-justification"
                  className="mb-1.5 block text-xs font-semibold text-destructive"
                >
                  {suggestedPurpose.length > 0 ? tHook("toolApprovalDialog.nlLabelAutoFilled") : tHook("toolApprovalDialog.nlLabelEnterPurpose")}
                  <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                    {tHook("toolApprovalDialog.nlScopeSessionFixed")}
                  </span>
                </Label>
                <Input
                  id="nl-justification"
                  ref={nlInputRef}
                  type="text"
                  value={nlJustification}
                  onChange={(e) => setNlJustification(e.target.value)}
                  placeholder={tHook("toolApprovalDialog.nlPlaceholder")}
                  maxLength={500}
                  className="h-8 text-xs"
                  data-testid="nl-justification-input"
                />
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {suggestedPurpose.length > 0
                    ? tHook("toolApprovalDialog.nlHintAutoFilled")
                    : tHook("toolApprovalDialog.nlHintHighRisk")}
                </p>
              </div>
            )}

            <details className="min-w-0 rounded-md border bg-muted/20">
              <summary className="cursor-pointer px-3 py-2 text-xs font-semibold">
                {tHook("toolApprovalDialog.showFullInput")}
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
                  {expanded ? tHook("toolApprovalDialog.collapse") : tHook("toolApprovalDialog.showAll")}
                </Button>
              )}
            </details>
          </div>

          {/* Scope selector — LOW/MEDIUM only (HIGH is always session) */}
          {finalVerdict !== "high" && (
            <div className="mt-3">
              <p className="mb-1.5 text-xs font-semibold">{tHook("toolApprovalDialog.approvalScope")}</p>
              <RadioGroup
                value={scopeChoice}
                onValueChange={(v) => setScopeChoice(v as UserApprovalScope)}
                className="flex gap-4"
              >
                <div className="flex items-center gap-1.5">
                  <RadioGroupItem value="session" id="scope-session" />
                  <Label htmlFor="scope-session" className="text-xs">{tHook("toolApprovalDialog.scopeSession")}</Label>
                </div>
                <div className="flex items-center gap-1.5">
                  <RadioGroupItem value="persistent" id="scope-persistent" />
                  <Label htmlFor="scope-persistent" className="text-xs">{tHook("toolApprovalDialog.scopePersistent")}</Label>
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
              {tHook("toolApprovalDialog.denyAlways")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onDecide("deny-once")}
              title={tHook("toolApprovalDialog.shortcutD")}
            >
              {tHook("toolApprovalDialog.denyOnce")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleApprove("allow-always", request.toolName)}
              disabled={approveDisabled}
              title={approveDisabled ? tHook("toolApprovalDialog.enterReason") : undefined}
              aria-describedby={approveDisabled ? "nl-justification-hint" : undefined}
            >
              {tHook("toolApprovalDialog.allowAlways")}
            </Button>
            <Button
              size="sm"
              variant="default"
              onClick={() => void handleApprove("allow-once")}
              disabled={approveDisabled}
              title={approveDisabled ? tHook("toolApprovalDialog.enterReason") : tHook("toolApprovalDialog.shortcutA")}
              aria-describedby={approveDisabled ? "nl-justification-hint" : undefined}
              data-testid="approve-button"
            >
              {tHook("toolApprovalDialog.allowOnce")}
            </Button>
            <span id="nl-justification-hint" className="sr-only">
              {tHook("toolApprovalDialog.highRiskNlRequired")}
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
      label: t("toolApprovalDialog.rowSource"),
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
      sandboxValue = t("toolApprovalDialog.sandboxPartial");
    } else if (cap.kind === "fs-only") {
      sandboxValue = t("toolApprovalDialog.sandboxFsOnly");
    } else if (isWeakSandbox(cap)) {
      sandboxValue = t("toolApprovalDialog.sandboxNone");
    } else {
      sandboxValue = t("toolApprovalDialog.sandboxActive", { kind: cap.kind });
    }
    rows.push({
      label: t("toolApprovalDialog.rowSandbox"),
      value: sandboxValue,
      testId: "tool-approval-sandbox",
    });
  }
  if (isNonUserTrustOrigin(request.trustOrigin)) {
    rows.push({
      label: t("toolApprovalDialog.rowCaution"),
      value: t("toolApprovalDialog.cautionNonUserOrigin", { originLabel }),
    });
  }

  if (category === "read") {
    rows.push(
      { label: t("toolApprovalDialog.rowTarget"), value: request.target?.filePath ?? pickSummary(parsed, ["path", "paths", "target", "targets", "file", "directory", "resource", "query", "url", "uri"], inputSummary), monospace: true, testId: "tool-approval-input" },
      { label: t("toolApprovalDialog.rowScope"), value: `${sourceLabel(source)} · ${categoryLabel(category)} · ${scopeLabel(parsed)}` },
      { label: t("toolApprovalDialog.rowSensitivity"), value: sensitivityLabel(parsed) },
      { label: t("toolApprovalDialog.rowVolume"), value: inputVolumeLabel(inputSummary) },
    );
  } else if (category === "write") {
    rows.push(
      { label: t("toolApprovalDialog.rowTarget"), value: request.target?.filePath ?? pickSummary(parsed, ["path", "paths", "target", "targets", "file", "configKey", "taskId", "id"], inputSummary), monospace: true, testId: "tool-approval-input" },
      { label: t("toolApprovalDialog.rowChange"), value: pickSummary(parsed, ["operation", "action", "mode", "patch", "content", "body", "text"], t("toolApprovalDialog.changeNotSpecified")), monospace: true },
      { label: t("toolApprovalDialog.rowImpact"), value: `${sourceLabel(source)} · ${categoryLabel(category)} · ${t("toolApprovalDialog.impactNote")}` },
      { label: t("toolApprovalDialog.rowRecovery"), value: pickSummary(parsed, ["diff", "backup", "rollback", "undo"], t("toolApprovalDialog.recoveryNotSpecified")) },
    );
  } else if (category === "network") {
    rows.push(
      { label: t("toolApprovalDialog.rowEndpoint"), value: pickSummary(parsed, ["endpoint", "url", "uri", "host", "baseUrl"], t("toolApprovalDialog.endpointNotSpecified")), monospace: true, testId: "tool-approval-input" },
      { label: t("toolApprovalDialog.rowMethod"), value: pickSummary(parsed, ["method", "httpMethod"], t("toolApprovalDialog.methodNotSpecified")) },
      { label: t("toolApprovalDialog.rowPayload"), value: pickSummary(parsed, ["payload", "body", "message", "text", "input", "params", "args"], payloadLabel(inputSummary)), monospace: true },
      { label: t("toolApprovalDialog.rowAuthScope"), value: pickSummary(parsed, ["auth", "scope", "scopes", "tenant", "account"], t("toolApprovalDialog.authScopeNotSpecified")) },
    );
  } else if (category === "shell") {
    rows.push(
      { label: t("toolApprovalDialog.rowCommand"), value: pickSummary(parsed, ["command", "cmd", "args", "script", "argv"], inputSummary), monospace: true, testId: "tool-approval-input" },
      { label: t("toolApprovalDialog.rowCwdEnv"), value: pickSummary(parsed, ["cwd", "workingDirectory", "env", "environment"], t("toolApprovalDialog.cwdEnvNotSpecified")), monospace: true },
      { label: t("toolApprovalDialog.rowSideEffects"), value: t("toolApprovalDialog.sideEffectsNote") },
      { label: t("toolApprovalDialog.rowLimits"), value: formatEvaluationLimits(request.evaluationContext) },
    );
  } else {
    rows.push({
      label: t("toolApprovalDialog.rowInput"),
      value: inputSummary,
      monospace: true,
      testId: "tool-approval-input",
    });
  }

  rows.push(
    { label: t("toolApprovalDialog.rowVerdict"), value: reviewer },
    { label: t("toolApprovalDialog.rowChoice"), value: t("toolApprovalDialog.choiceDescription") },
  );
  return rows;
}

function sourceLabel(source: string): string {
  return SOURCE_BADGE[source] ?? source;
}
