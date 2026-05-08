/**
 * Auto-Compact — claw-code 패턴: 토큰 기반 컨텍스트 관리
 *
 * 대화가 길어지면 히스토리 토큰이 컨텍스트 윈도우를 초과.
 * 자동으로 오래된 메시지를 요약하여 공간 확보.
 *
 * 핵심 원칙:
 * - tool_use/tool_result 쌍은 절대 분리하지 않음
 * - 최근 N개 메시지는 보존 (기본 4)
 * - 요약은 파일 참조, 진행 중인 작업, 핵심 결정을 보존
 */
import type { GenericMessage, TokenUsage, LLMVendor, UserContentPart } from "./llm/types.js";
import { serializeMessageForEstimation, userContentText } from "./llm/types.js";
import { shouldSkipSummary as _shouldSkipSummary } from "./summary-generator.js";
import { lookupPricing, effectiveContextWindow } from "../shared/pricing-data.js";
import { getUsableContext } from "../shared/context-budget.js";

/** compactMessages()가 boundary marker 뒤에 삽입하는 assistant ACK (double-compact 감지용) */
const POST_COMPACT_ACK = "이전 대화 내용을 확인했습니다. 계속 도와드리겠습니다.";

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

// ─── 3-Tier Rotation Types ────────────────────────────

/**
 * 체크포인트 트리거 종류 (3-tier rotation 결정 트리).
 * - "hard-token":  컨텍스트 윈도우 85% 도달 → 즉시 rotation 필요
 * - "semantic-llm": LLM이 [checkpoint] 마커를 삽입 → 토픽 전환 감지
 * - "soft-time":  24h 경과 또는 30개 메시지 → 자연 체크포인트
 */
export type CheckpointTriggerType = "hard-token" | "semantic-llm" | "soft-time";

export interface RotationDecision {
  shouldRotate: boolean;
  trigger?: CheckpointTriggerType;
  shouldSkipSummary: boolean;
}

/**
 * 3-tier rotation 결정 트리.
 *
 * Tier 1 (hard-token):  ctxUsage >= 0.85 → 무조건 rotation + 요약 생성
 * Tier 2 (semantic-llm): LLM이 [checkpoint] 마커 삽입 → rotation, 요약은 ctxUsage 판단
 * Tier 3 (soft-time):   24h 경과 → rotation, 요약은 ctxUsage 판단 (day-boundary 안전망)
 *
 * @param args.ctxUsage         0.0–1.0 컨텍스트 사용률
 * @param args.sessionAgeMs     세션 시작 이후 경과 ms
 * @param args.semanticHint     [checkpoint] 마커 발견 여부
 * @param args.continuousBackendEnabled  Safety gate: when false, always returns { shouldRotate: false }.
 * @param args.devMode          Developer mode: reduces soft-time threshold to 1h for easier testing.
 *
 * 2026-05-04 incident 후속 정정: tier 3 의 message-count 분기 (`userMessageCount
 * >= 30`) 를 *제거*. message-count 는 토큰/시간/의미 어느 진짜 신호도 측정하지
 * 않는 weak-signal proxy 로 판명 — ctx 1% 인 짧은 도구-heavy 세션에서도 회전
 * 트리거되어 사용자 답변 도중 CheckpointDivider 가 표시되는 incident 의 root
 * cause 였음. context 압박은 tier 1 (토큰), topic shift 는 tier 2 (semantic),
 * day-boundary 안전망만 tier 3 (24h time-based) 으로 정합화. OpenCode 의 순수
 * 토큰 기반 패턴과 정렬됨.
 */
export function decideRotation(args: {
  ctxUsage: number;
  sessionAgeMs: number;
  semanticHint: boolean;
  continuousBackendEnabled?: boolean;
  devMode?: boolean;
}): RotationDecision {
  const { ctxUsage, sessionAgeMs, semanticHint } = args;
  const continuousBackendEnabled = args.continuousBackendEnabled ?? true;
  const devMode = args.devMode ?? false;

  // Safety gate: when experimentalContinuousBackend is OFF, rotation is disabled.
  if (!continuousBackendEnabled) {
    return { shouldRotate: false, shouldSkipSummary: false };
  }

  // Tier 1: hard-token (85% 이상 → 즉시 rotation, 요약 항상 생성)
  if (ctxUsage >= 0.85) {
    return { shouldRotate: true, trigger: "hard-token", shouldSkipSummary: false };
  }

  // Tier 2: semantic (LLM 마커 감지)
  if (semanticHint) {
    return { shouldRotate: true, trigger: "semantic-llm", shouldSkipSummary: _shouldSkipSummary(ctxUsage) };
  }

  // Tier 3: soft-time — day boundary 안전망. devMode 는 1h 로 단축.
  const dayMs = devMode ? 60 * 60 * 1_000 : 24 * 60 * 60 * 1_000;
  if (sessionAgeMs >= dayMs) {
    return { shouldRotate: true, trigger: "soft-time", shouldSkipSummary: _shouldSkipSummary(ctxUsage) };
  }

  return { shouldRotate: false, shouldSkipSummary: false };
}

