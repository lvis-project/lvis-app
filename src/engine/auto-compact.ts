/**
 * Auto-Compact — claw-code 패턴: 토큰 기반 컨텍스트 관리
 *
 * 대화가 길어지면 히스토리 토큰이 컨텍스트 윈도우를 초과.
 * 자동으로 오래된 메시지를 요약하여 공간 확보.
 *
 * 핵심 원칙:
 * - tool_use/tool_result 쌍은 절대 분리하지 않음
 * - 최근 N개 메시지는 보존 (PR-1a 에서 DEFAULT_CONFIG.preserveRecentMessages 4 → 12 상향)
 * - 요약은 파일 참조, 진행 중인 작업, 핵심 결정을 보존
 */
import type { GenericMessage, TokenUsage, LLMVendor, UserContentPart } from "./llm/types.js";
import { serializeMessageForEstimation, userContentText } from "./llm/types.js";
import { lookupPricing, effectiveContextWindow } from "../shared/pricing-data.js";
import { getUsableContext, getPreflightThreshold } from "../shared/context-budget.js";


// ─── Context Window Registry ─────────────────────────
//
// Single source of truth for context windows lives in
// `shared/pricing-data.ts:DEFAULT_PRICING`. This module defers all lookups
// there. The previous in-tree `MODEL_CONTEXT_WINDOWS` table was removed in
// the 2026-05 SoT consolidation (see `reference_token_session_4source.md`).

/**
 * Model identifier → effective context window in tokens.
 *
 * "Effective" because the adapter auto-sends the `context-1m-2025-08-07`
 * beta header for any Claude model with `contextWindow1MBeta` set
 * (`engine/llm/vercel/adapter.ts`), so the beta value is what the model
 * actually delivers. {@link effectiveContextWindow} resolves this for us.
 *
 * Unknown models fall back to `FALLBACK_PRICING.contextWindow` (128K) via
 * `lookupPricing`. The lookup itself supports prefix matching for
 * date-suffixed snapshots.
 */
export function getModelContextWindow(vendor: LLMVendor, model: string): number {
  return effectiveContextWindow(lookupPricing(vendor, model));
}

/**
 * Usable portion of the model's context window — what callers should treat
 * as the denominator for "fullness" math. Subtracts Cline-style fixed
 * buffer (output + safety reservation). See {@link getUsableContext}.
 *
 * Use this for `shouldCompact`, `decideRotation`, and any UI ring that
 * should hit 100% at the actual rotation point rather than at raw context.
 */
export function getModelUsableContext(vendor: LLMVendor, model: string): number {
  return getUsableContext(getModelContextWindow(vendor, model));
}

/**
 * Layer 0 pre-flight 트리거 (절대 token count). v3 §6 보수 default —
 * 64K → 50% / 128K → 55% / 200K → 60% / 1M → 65% / other → 60%.
 * 호출자: queryLoop 의 step 5/6 사이 (`infinity-session-redesign-v3.md` §4.1).
 *
 * @example
 * // 200K Sonnet → usable 160K → 60% × 160K = 96K trigger
 * estimateMessagesTokens(history) >= getModelPreflightThreshold("claude", "claude-sonnet-4-6");
 */
export function getModelPreflightThreshold(vendor: LLMVendor, model: string): number {
  return getPreflightThreshold(getModelContextWindow(vendor, model));
}

// PR-2-F-2: 3-tier rotation 폐지 — `decideRotation` 함수 + `RotationDecision` interface +
// `CheckpointTriggerType` type 모두 제거. Layer 0 preflight + Layer 2 LLM compact +
// Layer 3 same-session checkpoint chain (Copilot 패턴) 으로 fork-based rotation 대체.

// ─── Types ──────────────────────────────────────────

// ─── Token Estimation ───────────────────────────────

/**
 * 한글 음절 (가-힣 범위, U+AC00 ~ U+D7A3) 카운트 — Korean weighting helper.
 * Anthropic/OpenAI/Gemini 토크나이저 모두 한글을 1.5~2x 비율로 토큰화하므로
 * chars/4 공식이 한글 위주 대화에서는 underestimate. 50% 이상이면 1.3x 보정.
 */
