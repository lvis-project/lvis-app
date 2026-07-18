import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UserApprovalScope, UserApprovalVerdict } from "../../../shared/permissions-events.js";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { NativeSelect, NativeSelectOption } from "../../../components/ui/native-select.js";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { SOURCE_BADGE } from "../constants.js";
import type { ApprovalDecisionExtras } from "../hooks/use-approval.js";
import type { ApprovalChoice, ApprovalRequest } from "../types.js";
import { canonicalStringify as canonicalStringifyForRenderer } from "../../../shared/canonical-json.js";
import {
  parseRationaleApprovalDisplay,
  type RationaleApprovalDisplay,
} from "../../../shared/rationale-approval-display.js";
import { isNonUserTrustOrigin, trustOriginLabel } from "../utils/trust-origin-label.js";
import {
  SummaryTile,
  ReviewRow,
  categoryLabel,
  levelBadgeClass,
  pickSummary,
  reviewBoxClass,
  reviewTitleForCategory,
  riskLevelKoLabel,
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
import { useTranslation } from "../../../i18n/react.js";
import { t } from "../../../i18n/runtime.js";

type ElicitationFieldKind = "string" | "number" | "integer" | "boolean";
type ElicitationFormValue = string | boolean;

type ElicitationEnumOption = {
  key: string;
  label: string;
  value: unknown;
};

type ElicitationField = {
  name: string;
  label: string;
  description?: string;
  kind: ElicitationFieldKind;
  required: boolean;
  defaultValue?: unknown;
  enumOptions?: ElicitationEnumOption[];
};

type ElicitationSchemaParseResult =
  | { supported: true; fields: ElicitationField[] }
  | { supported: false; fields: [] };

const MAX_ELICITATION_FIELDS = 12;
const ELICITATION_FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const INTEGER_INPUT_RE = /^[+-]?\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function scalarLabel(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function buildEnumOptions(raw: unknown): ElicitationEnumOption[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const options = raw
    .map((value, index): ElicitationEnumOption | null => {
      const label = scalarLabel(value);
      return label.length > 0 ? { key: String(index), label, value } : null;
    })
    .filter((option): option is ElicitationEnumOption => option !== null);
  return options.length === raw.length ? options : undefined;
}

function normalizeElicitationKind(rawType: unknown): ElicitationFieldKind | undefined {
  if (rawType === "boolean" || rawType === "number" || rawType === "integer") {
    return rawType;
  }
  if (rawType === "string") return "string";
  return undefined;
}

function parseElicitationFields(args: unknown): ElicitationSchemaParseResult {
  if (!isRecord(args)) return { supported: false, fields: [] };
  const schema = isRecord(args.requestedSchema) ? args.requestedSchema : null;
  if (!schema || schema.type !== "object" || !isRecord(schema.properties)) {
    return { supported: false, fields: [] };
  }
  const propertyEntries = Object.entries(schema.properties);
  if (propertyEntries.length > MAX_ELICITATION_FIELDS) return { supported: false, fields: [] };
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) || !schema.required.every((name) => typeof name === "string"))
  ) {
    return { supported: false, fields: [] };
  }
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : [],
  );
  const fields: ElicitationField[] = [];
  for (const [name, rawProperty] of propertyEntries) {
    if (!ELICITATION_FIELD_NAME_RE.test(name) || !isRecord(rawProperty)) {
      return { supported: false, fields: [] };
    }
    const property = rawProperty;
    const title = typeof property.title === "string" && property.title.trim().length > 0
      ? property.title.trim()
      : name;
    const description = typeof property.description === "string" && property.description.trim().length > 0
      ? property.description.trim()
      : undefined;
    const enumOptions = buildEnumOptions(property.enum);
    if (property.enum !== undefined && !enumOptions) return { supported: false, fields: [] };
    const declaredKind = normalizeElicitationKind(property.type);
    if (property.type !== undefined && !declaredKind) return { supported: false, fields: [] };
    const kind = enumOptions ? declaredKind ?? "string" : declaredKind;
    if (!kind) return { supported: false, fields: [] };
    fields.push({
      name,
      label: title,
      ...(description ? { description } : {}),
      kind,
      required: required.has(name),
      defaultValue: property.default,
      ...(enumOptions ? { enumOptions } : {}),
    });
  }
  for (const requiredName of required) {
    if (!fields.some((field) => field.name === requiredName)) {
      return { supported: false, fields: [] };
    }
  }
  return { supported: true, fields };
}

