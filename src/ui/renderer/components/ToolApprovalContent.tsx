import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  resolveUserApprovalVerdict,
  type UserApprovalVerdict,
} from "../../../shared/permissions-events.js";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Label } from "../../../components/ui/label.js";
import { NativeSelect, NativeSelectOption } from "../../../components/ui/native-select.js";
import { ChevronDown } from "lucide-react";
import { DockedApprovalCard } from "./permissions/DockedApprovalCard.js";
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
import {
  parseElicitationSchema,
  type ElicitationEnumValue,
  type ElicitationFieldKind as ElicitationSchemaFieldKind,
} from "../../../shared/mcp-elicitation-schema.js";

type ElicitationFieldKind = ElicitationSchemaFieldKind;
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

const INTEGER_INPUT_RE = /^[+-]?\d+$/;
/**
 * Shown for an enum member whose natural label would be blank (the empty
 * string). The member is still offered — dropping it, or rejecting the whole
 * schema over it, would leave the user unable to answer a request the resolver
 * considers perfectly valid.
 */
const EMPTY_ENUM_OPTION_LABEL = '""';

const UNSUPPORTED_ELICITATION_SCHEMA: ElicitationSchemaParseResult = { supported: false, fields: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBoilerplateApprovalReason(value: string): boolean {
  const normalized = value.trim();
  return /^user confirmation required(?:\s*\([^)]*\))?[.!]?$/i.test(normalized)
    || /^approval required(?:\s*\([^)]*\))?[.!]?$/i.test(normalized)
    || /^상태 변경 도구\s*\([^)]*\)$/.test(normalized)
    || /\(\s*(?:category|trust)\s*:[^)]+\)\s*$/i.test(normalized);
}

function enumOptionLabel(value: ElicitationEnumValue): string {
  const label = value === null ? "null" : String(value);
  return label.length > 0 ? label : EMPTY_ENUM_OPTION_LABEL;
}

function buildEnumOptions(values: readonly ElicitationEnumValue[]): ElicitationEnumOption[] {
  return values.map((value, index) => ({
    key: String(index),
    label: enumOptionLabel(value),
    value,
  }));
}

/**
 * Adapt the shared parse result into display fields. Support is decided by
 * {@link parseElicitationSchema} alone; this must not add rejections of its own,
 * or the approval surface can once again refuse a schema the resolver accepts.
 */
