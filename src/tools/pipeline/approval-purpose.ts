/**
 * Tool pipeline — high-risk approval purpose-suggestion cluster.
 *
 * Pure helpers factored out of `executor.ts` (C7 decomposition). Derives the
 * pre-filled "purpose" string shown on the high-risk approval modal from the
 * recent user turn text (preferred) or a purpose-bearing tool-input field.
 */
import { maskSensitiveData } from "../../audit/dlp-filter.js";
import { t } from "../../i18n/index.js";
import type { ApprovalPurposeSuggestion } from "../../shared/permission-review-status.js";
import type { ToolPermissionContext } from "../executor.js";

// C0 control characters (U+0000-U+001F) plus DEL (U+007F). Built from char
// codes so the source stays ASCII-clean (no raw control bytes); semantically
// identical to the original control-character stripping regex. `String.replace`
// with a global regex resets lastIndex per call, so reuse is safe.
const CONTROL_CHARACTERS = new RegExp(
  "[" + String.fromCharCode(0) + "-" + String.fromCharCode(0x1f) + String.fromCharCode(0x7f) + "]",
  "g",
);

function cleanApprovalPurposeText(value: unknown, maxLength = 180): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/<[^>]*>/g, " ")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || normalized.startsWith("/")) return undefined;
  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(0, maxLength - 1))}…`
    : normalized;
}

function purposeSentenceFromIntent(intent: string): string {
  const text = intent.replace(/[.!?。！？]+$/u, "").trim();
  return maskSensitiveData(t("be_executor.purposeSentence", { text })).masked;
}

function pickPurposeFromToolInput(input: Record<string, unknown>): string | undefined {
  const keys = [
    "purpose",
    "intent",
    "reason",
    "task",
    "summary",
    "query",
    "prompt",
    "message",
    "text",
    "description",
  ];
  for (const key of keys) {
    const value = cleanApprovalPurposeText(input[key]);
    if (value) return value;
  }
  return undefined;
}

export function buildApprovalPurposeSuggestion(
  finalInput: Record<string, unknown>,
  context: ToolPermissionContext,
): ApprovalPurposeSuggestion | undefined {
  const userIntent = cleanApprovalPurposeText(context.userIntent, 220);
  if (userIntent) {
    return {
      text: purposeSentenceFromIntent(userIntent),
      source: "conversation",
      confidence: "sufficient",
    };
  }

  const toolPurpose = pickPurposeFromToolInput(finalInput);
  if (!toolPurpose) return undefined;
  return {
    text: purposeSentenceFromIntent(toolPurpose),
    source: "tool-input",
    confidence: "insufficient",
  };
}