export function countHangul(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xAC00 && c <= 0xD7A3) count++;
  }
  return count;
}

/**
 * 텍스트의 토큰 수 추정 (claw-code 방식: length/4 + 1) + 한글 가중치 (P11).
 *
 * 한글 비율 ≥ 50% 면 weight 1.3 적용 (mixed-language 코드+주석 등은 ratio < 50% → weight 1.0).
 * 보수적 fallback: 모르는 문자는 기본 4-char/token 가정.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 1;
  const hangul = countHangul(text);
  const ratio = hangul / text.length;
  const weight = ratio >= 0.5 ? 1.3 : 1.0;
  return Math.ceil((text.length * weight) / 4) + 1;
}

/** 메시지 배열의 총 토큰 추정 */
export function estimateMessagesTokens(messages: GenericMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    // Estimate tokens from the complete canonical serialization so that
    // assistant thinkingBlocks (extended thinking) are counted as well.
    total += estimateTokens(serializeMessageForEstimation(msg));
  }
  return total;
}


// ─── Layer 1: Mark Stale Tool Results (preventive, LLM-free) ──

export interface MarkStaleConfig {
  /** 말단에서부터 이 개수만큼의 tool_result는 raw 유지 (기본 8) */
  preserveRecentToolResults: number;
  /** 이 길이(자) 미만의 tool_result는 stub 대상에서 제외 (기본 200, OpenCode 패턴) */
  minStubThreshold?: number;
}

export interface MarkStaleResult {
  /** 실제 strip이 일어났는지 여부 */
  stripped: boolean;
  /** strip된 tool_result 개수 */
  strippedCount: number;
  /** 확보된 총 문자 수 (UTF-16 code unit 기준 string.length 차이 — 바이트 아님). */
  freedChars: number;
}

const DEFAULT_MARK_STALE_CONFIG: MarkStaleConfig = {
  preserveRecentToolResults: 8,
  minStubThreshold: 200,
};

/**
 * Layer 1 — Preventive, LLM-free tool_result *stub-replace* (renamed from `microcompactMessages` in v3 PR-1b).
 *
 * 오래된 tool_result 메시지 content를 stub string으로 교체해 히스토리 크기를 낮춘다.
 * (PR-3 stamping-behavior 머지 시 이 함수는 *marking only* — `meta.compactedAt` set 만 — 로 전환되고,
 *  실제 stub 화는 wire/disk serialization 경계로 이동. 현재 PR-1c 에서는 `meta.stripped`/`meta.strippedAt` 사용,
 *  PR-3 후 `meta.compactedAt` 으로 의미 통합. 그 시점까지 content 교체 동작 유지.)
 *
 * - 최근 `preserveRecentToolResults` 개는 원본 유지 (assistant가 참조 가능성 있음)
 * - content 길이가 `minStubThreshold` 미만이면 stub 으로 교체해도 이득이 거의 없으므로 skip (OpenCode 패턴)
 * - 이미 stripped된 메시지는 skip (idempotent)
 * - `toolUseId`는 절대 변경하지 않음 — 다른 메시지 참조 무결성 보존
 * - 입력 array는 mutate하지 않고 새 배열 반환. strip된 메시지만 새 객체, 나머지는 reference-equal.
 */