function initialElicitationValues(fields: readonly ElicitationField[]): Record<string, ElicitationFormValue> {
  const values: Record<string, ElicitationFormValue> = {};
  for (const field of fields) {
    if (field.enumOptions) {
      const defaultIndex = field.enumOptions.findIndex((option) => option.value === field.defaultValue);
      values[field.name] = defaultIndex >= 0 ? String(defaultIndex) : "";
    } else if (field.kind === "boolean") {
      values[field.name] = typeof field.defaultValue === "boolean" ? field.defaultValue : false;
    } else if (typeof field.defaultValue === "string" || typeof field.defaultValue === "number") {
      values[field.name] = String(field.defaultValue);
    } else {
      values[field.name] = "";
    }
  }
  return values;
}

function isNumericFieldInvalid(field: ElicitationField, value: ElicitationFormValue | undefined): boolean {
  if (field.kind !== "number" && field.kind !== "integer") return false;
  if (typeof value !== "string" || value.trim().length === 0) return false;
  const trimmed = value.trim();
  if (field.kind === "integer" && !INTEGER_INPUT_RE.test(trimmed)) return true;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return true;
  return field.kind === "integer" && !Number.isInteger(parsed);
}

function isRequiredElicitationValueMissing(
  field: ElicitationField,
  value: ElicitationFormValue | undefined,
): boolean {
  if (!field.required) return false;
  if (field.kind === "boolean") return typeof value !== "boolean";
  return typeof value !== "string" || value.trim().length === 0;
}

function isElicitationFormInvalid(
  fields: readonly ElicitationField[],
  values: Record<string, ElicitationFormValue>,
): boolean {
  return fields.some((field) =>
    isRequiredElicitationValueMissing(field, values[field.name]) ||
    isNumericFieldInvalid(field, values[field.name]),
  );
}

function buildElicitationContent(
  fields: readonly ElicitationField[],
  values: Record<string, ElicitationFormValue>,
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.name];
    if (field.enumOptions) {
      const option = typeof raw === "string"
        ? field.enumOptions.find((candidate) => candidate.key === raw)
        : undefined;
      if (option) content[field.name] = option.value;
      continue;
    }
    if (field.kind === "boolean") {
      if (typeof raw === "boolean") content[field.name] = raw;
      continue;
    }
    if (typeof raw !== "string" || raw.trim().length === 0) {
      if (field.required) content[field.name] = "";
      continue;
    }
    const trimmed = raw.trim();
    if (field.kind === "integer") {
      content[field.name] = Number(trimmed);
    } else if (field.kind === "number") {
      content[field.name] = Number(trimmed);
    } else {
      content[field.name] = raw;
    }
  }
  return content;
}

function isMcpElicitationRequest(request: ApprovalRequest | null): boolean {
  return Boolean(
    request &&
      request.source === "mcp" &&
      request.kind === "agent-action" &&
      request.toolName.startsWith("mcp:") &&
      request.toolName.endsWith(":elicitation"),
  );
}

function hasRequestedElicitationSchema(request: ApprovalRequest | null): boolean {
  const args = request?.args;
  return isRecord(args) && args.requestedSchema !== undefined;
}

const RATIONALE_INVALID_APPROVAL_MESSAGE =
  "Rationale details could not be verified. Approval is unavailable; you can deny this request.";
const RATIONALE_FAILED_EXPLANATION_MESSAGE =
  "The model explanation is unavailable. Review the host-sealed action before deciding.";

function rationaleScopeAlignmentLabel(
  alignment: RationaleApprovalDisplay["scopeAlignment"],
): string {
  switch (alignment) {
    case "aligned":
      return "Aligned with the current request";
    case "unclear":
      return "Needs a closer scope review";
    case "outside":
      return "Outside the current request";
    case "unknown":
      return "Unavailable";
  }
}