// ─── Types ──────────────────────────────────────────

export interface CompactConfig {
  /** 자동 컴팩션 트리거 사용률 임계치 (기본 80%) — 모델 컨텍스트 윈도우 대비 */
  thresholdPct: number;
  /** 보존할 최근 메시지 수 (기본 4) */
  preserveRecentMessages: number;
  /** 요약 최대 토큰 예산 (기본 2K) */
  summaryBudgetTokens: number;
}

export interface CompactResult {
  /** 컴팩션 수행 여부 */
  compacted: boolean;
  /** 제거된 메시지 수 */
  removedMessages: number;
  /** 생성된 요약 */
  summary?: string;
  /** 확보된 예상 토큰 수 */
  freedTokens: number;
  /**
   * 컴팩션 트리거 종류.
   * - "auto": 토큰 임계치 기반 사전 컴팩션 (PostTurnHookChain)
   * - "reactive": 벤더 context-length 오류 수신 후 즉시 컴팩션
   */
  trigger?: "auto" | "reactive";
}

const DEFAULT_CONFIG: CompactConfig = {
  thresholdPct: 0.8,
  preserveRecentMessages: 12,
  summaryBudgetTokens: 2_000,
};

// ─── Token Estimation ───────────────────────────────

/** 텍스트의 토큰 수 추정 (claw-code 방식: length/4 + 1) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4) + 1;
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

// ─── Compact Logic ──────────────────────────────────

/**
 * 컴팩션 필요 여부 확인.
 *
 * 임계치 = floor(contextWindowTokens × config.thresholdPct).
 * 호출자는 `getModelUsableContext()` 결과를 넘기므로 (Cline buffer 적용된
 * usable 분모), 0.8 임계는 사실상 "usable 의 80% 도달 → preventive compact".
 *
 * @param cumulativeUsage - 누적 토큰 사용량 (fresh-only inputTokens)
 * @param contextWindowTokens - usable context window — 호출자 책임
 * @param config - 컴팩션 설정 (미제공 시 기본값: thresholdPct=0.8)
 *
 * @example
 * // 200K Sonnet → usable 160K → 80% × 160K = 128K trigger
 * shouldCompact({ inputTokens: 130_000, outputTokens: 0 }, 160_000); // true
 */
export function shouldCompact(
  cumulativeUsage: TokenUsage,
  contextWindowTokens: number,
  config: CompactConfig = DEFAULT_CONFIG,
): boolean {
  const threshold = Math.floor(contextWindowTokens * config.thresholdPct);
  return cumulativeUsage.inputTokens >= threshold;
}

/**
 * 메시지 배열을 컴팩션 — 오래된 메시지를 요약으로 교체
 *
 * @returns 컴팩션된 메시지 배열 + 결과 정보
 */
export function compactMessages(
  messages: GenericMessage[],
  config: CompactConfig = DEFAULT_CONFIG,
  trigger?: "auto" | "reactive",
): { messages: GenericMessage[]; result: CompactResult } {
  if (messages.length <= config.preserveRecentMessages) {
    return { messages, result: { compacted: false, removedMessages: 0, freedTokens: 0 } };
  }

  // 기존 경계 marker가 있으면 절대 re-summarize 하지 않음 (double-compact 방지)
  // marker 이전 메시지는 이미 요약 대상이었으므로, 요약은 마지막 marker 이후부터만 수행
  let lastMarkerIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user" && m.meta?.compactBoundary === true) {
      lastMarkerIdx = i;
    }
  }

  // 보존할 메시지 경계 찾기 (marker 이후 구간에서만 요약)
  const idealBoundary = messages.length - config.preserveRecentMessages;
  const preserveFrom = findSafeBoundary(messages, idealBoundary);
  // 요약 대상은 marker(+ack) 다음부터 preserveFrom까지.
  // compactMessages는 marker 뒤에 ACK assistant 메시지를 붙이므로 그 경우 한 칸 더 skip.
  const ackAfterMarker =
    lastMarkerIdx >= 0 &&
    messages[lastMarkerIdx + 1]?.role === "assistant" &&
    messages[lastMarkerIdx + 1]?.content === POST_COMPACT_ACK;
  const compactStart = lastMarkerIdx >= 0 ? (ackAfterMarker ? lastMarkerIdx + 2 : lastMarkerIdx + 1) : 0;
  const effectivePreserveFrom = Math.max(preserveFrom, compactStart);
  const preAnchor = messages.slice(0, compactStart); // 이전 marker + 그 앞 (있다면)
  const toCompact = messages.slice(compactStart, effectivePreserveFrom);
  const toPreserve = messages.slice(effectivePreserveFrom);

  if (toCompact.length === 0) {
    return { messages, result: { compacted: false, removedMessages: 0, freedTokens: 0 } };
  }

  // 요약 생성
  const summary = generateSummary(toCompact, config.summaryBudgetTokens);
  const freedTokens = estimateMessagesTokens(toCompact) - estimateTokens(summary);

  // 요약 메시지 + 보존 메시지
  const boundaryMessage: GenericMessage = {
    role: "user",
    content: `[이전 대화 요약]\n${summary}`,
    meta: {
      compactBoundary: true,
      removedCount: toCompact.length,
      compactedAt: new Date().toISOString(),
    },
  };
  const compactedMessages: GenericMessage[] = [
    ...preAnchor,
    boundaryMessage,
    { role: "assistant", content: POST_COMPACT_ACK },
    ...toPreserve,
  ];

  return {
    messages: compactedMessages,
    result: {
      compacted: true,
      removedMessages: toCompact.length,
      summary,
      freedTokens: Math.max(0, freedTokens),
      ...(trigger !== undefined && { trigger }),
    },
  };
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
  /** 확보된 총 바이트 수 (문자열 길이 기준) */
  freedChars: number;
}