function parseElicitationFields(args: unknown): ElicitationSchemaParseResult {
  if (!isRecord(args)) return UNSUPPORTED_ELICITATION_SCHEMA;
  const parsed = parseElicitationSchema(args.requestedSchema);
  if (!parsed) return UNSUPPORTED_ELICITATION_SCHEMA;
  return {
    supported: true,
    fields: parsed.fields.map((field) => ({
      name: field.name,
      label: field.title ?? field.name,
      ...(field.description ? { description: field.description } : {}),
      kind: field.kind,
      required: field.required,
      defaultValue: field.defaultValue,
      ...(field.enumValues ? { enumOptions: buildEnumOptions(field.enumValues) } : {}),
    })),
  };
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
      <h4 className="flex min-w-0 flex-wrap items-start justify-between gap-2 border-b px-3 py-2 text-xs font-semibold">
        <span className="shrink-0">Host-sealed action</span>
        <code
          className="min-w-0 max-w-full break-all text-right font-mono"
          data-testid="rationale-approval-tool"
        >
          {display.toolName}
        </code>
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

export function ToolApprovalContent({
  open,
  request,
  pendingCount = 1,
  onDecide,
  onOpenPermanentDeny,
  interactionLocked = false,
  proposedChoice = null,
}: {
  open: boolean;
  request: ApprovalRequest | null;
  pendingCount?: number;
  onDecide: (
    choice: ApprovalChoice,
    pattern?: string,
    extras?: ApprovalDecisionExtras,
  ) => void;
  onOpenPermanentDeny?: (request: ApprovalRequest, verdict: UserApprovalVerdict) => void;
  /** Settings owns the current exact-deny decision until it is saved or cancelled. */
  interactionLocked?: boolean;
  /** Approval-sentence preselection, consumed only by the out-of-dir section. */
  proposedChoice?: ApprovalChoice | null;
}) {
  const { t: tHook } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [recordingDecision, setRecordingDecision] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const activeRequestIdRef = useRef<string | null>(request?.id ?? null);
  const recordingRequestIdRef = useRef<string | null>(null);
  const decisionButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [decisionIndex, setDecisionIndex] = useState(0);
  activeRequestIdRef.current = request?.id ?? null;
  const userProvidedPurpose =
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

  // Reset the async decision lock only when the queue head itself changes.
  // Other request-local form updates must never reopen controls while the
  // exact decision record is still in flight.
  useEffect(() => {
    recordingRequestIdRef.current = null;
    setRecordingDecision(false);
    setRecordError(null);
  }, [request?.id]);

  useEffect(() => () => {
    activeRequestIdRef.current = null;
    recordingRequestIdRef.current = null;
  }, []);

  // Reset request-local choice state when the queue head changes. Approval
  // cards never collect typed prose; an explicit user reason must already be
  // part of the originating conversation and is projected read-only below.
  useEffect(() => {
    setElicitationValues(initialElicitationValues(elicitationFields));
  }, [request?.id, elicitationFields]);

  const finalVerdict = isRationaleApproval
    ? rationaleDisplay?.effectiveVerdict.level ?? "high"
    : resolveUserApprovalVerdict(request ?? {});
  const isAgentAction =
    request?.category === "agent-action" && request.kind === "agent-action";

  const elicitationInvalid = isElicitationFormInvalid(elicitationFields, elicitationValues);
  const elicitationContent = useMemo(
    () => buildElicitationContent(elicitationFields, elicitationValues),
    [elicitationFields, elicitationValues],
  );

  // HIGH approval is itself the explicit act. The explanatory text is a
  // read-only, one-shot audit summary from host-owned context; it is never a
  // renderer-authored prerequisite for the decision.
  const showsHighRiskReason = finalVerdict === "high" && !isRationaleApproval;
  const highRiskReasonSource = userProvidedPurpose.length > 0
    ? tHook("toolApprovalDialog.reasonFromRequest")
    : tHook("toolApprovalDialog.reasonFromPermissionAudit");
  const approveDisabled =
    rationaleDisplayInvalid ||
    isUnsupportedElicitationForm ||
    elicitationInvalid;

  // Host-constrained and sealed approvals remain per-invocation. The
  // "Always allow" control stays visible for layout/decision consistency but
  // is disabled with an explicit explanation.
  const isHostConstrainedToOneShot =
    request?.allowedChoices !== undefined &&
    !request.allowedChoices.includes("allow-always");
  const approvalIsOneShot =
    isRationaleApproval ||
    isMcpElicitation ||
    isAgentAction ||
    isHostConstrainedToOneShot;
  const alwaysAllowUnavailable = approvalIsOneShot || finalVerdict === "high";
  const persistentUnavailableReason = alwaysAllowUnavailable
    ? finalVerdict === "high"
      ? tHook("toolApprovalDialog.persistentUnavailableHighRisk")
      : tHook("toolApprovalDialog.persistentUnavailableOneShot")
    : null;
  const denyDecisionDisabled = recordingDecision || interactionLocked;
  const alwaysAllowDecisionDisabled =
    approveDisabled || alwaysAllowUnavailable || recordingDecision || interactionLocked;
  const allowOnceDecisionDisabled =
    approveDisabled || recordingDecision || interactionLocked;

  // Exactly one enabled decision must remain in the tab order. Default to the
  // fail-closed Reject action so a pending Enter/Space from the covered
  // composer can never become an accidental approval.
  useEffect(() => {
    const disabled = [
      denyDecisionDisabled,
      alwaysAllowDecisionDisabled,
      allowOnceDecisionDisabled,
    ];
    const preferredIndex = disabled.findIndex((value) => !value);
    setDecisionIndex(preferredIndex >= 0 ? preferredIndex : 0);
  }, [
    allowOnceDecisionDisabled,
    alwaysAllowDecisionDisabled,
    denyDecisionDisabled,
    request?.id,
  ]);

  const moveDecisionFocus = useCallback((direction: 1 | -1) => {
    const buttons = decisionButtonRefs.current;
    const disabled = [
      denyDecisionDisabled,
      alwaysAllowDecisionDisabled,
      allowOnceDecisionDisabled,
    ];
    const focusedIndex = buttons.findIndex((button) => button === document.activeElement);
    let nextIndex = focusedIndex >= 0 ? focusedIndex : decisionIndex;

    for (let step = 0; step < buttons.length; step += 1) {
      nextIndex = (nextIndex + direction + buttons.length) % buttons.length;
      const button = buttons[nextIndex];
      if (button && !disabled[nextIndex]) {
        setDecisionIndex(nextIndex);
        button.focus();
        return;
      }
    }
  }, [
    allowOnceDecisionDisabled,
    alwaysAllowDecisionDisabled,
    decisionIndex,
    denyDecisionDisabled,
  ]);

  // Wrap onDecide("allow-*") to record durable approval before deciding.
  //
  // Only the explicit `allow-always` choice writes an exact persistent tuple.
  // `allow-once` never records, and the card no longer creates a glob rule or
  // a session-wide grant.
  //
  // CRITICAL: use canonicalStringify for args + propagate trustOrigin
  // + approvalCacheKey so that the record key matches the lookup key in
  // dispatchReviewer. Without this, user-approval memory hit rate is 0%.
  const handleApprove = useCallback(async (
    choice: ApprovalChoice,
    pattern?: string,
    extras?: ApprovalDecisionExtras,
  ) => {
    if (interactionLocked || recordingRequestIdRef.current !== null) return;
    const requestIdAtStart = request?.id ?? null;
    setRecordError(null);
    if (request && choice === "allow-always" && !alwaysAllowUnavailable) {
      // canonicalStringify: sort object keys so {a,b} and {b,a} produce the
      // same string — matching how dispatchReviewer builds the lookup key.
      const canonicalArgs = canonicalStringifyForRenderer(request.args ?? {});
      recordingRequestIdRef.current = request.id;
      setRecordingDecision(true);
      try {
        const result = await window.lvis?.userApproval?.record({
          requestId: request.id,
          toolName: request.toolName,
          args: canonicalArgs,
          source: request.source ?? "builtin",
          decision: "allow",
          scope: "persistent",
          verdictAtApproval: finalVerdict as UserApprovalVerdict,
          nlJustification: null,
          trustOrigin: request.trustOrigin,
          approvalCacheKey: request.approvalCacheKey,
        });
        if (!result?.ok) {
          if (activeRequestIdRef.current === request.id) {
            setRecordError(result?.message ?? result?.error ?? tHook("toolApprovalDialog.exactDecisionSaveFailed"));
          }
          return;
        }
      } catch (err) {
        if (activeRequestIdRef.current === request.id) {
          setRecordError(err instanceof Error ? err.message : tHook("toolApprovalDialog.exactDecisionSaveFailed"));
        }
        return;
      } finally {
        if (recordingRequestIdRef.current === request.id) {
          recordingRequestIdRef.current = null;
          if (activeRequestIdRef.current === request.id) {
            setRecordingDecision(false);
          }
        }
      }
    }
    // The parent decision callback addresses the current FIFO head. An async
    // exact-record completion from a request that was cancelled/replaced must
    // never resolve the next request.
    if (activeRequestIdRef.current !== requestIdAtStart) return;
    if (extras === undefined) {
      onDecide(choice, pattern);
    } else {
      onDecide(choice, pattern, extras);
    }
  }, [
    request,
    finalVerdict,
    onDecide,
    alwaysAllowUnavailable,
    interactionLocked,
    tHook,
  ]);
  const approvalExtras = useMemo<ApprovalDecisionExtras | undefined>(
    () => hasElicitationSchema && elicitationParse.supported
      ? { elicitationContent }
      : undefined,
    [hasElicitationSchema, elicitationParse.supported, elicitationContent],
  );

  const approveDisabledDescriptionId = rationaleDisplayInvalid
    ? "rationale-approval-invalid"
    : (isUnsupportedElicitationForm || elicitationInvalid
        ? "mcp-elicitation-input-unavailable"
        : undefined);
  const approveButtonTitle = rationaleDisplayInvalid
    ? RATIONALE_INVALID_APPROVAL_MESSAGE
    : (approveDisabled
        ? tHook("toolApprovalDialog.completeRequiredChoices")
        : tHook("toolApprovalDialog.shortcutA"));


  const handlePanelKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (isTextEntryShortcutTarget(e.target)) return;
    const decisionNavigationTarget = e.target === e.currentTarget || (
      e.target instanceof Element &&
      e.target.closest('[data-testid="approval-decision-actions"]') !== null
    );
    if (interactionLocked || recordingRequestIdRef.current !== null) {
      if (
        e.key === "Escape" ||
        e.key.toLowerCase() === "a" ||
        e.key.toLowerCase() === "d" ||
        (decisionNavigationTarget && (e.key === "ArrowLeft" || e.key === "ArrowRight"))
      ) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (decisionNavigationTarget && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      e.stopPropagation();
      moveDecisionFocus(e.key === "ArrowRight" ? 1 : -1);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!request?.requireExplicit) onDecide("deny-once");
      return;
    }
    // Path-grant requests own their decision semantics in DockedApprovalCard:
    // the user may have navigated to the allow-always (parent grant) scope,
    // and the generic A shortcut would silently commit a plain allow-once,
    // discarding that selection. Before the frame unification these shortcuts
    // never existed for this kind — keep it that way (review MAJOR).
    const isOutOfDirRequest = request?.kind === "out-of-allowed-dir";
    if (e.key.toLowerCase() === "a" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      if (!approveDisabled && !isOutOfDirRequest) {
        void handleApprove("allow-once", undefined, approvalExtras);
      }
    } else if (e.key.toLowerCase() === "d" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      if (!isOutOfDirRequest) onDecide("deny-once");
    }
  }, [
    request?.requireExplicit,
    request?.kind,
    onDecide,
    approveDisabled,
    handleApprove,
    approvalExtras,
    interactionLocked,
    moveDecisionFocus,
  ]);

  if (!open || !request) return null;

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
  const originLabel = trustOriginLabel(request.trustOrigin);
  const category = request.toolCategory ?? "meta";
  // Path-grant approvals keep their own Evidence+Decision section: the
  // allow-always choice there GRANTS A PARENT DIRECTORY and must carry the
  // pattern argument — forcing it through the generic three-button row would
  // change what the button means, not just where it sits. One frame, one
  // identity strip; the decision layer is polymorphic by kind.
  const isOutOfDir = request.kind === "out-of-allowed-dir";
  // finalVerdict already computed above (before the null-check guard) — use it here.
  const badgeClassName = levelBadgeClass(finalVerdict as RiskLevel);
  const rows = isRationaleApproval
    ? []
    : approvalReviewRows(request, category, argsStr, originLabel, source, sourceBadge);
  const sandboxSummary = isRationaleApproval ? null : approvalSandboxSummary(request);
  const categoryImpact = category === "read"
    ? tHook("toolApprovalDialog.impactRead")
    : category === "write"
      ? tHook("toolApprovalDialog.impactWrite")
      : category === "network"
        ? tHook("toolApprovalDialog.impactNetwork")
        : category === "shell"
          ? tHook("toolApprovalDialog.impactShell")
          : tHook("toolApprovalDialog.impactMeta");
  const specificReviewerReason = request.reviewerVerdict?.reason.trim() ?? "";
  const specificHostReason = request.reason.trim();
  const reviewedImpact = !isBoilerplateApprovalReason(specificReviewerReason)
    ? specificReviewerReason
    : !isBoilerplateApprovalReason(specificHostReason)
      ? specificHostReason
      : categoryImpact;
  const highRiskReason = (userProvidedPurpose || reviewedImpact || categoryImpact).slice(0, 220);
  const impactSummary = isRationaleApproval
    ? ""
    : (showsHighRiskReason
        ? highRiskReason
        : (request.approvalPurpose?.text.trim() || reviewedImpact || categoryImpact)
      ).slice(0, 220);

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      data-testid="tool-approval-panel"
      data-pending-count={pendingCount}
      data-approval-request-id={isRationaleApproval ? undefined : request.id}
      data-approval-tool-name={isRationaleApproval ? undefined : request.toolName}
      data-approval-args={
        isRationaleApproval ? undefined : canonicalStringifyForRenderer(request.args)
      }
      tabIndex={-1}
      onKeyDown={handlePanelKeyDown}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="tool-approval-card">
        <section className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-3 py-2 sm:px-4 sm:py-3">
          <div className="space-y-2">
            {/* Identity strip — host-owned facts (toolName, source, category,
                origin, risk chip), rendered for EVERY kind including a
                rationale whose sealed display failed to parse. The sealed
                table is EVIDENCE; identity must never depend on it — the
                degenerate card that showed no tool name at all is the bug
                this unconditional render removes. */}
                <div className="min-w-0 space-y-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge variant="outline" className={`${badgeClassName} shrink-0`}>
                      {riskLevelKoLabel(finalVerdict as RiskLevel)}
                    </Badge>
                    <code
                      className="min-w-0 flex-1 break-all font-mono text-xs font-semibold"
                      data-testid="approval-tool-identity"
                    >
                      {/* For a sealed card only the HMAC-sealed display.toolName
                          is display-trusted; the generic request fields are
                          deliberately not attested for this kind. When the seal
                          is invalid the request name is the only identity left —
                          strictly better than the identity-less card this
                          replaces, but it must say it is unverified. */}
                      {isRationaleApproval
                        ? rationaleDisplay?.toolName ?? request.toolName
                        : sourceToolToken(request)}
                    </code>
                    {rationaleDisplayInvalid ? (
                      <span
                        className="shrink-0 rounded-full border border-destructive/(--opacity-medium) bg-destructive/(--opacity-faint) px-1.5 py-px text-[10px] text-destructive"
                        data-testid="approval-identity-unverified"
                      >
                        {tHook("toolApprovalDialog.identityUnverified")}
                      </span>
                    ) : null}
                    {(pendingCount ?? 0) > 1 ? (
                      <span
                        className="shrink-0 rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground"
                        data-testid="approval-inline-queue-depth"
                      >
                        1 / {pendingCount}
                      </span>
                    ) : null}
                  </div>
                  {!isRationaleApproval && (
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[10px] text-muted-foreground">
                    <span>{request.sourcePluginId ?? sourceBadge}</span>
                    <span aria-hidden="true">·</span>
                    <span>{categoryLabel(category)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{originLabel}</span>
                    <span aria-hidden="true">·</span>
                    <code className="min-w-0 break-all font-mono" data-testid="approval-conversation">
                      {request.sessionId ?? tHook("approvalAttribution.unattributed")}
                    </code>
                  </div>
                  )}
                  {request.kind === "agent-action" && request.approvalScope ? (
                    <p className="break-words text-[10px] text-muted-foreground">
                      {tHook("toolApprovalDialog.approvalScopePrefix")}: {request.approvalScope}
                    </p>
                  ) : null}
                </div>

            {!isRationaleApproval && !isOutOfDir && (
              <>
                <div
                  className={`min-w-0 rounded-md border-l-2 px-3 py-2 ${
                    showsHighRiskReason
                      ? "border-destructive bg-destructive/(--opacity-faint)"
                      : "border-warning bg-warning/(--opacity-subtle)"
                  }`}
                  data-testid="approval-impact-summary"
                >
                  {showsHighRiskReason ? (
                    <span className="text-[10px] font-semibold text-destructive">
                      {highRiskReasonSource}
                    </span>
                  ) : null}
                  <p
                    className="break-words text-xs leading-relaxed"
                    data-testid={showsHighRiskReason ? "high-risk-audit-reason" : undefined}
                  >
                    {impactSummary}
                  </p>
                  {sandboxSummary ? (
                    <p
                      className="mt-0.5 break-words text-[10px] text-muted-foreground"
                      data-testid={sandboxSummary.testId}
                    >
                      {sandboxSummary.value}
                    </p>
                  ) : null}
                  {showsHighRiskReason ? (
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      {tHook("toolApprovalDialog.highRiskExplicitApproval")}
                    </p>
                  ) : null}
                </div>
              </>
            )}

            {isOutOfDir ? (
              <DockedApprovalCard
                request={request}
                onDecide={(choice, rememberPattern) => onDecide(choice, rememberPattern)}
                onOpenPermanentDeny={onOpenPermanentDeny}
                proposedChoice={proposedChoice}
                interactionLocked={interactionLocked}
              />
            ) : (
            <details
              className="group min-w-0 overflow-hidden rounded-lg border border-border-strong bg-muted/(--opacity-light)"
              data-testid="approval-review-details"
            >
              <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 px-3 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-semibold">
                    {tHook("toolApprovalDialog.reviewDetails")}
                  </span>
                  <span className="block text-[10px] font-normal text-muted-foreground">
                    {tHook("toolApprovalDialog.reviewDetailsHint")}
                  </span>
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180"
                />
              </summary>
              <div className="space-y-3 border-t p-3">
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
                        testId={row.monospace ? undefined : row.testId}
                      >
                        {row.monospace ? (
                          <pre
                            className="max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed"
                            data-testid={row.testId}
                          >
                            {row.value}
                          </pre>
                        ) : row.value}
                      </ReviewRow>
                    ))}
                  </div>
                )}

                {!isRationaleApproval && (
                  <PermissionEvaluationContextPanel context={request.evaluationContext} />
                )}

                {!isRationaleApproval && (
                  <div className="min-w-0 overflow-hidden rounded-md border bg-background">
                    <p className="border-b px-3 py-2 text-xs font-semibold">
                      {tHook("toolApprovalDialog.showFullInput")}
                    </p>
                    <pre className="max-h-56 max-w-full overflow-auto px-3 py-2 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">
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
                  </div>
                )}
              </div>
            </details>
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
                    const labelId = `${inputId}-label`;
                    const value = elicitationValues[field.name];
                    const invalid =
                      isRequiredElicitationValueMissing(field, value) ||
                      isNumericFieldInvalid(field, value);
                    return (
                      <div key={field.name} className="grid gap-1.5">
                        <Label
                          id={labelId}
                          htmlFor={field.enumOptions || field.kind === "boolean" ? inputId : undefined}
                          className="text-xs"
                        >
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
                          <div
                            id={inputId}
                            className="min-w-0 rounded-md border bg-muted/(--opacity-light) px-3 py-2 text-xs"
                            role="group"
                            aria-labelledby={labelId}
                            aria-invalid={invalid || undefined}
                            data-testid={`mcp-elicitation-field-${field.name}`}
                            data-readonly="true"
                          >
                            {typeof value === "string" && value.trim().length > 0 ? (
                              <code className="break-all font-mono">{value}</code>
                            ) : (
                              <span className="text-muted-foreground">
                                {tHook("toolApprovalDialog.noTypedValueProvided")}
                              </span>
                            )}
                          </div>
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

            {!isRationaleApproval && (isUnsupportedElicitationForm || elicitationInvalid) && (
              <p
                id="mcp-elicitation-input-unavailable"
                className="mt-2 text-[10px] text-muted-foreground"
                data-testid="mcp-elicitation-input-unavailable"
              >
                {tHook("toolApprovalDialog.typedInputOutsideApproval")}
              </p>
            )}

          </div>

        </section>
          {!isOutOfDir && (
          <footer className="min-w-0 shrink-0 space-y-1.5 border-t bg-card px-3 py-2 sm:px-4">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span>{tHook("toolApprovalDialog.permanentDenyInSettings")}</span>
              <Button
                type="button"
                size="sm"
                variant="link"
                className="h-auto min-w-0 max-w-full shrink p-0 text-right text-[11px] whitespace-normal break-words"
                disabled={recordingDecision || approvalIsOneShot || !onOpenPermanentDeny}
                title={approvalIsOneShot ? tHook("toolApprovalDialog.persistentUnavailableOneShot") : undefined}
                onClick={() => {
                  if (recordingRequestIdRef.current === null) {
                    onOpenPermanentDeny?.(request, finalVerdict as UserApprovalVerdict);
                  }
                }}
                data-testid="open-permanent-deny-settings"
              >
                {tHook("toolApprovalDialog.openPermissionSettings")}
              </Button>
            </div>
            <div
              className="grid min-w-0 grid-cols-3 gap-2 [&>button]:min-w-0 [&>button]:h-auto [&>button]:whitespace-normal [&>button]:break-words [&>button]:px-1 [&>button]:py-2 [&>button]:text-[11px] [&>button]:leading-tight"
              data-testid="approval-decision-actions"
            >
              <Button
                ref={(element) => {
                  decisionButtonRefs.current[0] = element;
                }}
                size="sm"
                variant="outline"
                className="border-destructive text-destructive hover:bg-destructive/(--opacity-soft)"
                onClick={() => {
                  if (recordingRequestIdRef.current === null) onDecide("deny-once");
                }}
                title={tHook("toolApprovalDialog.shortcutD")}
                disabled={denyDecisionDisabled}
                tabIndex={decisionIndex === 0 && !denyDecisionDisabled ? 0 : -1}
                onFocus={() => setDecisionIndex(0)}
                aria-describedby={interactionLocked ? "approval-decision-locked" : undefined}
                data-testid="deny-button"
              >
                {tHook("toolApprovalDialog.denyOnce")}
              </Button>
{/* Fail-closed: a sealed display that cannot be parsed strips the
                  allow options entirely — a button that can never be legitimately
                  pressed teaches users to distrust the panel, and offering approval
                  for an action whose identity evidence is broken is not an option
                  this card may present. Deny remains: it unblocks the turn and
                  lets the model regenerate the rationale. */}
              {!rationaleDisplayInvalid && (
              <Button
                ref={(element) => {
                  decisionButtonRefs.current[1] = element;
                }}
                size="sm"
                variant="outline"
                onClick={() => void handleApprove("allow-always")}
                disabled={alwaysAllowDecisionDisabled}
                tabIndex={decisionIndex === 1 && !alwaysAllowDecisionDisabled ? 0 : -1}
                onFocus={() => setDecisionIndex(1)}
                title={
                  alwaysAllowUnavailable
                    ? (finalVerdict === "high"
                        ? tHook("toolApprovalDialog.persistentUnavailableHighRisk")
                        : tHook("toolApprovalDialog.persistentUnavailableOneShot"))
                    : approveDisabled ? tHook("toolApprovalDialog.completeRequiredChoices") : undefined
                }
                aria-describedby={
                  interactionLocked
                    ? "approval-decision-locked"
                    : persistentUnavailableReason
                      ? "allow-always-unavailable-reason"
                      : approveDisabled
                        ? approveDisabledDescriptionId
                        : undefined
                }
                data-testid="allow-always-button"
              >
                {tHook("toolApprovalDialog.allowAlways")}
              </Button>
              )}
{!rationaleDisplayInvalid && (
              <Button
                ref={(element) => {
                  decisionButtonRefs.current[2] = element;
                }}
                size="sm"
                variant="default"
                onClick={() => void handleApprove("allow-once", undefined, approvalExtras)}
                disabled={allowOnceDecisionDisabled}
                tabIndex={decisionIndex === 2 && !allowOnceDecisionDisabled ? 0 : -1}
                onFocus={() => setDecisionIndex(2)}
                title={approveButtonTitle}
                aria-describedby={
                  interactionLocked
                    ? "approval-decision-locked"
                    : approveDisabled
                      ? approveDisabledDescriptionId
                      : undefined
                }
                data-testid="approve-button"
              >
                {tHook("toolApprovalDialog.allowOnce")}
              </Button>
              )}
            </div>
            {persistentUnavailableReason ? (
              <p
                id="allow-always-unavailable-reason"
                className="text-[10px] text-muted-foreground"
                data-testid="allow-always-unavailable-reason"
              >
                {persistentUnavailableReason}
              </p>
            ) : null}
            {interactionLocked ? (
              <p
                id="approval-decision-locked"
                className="text-[10px] text-muted-foreground"
                data-testid="approval-decision-locked"
              >
                {tHook("toolApprovalDialog.decisionPendingInSettings")}
              </p>
            ) : null}
            {recordError ? (
              <p className="text-[11px] text-destructive" role="alert" data-testid="exact-decision-save-error">
                {recordError}
              </p>
            ) : null}
          </footer>
          )}
      </div>
    </div>
  );
}

function isTextEntryShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(
    'input, textarea, select, [role="textbox"], [contenteditable="true"]',
  ) !== null;
}

function parseArgs(args: unknown): ParsedSummary | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  return args as ParsedSummary;
}

function approvalSandboxSummary(request: ApprovalRequest): ReviewBasisRow | null {
  const cap = request.executionPlan?.capability ?? request.sandboxCapability;
  if (!cap) return null;

  let value: string;
  if (cap.kind === "partial") {
    value = t("toolApprovalDialog.sandboxPartial");
  } else if (cap.kind === "fs-only") {
    value = t("toolApprovalDialog.sandboxFsOnly");
  } else if (cap.kind === "none" || cap.confidence === "assumed") {
    value = t("toolApprovalDialog.sandboxNone");
  } else if (
    cap.confines &&
    !(cap.confines.filesystem && cap.confines.process && cap.confines.network)
  ) {
    value = t("toolApprovalDialog.sandboxNetworkOnly", {
      net: cap.confines.network ? "✓" : "✗",
      fs: cap.confines.filesystem ? "✓" : "✗",
      proc: cap.confines.process ? "✓" : "✗",
    });
  } else {
    value = t("toolApprovalDialog.sandboxActive", { kind: cap.kind });
  }
  if (request.executionPlan?.requiresExplicitUserApproval === true) {
    value += ` · ${t("toolApprovalDialog.allowOnce")}`;
  }
  return {
    label: t("toolApprovalDialog.rowSandbox"),
    value,
    testId: request.executionPlan ? "tool-approval-execution-plan" : "tool-approval-sandbox",
  };
}