function RationaleTextList({
  values,
  testId,
}: {
  values: readonly string[];
  testId: string;
}) {
  return (
    <ul className="space-y-1" data-testid={testId}>
      {values.map((value, index) => (
        <li key={`${index}:${value}`} className="break-words">
          {value}
        </li>
      ))}
    </ul>
  );
}

/**
 * Rationale approvals expose only the narrow, HMAC-bound display contract.
 * Never reuse the normal request/args review path here: its payload can carry
 * audit-only identifiers and model-provided text that do not belong in the
 * decision card.
 */
function RationaleApprovalCard({
  display,
}: {
  display: RationaleApprovalDisplay | null;
}) {
  if (display === null) {
    return (
      <div
        className="rounded-md border border-destructive/(--opacity-muted) bg-destructive/(--opacity-faint) p-3 text-xs text-destructive"
        data-testid="rationale-approval-invalid"
        id="rationale-approval-invalid"
        role="alert"
      >
        {RATIONALE_INVALID_APPROVAL_MESSAGE}
      </div>
    );
  }

  return (
    <section
      className="min-w-0 overflow-hidden rounded-md border"
      data-testid="rationale-approval-card"
    >
      <h4 className="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs font-semibold">
        <span>Host-sealed action</span>
        <code data-testid="rationale-approval-tool">{display.toolName}</code>
      </h4>
      <div className="divide-y">
        <ReviewRow label={t("toolApprovalDialog.rowTarget")}>
          <RationaleTextList
            testId="rationale-approval-targets"
            values={display.canonicalTargets}
          />
        </ReviewRow>
        <ReviewRow label={t("toolApprovalDialog.rowChange")}>
          <RationaleTextList
            testId="rationale-approval-effects"
            values={display.requestedEffects}
          />
        </ReviewRow>
        <ReviewRow label={t("toolApprovalDialog.rowSideEffects")}>
          <RationaleTextList
            testId="rationale-approval-resources"
            values={display.affectedResources}
          />
        </ReviewRow>
        <ReviewRow label={t("toolApprovalDialog.rowAuthScope")}>
          <span data-testid="rationale-approval-authority">
            {display.requiredAuthority}
          </span>
        </ReviewRow>
        <ReviewRow label={t("toolApprovalDialog.rowVerdict")}>
          <span data-testid="rationale-approval-verdict">
            {riskLevelKoLabel(display.effectiveVerdict.level)} · {display.effectiveVerdict.reason}
          </span>
        </ReviewRow>
        <ReviewRow label={t("toolApprovalDialog.rowScope")}>
          <div className="space-y-1" data-testid="rationale-approval-scope">
            <p>{rationaleScopeAlignmentLabel(display.scopeAlignment)}</p>
            <RationaleTextList
              testId="rationale-approval-scope-reasons"
              values={display.scopeReasons}
            />
          </div>
        </ReviewRow>
      </div>

      {/* The model's explanation is visibly separate from host-sealed facts.
          It is rendered as a React text node, never as markup or input. */}
      <div
        className="border-t bg-muted/(--opacity-light) px-3 py-2"
        data-testid="rationale-model-explanation"
      >
        <p className="text-xs font-semibold">Model suggestion</p>
        {display.rationaleStatus === "ready" ? (
          <p className="mt-1 text-xs" data-testid="rationale-model-suggestion">
            {display.suggestion}
          </p>
        ) : (
          <p
            className="mt-1 text-xs text-muted-foreground"
            data-testid="rationale-model-fallback"
            role="status"
          >
            {RATIONALE_FAILED_EXPLANATION_MESSAGE}
          </p>
        )}
      </div>
    </section>
  );
}

