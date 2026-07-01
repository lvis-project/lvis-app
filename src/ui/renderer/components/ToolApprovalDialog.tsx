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

  const finalVerdict = request?.reviewerVerdict?.level ?? riskLevelForCategory(request?.toolCategory ?? "meta");

  // HIGH verdict → focus NL field when dialog opens.
  useEffect(() => {
    if (open && finalVerdict === "high" && suggestedPurpose.length === 0) {
      // Small delay so the dialog animation completes first.
      const t = setTimeout(() => nlInputRef.current?.focus(), 100);
      return () => clearTimeout(t);
    }
  }, [open, finalVerdict, suggestedPurpose.length]);

  const elicitationInvalid = isElicitationFormInvalid(elicitationFields, elicitationValues);
  const elicitationContent = useMemo(
    () => buildElicitationContent(elicitationFields, elicitationValues),
    [elicitationFields, elicitationValues],
  );

  // Approve is disabled for HIGH when NL field is empty, and for incomplete
  // MCP elicitation forms.
  const approveDisabled =
    (finalVerdict === "high" && nlJustification.trim().length === 0) ||
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
    if (request && isDurable && !isMcpElicitation) {
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
  }, [request, finalVerdict, nlJustification, onDecide, isMcpElicitation]);

  // The primary Approve button grants for the scope selected in the radio
  // group: "이 세션만" → durable session grant, "영구 허용" → persistent.
  // HIGH verdict forces session (no persistent grant for HIGH-risk actions).
  // This is the durable choice that the memory store records.
  const primaryApproveChoice: ApprovalChoice =
    isMcpElicitation
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

  // 키보드 단축키 (disabled for HIGH when NL field empty)
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

            {isElicitationForm && (
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

            {isUnsupportedElicitationForm && (
              <div
                className="mt-3 rounded-md border border-destructive/(--opacity-muted) bg-destructive/(--opacity-faint) p-3 text-xs text-destructive"
                data-testid="mcp-elicitation-unsupported"
              >
                Requested form schema is not supported.
              </div>
            )}

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
          </div>

          {/* Scope selector — LOW/MEDIUM only (HIGH is always session) */}
          {finalVerdict !== "high" && !isMcpElicitation && (
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
            {!isMcpElicitation && (
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
            {!isMcpElicitation && (
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
            )}
            <Button
              size="sm"
              variant="default"
              onClick={() => void handleApprove(primaryApproveChoice, undefined, approvalExtras)}
              disabled={approveDisabled}
              title={approveDisabled ? tHook("toolApprovalDialog.enterReason") : tHook("toolApprovalDialog.shortcutA")}
              aria-describedby={approveDisabled ? "nl-justification-hint" : undefined}
              data-testid="approve-button"
            >
              {tHook("toolApprovalDialog.allow")}
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

export function approvalReviewRows(
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
    } else if (cap.confines && !cap.confines.filesystem) {
      // PR2 finding b — confines honesty. `isWeakSandbox` is confines-BLIND: it
      // reports "strong" for ANY verified non-none ASRT, which on Windows
      // (network-only srt-win, confines.filesystem === false) wrongly printed a
      // blanket "OS 격리 활성" for a write/shell tool that has NO FS jail. When
      // the capability declares a non-full confinement, show the per-dimension
      // breakdown so the label matches what is actually contained. Display-only:
      // the actual relaxation control (sandboxRelaxesCategory, per-category) is
      // untouched and lives in the reviewer.
      sandboxValue = t("toolApprovalDialog.sandboxNetworkOnly", {
        net: cap.confines.network ? "✓" : "✗",
        fs: cap.confines.filesystem ? "✓" : "✗",
        proc: cap.confines.process ? "✓" : "✗",
      });
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