function approvalReviewRows(
  request: ApprovalRequest,
  category: PermissionDecisionCategory,
  inputSummary: string,
  originLabel: string,
  _source: string,
  _sourceBadge: string,
): ReviewBasisRow[] {
  const parsed = parseArgs(request.args);
  const reviewer = request.reviewerVerdict
    ? `${riskLevelKoLabel(request.reviewerVerdict.level)} · ${request.reviewerVerdict.reason}`
    : request.reason;
  // Source, trust origin, category, conversation and sandbox now live in the
  // compact always-visible summary. Details contain only additional evidence.
  const rows: ReviewBasisRow[] = [];
  if (isNonUserTrustOrigin(request.trustOrigin)) {
    rows.push({
      label: t("toolApprovalDialog.rowCaution"),
      value: t("toolApprovalDialog.cautionNonUserOrigin", { originLabel }),
    });
  }

  // Elaboration rows render ONLY when they carry actual per-invocation data —
  // pickSummary's hardcoded "…not specified" fallback is dropped so the dock
  // shows real args, not boilerplate. The primary data row (target / command /
  // endpoint) + the reviewer verdict always render. Always-hardcoded/redundant
  // rows (write impact = source·category·note; read scope = source·category·…;
  // read volume) are removed — origin + category already live in the tiles + 판단.
  const NO_DATA = "__LVIS_NO_APPROVAL_DATA__";
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
 * approval content fits without scrolling. The origin + risk are still shown in
 * the review box's 출처/판단 rows.
 */
function sourceToolToken(request: ApprovalRequest): string {
  const tool = request.toolName;
  if (request.kind === "agent-action" && request.sourcePluginId) {
    return `${request.sourcePluginId}:${tool}`;
  }
  return `${request.source ?? "unknown"}:${tool}`;
}