export function ToolApprovalDialog({
  open,
  request,
  pendingCount = 1,
  onDecide,
}: {
  open: boolean;
  request: ApprovalRequest | null;
  pendingCount?: number;
  onDecide: (
    choice: ApprovalChoice,
    pattern?: string,
    extras?: ApprovalDecisionExtras,
  ) => void;
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
  const elicitationParse = useMemo(
    () => parseElicitationFields(request?.args),
    [request?.args],
  );
  const isRationaleApproval = request?.kind === "rationale";
  const rationaleDisplay = useMemo(
    () => isRationaleApproval
      ? parseRationaleApprovalDisplay(request?.args)
      : null,
    [isRationaleApproval, request?.args],
  );
  const rationaleDisplayInvalid = isRationaleApproval && rationaleDisplay === null;
  const elicitationFields = elicitationParse.fields;
  const isMcpElicitation = isMcpElicitationRequest(request);
  const hasElicitationSchema = isMcpElicitation && hasRequestedElicitationSchema(request);
  const isElicitationForm = isMcpElicitation && elicitationFields.length > 0;
  const isUnsupportedElicitationForm = hasElicitationSchema && !elicitationParse.supported;
  const [elicitationValues, setElicitationValues] = useState<Record<string, ElicitationFormValue>>({});

  // Reset NL/scope state when a new request arrives.
  useEffect(() => {
    setNlJustification(suggestedPurpose);
    setScopeChoice("session");
    setElicitationValues(initialElicitationValues(elicitationFields));
  }, [request?.id, suggestedPurpose, elicitationFields]);

  const finalVerdict = isRationaleApproval
    ? rationaleDisplay?.effectiveVerdict.level ?? "high"
    : request?.reviewerVerdict?.level ?? riskLevelForCategory(request?.toolCategory ?? "meta");
  const isExternalOriginAgentAction =
    request?.category === "agent-action" &&
    request.kind === "agent-action" &&
    (request.trustOrigin === "local-api" || request.trustOrigin === "cli");
  const isRemoteA2AAction =
    request?.category === "agent-action" &&
    request.kind === "agent-action" &&
    (request.source ?? "builtin") === "builtin" &&
    (request.trustOrigin === "a2a-remote-wire" || request.toolName.startsWith("a2a-remote-"));

  // HIGH verdict → focus NL field when dialog opens.
  useEffect(() => {
    if (
      open &&
      !isRationaleApproval &&
      finalVerdict === "high" &&
      suggestedPurpose.length === 0
    ) {
      // Small delay so the dialog animation completes first.
      const t = setTimeout(() => nlInputRef.current?.focus(), 100);
      return () => clearTimeout(t);
    }
  }, [open, isRationaleApproval, finalVerdict, suggestedPurpose.length]);

  const elicitationInvalid = isElicitationFormInvalid(elicitationFields, elicitationValues);
  const elicitationContent = useMemo(
    () => buildElicitationContent(elicitationFields, elicitationValues),
    [elicitationFields, elicitationValues],
  );

  // Rationale cards are one-shot host-sealed decisions: they never ask for a
  // durable NL justification. A malformed rationale display fails closed.
  // Other approvals retain the existing HIGH / MCP form constraints.
  const requiresNarrativeJustification = finalVerdict === "high" && !isRationaleApproval;
  const approveDisabled =
    rationaleDisplayInvalid ||
    (requiresNarrativeJustification && nlJustification.trim().length === 0) ||
    isUnsupportedElicitationForm ||
    elicitationInvalid;

  // Wrap onDecide("allow-*") to record durable approval before deciding.
  //
  // Only DURABLE choices (allow-session / allow-always) write to the
  // explicit-approval memory store (Store B). Any future per-call approval
  // choice must stay unrecorded so a one-time grant cannot widen into a
  // remembered foreground memory-skip.
  //
  // CRITICAL: use canonicalStringify for args + propagate trustOrigin
  // + approvalCacheKey so that the record key matches the lookup key in
  // dispatchReviewer. Without this, user-approval memory hit rate is 0%.
  // Fire-and-await pattern: onDecide is called synchronously so the UI
  // responds immediately; the record IPC is awaited in the background so
  // test assertions on onDecide do not need to drain microtask queues.
  const handleApprove = useCallback(async (
    choice: ApprovalChoice,
    pattern?: string,
    extras?: ApprovalDecisionExtras,
  ) => {
    let recordPromise: Promise<unknown> | undefined;
    const isDurable = choice === "allow-session" || choice === "allow-always";
    if (request && isDurable && !isMcpElicitation && !isRationaleApproval) {
      // canonicalStringify: sort object keys so {a,b} and {b,a} produce the
      // same string — matching how dispatchReviewer builds the lookup key.
      const canonicalArgs = canonicalStringifyForRenderer(request.args ?? {});
      // HIGH verdicts never persist across sessions — even when the user
      // picks "allow-always", the grant is clamped to this session (the
      // scope radio is likewise hidden for HIGH). Re-justifying a HIGH
      // action on the next session is the intended friction.
      const recordedScope: UserApprovalScope =
        choice === "allow-always" && finalVerdict !== "high"
          ? "persistent"
          : "session";
      recordPromise = window.lvis?.userApproval?.record({
        requestId: request.id,
        toolName: request.toolName,
        args: canonicalArgs,
        source: request.source ?? "builtin",
        scope: recordedScope,
        verdictAtApproval: finalVerdict as UserApprovalVerdict,
        nlJustification: finalVerdict === "high" ? nlJustification.trim() : null,
        trustOrigin: request.trustOrigin,
        approvalCacheKey: request.approvalCacheKey,
      }).catch((err: unknown) => {
        console.warn("[user-approval] record failed (non-fatal):", err);
      });
    }
    // Call onDecide synchronously so the UI responds immediately.
    if (extras === undefined) {
      onDecide(choice, pattern);
    } else {
      onDecide(choice, pattern, extras);
    }
    // Await the record promise in the background (non-blocking for the user).
    await recordPromise;
  }, [
    request,
    finalVerdict,
    nlJustification,
    onDecide,
    isMcpElicitation,
    isRationaleApproval,
  ]);

  // The primary Approve button grants for the scope selected in the radio

  // HIGH verdict forces session (no persistent grant for HIGH-risk actions).
  // This is the durable choice that the memory store records.
  const approvalIsOneShot =
    isRationaleApproval ||
    isMcpElicitation ||
    isExternalOriginAgentAction ||
    isRemoteA2AAction;
  const primaryApproveChoice: ApprovalChoice =
    approvalIsOneShot
      ? "allow-once"
      : (finalVerdict !== "high" && scopeChoice === "persistent"
          ? "allow-always"
          : "allow-session");
  const approvalExtras = useMemo<ApprovalDecisionExtras | undefined>(
    () => hasElicitationSchema && elicitationParse.supported
      ? { elicitationContent }
      : undefined,
    [hasElicitationSchema, elicitationParse.supported, elicitationContent],
  );

  const approveDisabledDescriptionId = rationaleDisplayInvalid
    ? "rationale-approval-invalid"
    : (requiresNarrativeJustification ? "nl-justification-hint" : undefined);
  const approveButtonTitle = rationaleDisplayInvalid
    ? RATIONALE_INVALID_APPROVAL_MESSAGE
    : (approveDisabled
        ? tHook("toolApprovalDialog.enterReason")
        : tHook("toolApprovalDialog.shortcutA"));


  useEffect(() => {
    if (!open || !request) return;
    const handler = (e: KeyboardEvent) => {
      if (isTextEntryShortcutTarget(e.target)) return;
      if (e.key.toLowerCase() === "a" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (!approveDisabled) void handleApprove(primaryApproveChoice, undefined, approvalExtras);
      } else if (e.key.toLowerCase() === "d" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onDecide("deny-once");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, request, onDecide, approveDisabled, handleApprove, primaryApproveChoice, approvalExtras]);

  if (!request) return null;

  const title = request.kind === "agent-action" ? tHook("toolApprovalDialog.agentActionTitle") : tHook("toolApprovalDialog.toolApprovalTitle");
  // NOTE: argsStr uses JSON.stringify for human-readable display (pretty-printed,
  // insertion-order keys). The IPC approval record uses canonicalStringify (#828)
  // which sorts object keys — key ordering may differ between what is shown here
  // and the canonical form used for cache-key lookups in dispatchReviewer.
  const argsStr = isRationaleApproval
    ? ""
    : (JSON.stringify(request.args, null, 2) ?? "");
  const argsTruncated = argsStr.length > 500 && !expanded;
  const argsDisplay = argsTruncated ? argsStr.slice(0, 500) + "\n…" : argsStr;
  const source = request.source ?? "unknown";
  const sourceBadge = request.source ? SOURCE_BADGE[request.source] ?? request.source : tHook("toolApprovalDialog.unknown");
  const hasPending = pendingCount > 1;
  const originLabel = trustOriginLabel(request.trustOrigin);
  const category = request.toolCategory ?? "meta";
  // finalVerdict already computed above (before the null-check guard) — use it here.
  const badgeClassName = levelBadgeClass(finalVerdict as RiskLevel);
  const rows = isRationaleApproval
    ? []
    : approvalReviewRows(request, category, argsStr, originLabel, source, sourceBadge);

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
            {!isRationaleApproval && (
              <div className="grid min-w-0 gap-2 sm:grid-cols-2">
              <SummaryTile label={tHook("toolApprovalDialog.tileToolSource")}>
                {/* Compact `source:tool` token (builtin:bash / {pluginId}:{tool})
                    — one line so the dialog fits without scrolling. Origin +
                    category still shown in the review box's 출처/판단 rows. */}
                <code>{sourceToolToken(request)}</code>
                {request.kind === "agent-action" && request.approvalScope && (
                  <>
                    <br />
                    {tHook("toolApprovalDialog.approvalScopePrefix")}: <code>{request.approvalScope}</code>
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
            )}

            {isRationaleApproval ? (
              <RationaleApprovalCard display={rationaleDisplay} />
            ) : (
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
            )}

            {!isRationaleApproval && (
              <PermissionEvaluationContextPanel context={request.evaluationContext} />
            )}

            {/* MAJOR 1.6: NL justification moved above collapsible details so it's
                visible without scrolling when the HIGH verdict disables Approve. */}
            {/* NL justification — required for HIGH verdict */}
            {requiresNarrativeJustification && (
              <div className="mt-3 rounded-md border border-destructive/(--opacity-muted) bg-destructive/(--opacity-faint) p-3">
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

            {!isRationaleApproval && isElicitationForm && (
              <div
                className="mt-3 rounded-md border bg-background p-3"
                data-testid="mcp-elicitation-form"
              >
                <p className="mb-2 text-xs font-semibold">Requested fields</p>
                <div className="grid gap-3">
                  {elicitationFields.map((field) => {
                    const inputId = `mcp-elicitation-${field.name}`;
                    const value = elicitationValues[field.name];
                    const invalid =
                      isRequiredElicitationValueMissing(field, value) ||
                      isNumericFieldInvalid(field, value);
                    return (
                      <div key={field.name} className="grid gap-1.5">
                        <Label htmlFor={inputId} className="text-xs">
                          {field.label}
                          {field.required && <span className="ml-1 text-destructive">*</span>}
                        </Label>
                        {field.enumOptions ? (
                          <NativeSelect
                            id={inputId}
                            size="sm"
                            className="w-full"
                            value={typeof value === "string" ? value : ""}
                            aria-invalid={invalid || undefined}
                            data-testid={`mcp-elicitation-field-${field.name}`}
                            onChange={(event) => {
                              const nextValue = event.target.value;
                              setElicitationValues((current) => ({
                                ...current,
                                [field.name]: nextValue,
                              }));
                            }}
                          >
                            <NativeSelectOption value="">Select...</NativeSelectOption>
                            {field.enumOptions.map((option) => (
                              <NativeSelectOption key={option.key} value={option.key}>
                                {option.label}
                              </NativeSelectOption>
                            ))}
                          </NativeSelect>
                        ) : field.kind === "boolean" ? (
                          <div className="flex items-center gap-2">
                            <Checkbox
                              id={inputId}
                              checked={value === true}
                              data-testid={`mcp-elicitation-field-${field.name}`}
                              onCheckedChange={(checked) => {
                                setElicitationValues((current) => ({
                                  ...current,
                                  [field.name]: checked === true,
                                }));
                              }}
                            />
                            <Label htmlFor={inputId} className="text-xs font-normal">
                              True
                            </Label>
                          </div>
                        ) : (
                          <Input
                            id={inputId}
                            type={field.kind === "string" ? "text" : "number"}
                            step={field.kind === "integer" ? "1" : "any"}
                            value={typeof value === "string" ? value : ""}
                            aria-invalid={invalid || undefined}
                            data-testid={`mcp-elicitation-field-${field.name}`}
                            onChange={(event) => {
                              const nextValue = event.target.value;
                              setElicitationValues((current) => ({
                                ...current,
                                [field.name]: nextValue,
                              }));
                            }}
                          />
                        )}
                        {field.description && (
                          <p className="text-[11px] text-muted-foreground">
                            {field.description}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {!isRationaleApproval && isUnsupportedElicitationForm && (
              <div
                className="mt-3 rounded-md border border-destructive/(--opacity-muted) bg-destructive/(--opacity-faint) p-3 text-xs text-destructive"
                data-testid="mcp-elicitation-unsupported"
              >
                Requested form schema is not supported.
              </div>
            )}

            {!isRationaleApproval && (
              <details className="min-w-0 rounded-md border bg-muted/(--opacity-light)">
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
            )}
          </div>

          {/* Scope selector — LOW/MEDIUM only (HIGH is always session) */}
          {finalVerdict !== "high" && !approvalIsOneShot && (
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
            {!approvalIsOneShot && (
              <Button
                size="sm"
                variant="outline"
                className="border-destructive text-destructive hover:bg-destructive/(--opacity-soft)"
                onClick={() => onDecide("deny-always", request.toolName)}
              >
                {tHook("toolApprovalDialog.denyAlways")}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => onDecide("deny-once")}
              title={tHook("toolApprovalDialog.shortcutD")}
            >
              {tHook("toolApprovalDialog.denyOnce")}
            </Button>
            {!approvalIsOneShot && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleApprove("allow-always", request.toolName)}
                disabled={approveDisabled}
                title={approveDisabled ? tHook("toolApprovalDialog.enterReason") : undefined}
                aria-describedby={approveDisabled ? approveDisabledDescriptionId : undefined}
              >
                {tHook("toolApprovalDialog.allowAlways")}
              </Button>
            )}
            <Button
              size="sm"
              variant="default"
              onClick={() => void handleApprove(primaryApproveChoice, undefined, approvalExtras)}
              disabled={approveDisabled}
              title={approveButtonTitle}
              aria-describedby={approveDisabled ? approveDisabledDescriptionId : undefined}
              data-testid="approve-button"
            >
              {approvalIsOneShot ? tHook("toolApprovalDialog.allowOnce") : tHook("toolApprovalDialog.allow")}
            </Button>
            {!isRationaleApproval && (
              <span id="nl-justification-hint" className="sr-only">
                {tHook("toolApprovalDialog.highRiskNlRequired")}
              </span>
            )}
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

export function approvalReviewRows(
  request: ApprovalRequest,
  category: PermissionDecisionCategory,
  inputSummary: string,
  originLabel: string,
  _source: string,
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
  const displayedSandbox = request.executionPlan?.capability ?? request.sandboxCapability;
  if (displayedSandbox) {
    const cap = displayedSandbox;
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
    } else if (
      cap.kind === "none" ||
      cap.confidence === "assumed"
    ) {
      sandboxValue = t("toolApprovalDialog.sandboxNone");
    } else if (
      cap.confines &&
      !(cap.confines.filesystem && cap.confines.process && cap.confines.network)
    ) {
      // Confines honesty: a verified non-none capability can still be partial.
      // For example, Windows srt-win lacks process confinement. Show the
      // per-dimension breakdown whenever the active substrate is not full.
      sandboxValue = t("toolApprovalDialog.sandboxNetworkOnly", {
        net: cap.confines.network ? "✓" : "✗",
        fs: cap.confines.filesystem ? "✓" : "✗",
        proc: cap.confines.process ? "✓" : "✗",
      });
    } else {
      sandboxValue = t("toolApprovalDialog.sandboxActive", { kind: cap.kind });
    }
    // A sealed plain-shell fallback can require a one-shot decision on any
    // platform. Show only that host-owned approval fact, never a raw fallback
    // reason or private permit binding.
    if (request.executionPlan?.requiresExplicitUserApproval === true) {
      sandboxValue += ` · ${t("toolApprovalDialog.allowOnce")}`;
    }
    rows.push({
      label: t("toolApprovalDialog.rowSandbox"),
      value: sandboxValue,
      testId: request.executionPlan ? "tool-approval-execution-plan" : "tool-approval-sandbox",
    });
  }
  if (isNonUserTrustOrigin(request.trustOrigin)) {
    rows.push({
      label: t("toolApprovalDialog.rowCaution"),
      value: t("toolApprovalDialog.cautionNonUserOrigin", { originLabel }),
    });
  }

  // Elaboration rows render ONLY when they carry actual per-invocation data —
  // pickSummary's hardcoded "…not specified" fallback is dropped so the dialog
  // shows real args, not boilerplate. The primary data row (target / command /
  // endpoint) + the reviewer verdict always render. Always-hardcoded/redundant
  // rows (write impact = source·category·note; read scope = source·category·…;
  // read volume) are removed — origin + category already live in the tiles + 판단.
  const NO_DATA = " nd ";
  const optRow = (
    label: string,
    keys: string[],
    opts: Partial<ReviewBasisRow> = {},
  ): ReviewBasisRow | null => {
    const v = pickSummary(parsed, keys, NO_DATA);
    return v === NO_DATA ? null : { label, value: v, ...opts };
  };
  const kept = (...rs: (ReviewBasisRow | null)[]): ReviewBasisRow[] =>
    rs.filter((r): r is ReviewBasisRow => r !== null);

  if (category === "read") {
    rows.push(
      { label: t("toolApprovalDialog.rowTarget"), value: request.target?.filePath ?? pickSummary(parsed, ["path", "paths", "target", "targets", "file", "directory", "resource", "query", "url", "uri"], inputSummary), monospace: true, testId: "tool-approval-input" },
      { label: t("toolApprovalDialog.rowSensitivity"), value: sensitivityLabel(parsed) },
    );
  } else if (category === "write") {
    rows.push(
      { label: t("toolApprovalDialog.rowTarget"), value: request.target?.filePath ?? pickSummary(parsed, ["path", "paths", "target", "targets", "file", "configKey", "taskId", "id"], inputSummary), monospace: true, testId: "tool-approval-input" },
      ...kept(
        optRow(t("toolApprovalDialog.rowChange"), ["operation", "action", "mode", "patch", "content", "body", "text"], { monospace: true }),
        optRow(t("toolApprovalDialog.rowRecovery"), ["diff", "backup", "rollback", "undo"]),
      ),
    );
  } else if (category === "network") {
    rows.push(
      { label: t("toolApprovalDialog.rowEndpoint"), value: pickSummary(parsed, ["endpoint", "url", "uri", "host", "baseUrl"], t("toolApprovalDialog.endpointNotSpecified")), monospace: true, testId: "tool-approval-input" },
      ...kept(
        optRow(t("toolApprovalDialog.rowMethod"), ["method", "httpMethod"]),
        optRow(t("toolApprovalDialog.rowPayload"), ["payload", "body", "message", "text", "input", "params", "args"], { monospace: true }),
        optRow(t("toolApprovalDialog.rowAuthScope"), ["auth", "scope", "scopes", "tenant", "account"]),
      ),
    );
  } else if (category === "shell") {
    rows.push(
      { label: t("toolApprovalDialog.rowCommand"), value: pickSummary(parsed, ["command", "cmd", "args", "script", "argv"], inputSummary), monospace: true, testId: "tool-approval-input" },
      ...kept(
        optRow(t("toolApprovalDialog.rowCwdEnv"), ["cwd", "workingDirectory", "env", "environment"], { monospace: true }),
      ),
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
  );
  return rows;
}

/**
 * Compact `source:tool` identity for the Tool/Source tile — `builtin:bash`,
 * `mcp:<tool>`, or `<pluginId>:<tool>` for a plugin (agent-action) call. One
 * short token instead of the old three-line source/plugin/scope stack, so the
 * approval dialog fits without scrolling. The origin + risk are still shown in
 * the review box's 출처/판단 rows.
 */
function sourceToolToken(request: ApprovalRequest): string {
  const tool = request.toolName;
  if (request.kind === "agent-action" && request.sourcePluginId) {
    return `${request.sourcePluginId}:${tool}`;
  }
  return `${request.source ?? "unknown"}:${tool}`;
}