const DEFAULT_MARK_STALE_CONFIG: MarkStaleConfig = {
  preserveRecentToolResults: 8,
  minStubThreshold: 200,
};

/**
 * Layer 1 — Preventive, LLM-free part marking (renamed from `microcompactMessages` in v3 PR-1b).
 *
 * 오래된 tool_result 메시지 content를 stub string으로 교체해 히스토리 크기를 낮춘다.
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

// ─── Private Helpers ────────────────────────────────

/**
 * tool_use/tool_result 쌍이 분리되지 않는 안전한 경계 찾기
 * claw-code 패턴: 경계가 tool_result 안에 있으면 뒤로 밀어냄
 */
function findSafeBoundary(messages: GenericMessage[], idealBoundary: number): number {
  let boundary = idealBoundary;

  // 경계가 tool_result면 해당 tool_use까지 포함되도록 뒤로 이동
  while (boundary > 0 && boundary < messages.length) {
    const msg = messages[boundary];
    if (msg.role === "tool_result") {
      boundary--;
    } else if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      // assistant의 tool_call과 그 결과가 함께 보존되어야 함
      boundary--;
    } else {
      break;
    }
  }

  return Math.max(0, boundary);
}

/**
 * 메시지 배열에서 요약 생성 (LLM 없이 추출 기반)
 * claw-code 패턴: 파일 참조, 진행 중 작업, 핵심 결정 보존
 */
function generateSummary(messages: GenericMessage[], budgetTokens: number): string {
  const sections: string[] = [];

  // 1. 사용자 요청 요약
  const userRequests = messages
    .filter((m) => m.role === "user" && !userContentText(m.content).startsWith("[이전 대화 요약]"))
    .map((m) => userContentText((m as { content: string | UserContentPart[] }).content).slice(0, 100));
  if (userRequests.length > 0) {
    sections.push(`## 사용자 요청\n${userRequests.map((r) => `- ${r}`).join("\n")}`);
  }

  // 2. 도구 사용 이력
  const toolUses = messages
    .filter((m): m is GenericMessage & { role: "assistant"; toolCalls: NonNullable<(GenericMessage & { role: "assistant" })["toolCalls"]> } =>
      m.role === "assistant" && !!m.toolCalls && m.toolCalls.length > 0)
    .flatMap((m) => m.toolCalls.map((tc) => tc.name));
  if (toolUses.length > 0) {
    const unique = [...new Set(toolUses)];
    sections.push(`## 사용된 도구\n${unique.join(", ")}`);
  }

  // 3. 핵심 응답 요약 (마지막 assistant 메시지에서)
  const assistantMessages = messages.filter((m) => m.role === "assistant" && m.content.length > 20);
  if (assistantMessages.length > 0) {
    const lastFew = assistantMessages.slice(-2);
    const summaries = lastFew.map((m) => m.content.slice(0, 200));
    sections.push(`## 주요 응답\n${summaries.map((s) => `- ${s}...`).join("\n")}`);
  }

  let result = sections.join("\n\n");

  // 토큰 예산 내로 자르기
  const maxChars = budgetTokens * 4;
  if (result.length > maxChars) {
    result = result.slice(0, maxChars) + "\n...(잘림)";
  }

  return result || "이전 대화 내용이 있었습니다.";
}