export function markStaleToolResults(
  messages: GenericMessage[],
  config: MarkStaleConfig = DEFAULT_MARK_STALE_CONFIG,
): { messages: GenericMessage[]; result: MarkStaleResult } {
  const preserveCount = Math.max(0, config.preserveRecentToolResults);
  const minStub = config.minStubThreshold ?? DEFAULT_MARK_STALE_CONFIG.minStubThreshold ?? 200;

  // tool_result 인덱스를 순서대로 수집
  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool_result") toolResultIndices.push(i);
  }

  if (toolResultIndices.length <= preserveCount) {
    return {
      messages,
      result: { stripped: false, strippedCount: 0, freedChars: 0 },
    };
  }

  // 끝에서부터 preserveCount 개를 제외한 인덱스가 strip 후보
  const stripCandidates = toolResultIndices.slice(0, toolResultIndices.length - preserveCount);
  // 후보 전원이 이미 stripped이거나 threshold 미만이면 새 배열 생성 없이 early return.
  const eligibleCandidates = stripCandidates.filter((i) => {
    const m = messages[i];
    if (m.role !== "tool_result") return false;
    if ((m as { meta?: { stripped?: boolean } }).meta?.stripped === true) return false;
    return m.content.length >= minStub;
  });
  if (eligibleCandidates.length === 0) {
    return {
      messages,
      result: { stripped: false, strippedCount: 0, freedChars: 0 },
    };
  }
  const stripCandidateIdxSet = new Set(eligibleCandidates);

  let strippedCount = 0;
  let freedChars = 0;
  const nowIso = new Date().toISOString();

  const out = messages.map((msg, i) => {
    if (!stripCandidateIdxSet.has(i)) return msg;
    if (msg.role !== "tool_result") return msg;

    const origLen = msg.content.length;
    const stub = `[tool_result stripped: tool=${msg.toolName ?? "?"}, origLen=${origLen}]`;
    freedChars += Math.max(0, origLen - stub.length);
    strippedCount += 1;

    return {
      role: "tool_result",
      toolUseId: msg.toolUseId,
      toolName: msg.toolName,
      isError: msg.isError,
      content: stub,
      meta: {
        ...(msg.meta ?? {}),
        stripped: true,
        originalLength: origLen,
        strippedAt: nowIso,
      },
    } as GenericMessage;
  });

  return {
    messages: out,
    result: {
      stripped: strippedCount > 0,
      strippedCount,
      freedChars,
    },
  };
}

// ─── Reactive Recovery ──────────────────────────────

/**
 * 벤더별 "context too long" 오류인지 판별.
 *
 * 입력 형태별 처리 (duck-typing):
 * - `Error` 인스턴스: `.message` 문자열 검사 + `.code === "context_length_exceeded"` 검사
 * - `string`: 직접 검사 (StreamEvent `{type:"error", error:string}` 경로)
 * - `{message: string}` 객체: `.message` 필드 검사
 * - `{error: string}` 객체: `.error` 필드 검사
 *
 * 메시지 패턴:
 * - Anthropic: "prompt is too long"
 * - OpenAI / Copilot: `.code === "context_length_exceeded"` 또는 "maximum context length"
 * - Gemini: "context window"
 *
 * 주의: `error.type` 필드나 HTTP 상태 코드는 직접 검사하지 않음.
 * 벤더가 이를 노출하는 경우에도 message 패턴 매칭으로 충분히 커버됨.
 */
export function isContextLengthError(err: unknown): boolean {
  let rawMsg: string;
  if (err instanceof Error) {
    rawMsg = err.message;
  } else if (typeof err === "string") {
    rawMsg = err;
  } else if (err !== null && typeof err === "object") {
    // {message: string} or {error: string} (StreamEvent-style)
    const asObj = err as Record<string, unknown>;
    rawMsg = typeof asObj["message"] === "string"
      ? asObj["message"]
      : typeof asObj["error"] === "string"
        ? asObj["error"]
        : "";
  } else {
    return false;
  }

  const msg = rawMsg.toLowerCase();
  // code field (Error instances only)
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    if (code === "context_length_exceeded") return true;
  }

  // Anthropic: "prompt is too long" (status 400, type invalid_request_error)
  if (msg.includes("prompt is too long")) return true;

  // OpenAI fallback message
  if (msg.includes("maximum context length")) return true;

  // Gemini: "The input token count (N) exceeds the maximum number of tokens allowed"
  //         "Input exceeds the context window size"
  if ((msg.includes("exceeds the maximum") && msg.includes("token")) ||
      msg.includes("input token count") ||
      msg.includes("context window")) return true;

  return false;
}

