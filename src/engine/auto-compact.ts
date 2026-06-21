/**
 * Auto-Compact — LVIS token-based context management
 *
 * 대화가 길어지면 히스토리 토큰이 컨텍스트 윈도우를 초과.
 * 자동으로 오래된 메시지를 요약하여 공간 확보.
 *
 * 핵심 원칙:
 * - tool_use/tool_result 쌍은 절대 분리하지 않음
 * - 최근 N개 메시지는 보존 (DEFAULT_CONFIG.preserveRecentMessages = 12)
 * - 요약은 파일 참조, 진행 중인 작업, 핵심 결정을 보존
 */
import type { GenericMessage, LLMVendor } from "./llm/types.js";
import { serializeMessageForEstimation } from "./llm/types.js";
import { lookupPricing, effectiveContextWindow } from "../shared/pricing-data.js";
import { getUsableContext, getPreflightThreshold } from "../shared/context-budget.js";
import { buildToolResultStrippedStub, buildToolResultTruncatedStub } from "../shared/tool-result-stub.js";
import { estimateMultimodalTokenOverhead } from "../shared/multimodal-token-estimate.js";
import { estimateTokens } from "../shared/token-estimate.js";

// Token-count primitives now live in shared/token-estimate.ts (architecture
// §4.6.2 — leaf primitive below both prompts/ and engine/). Re-exported here so
// existing engine callers keep importing them from auto-compact unchanged.
// estimateTokens is also imported above for use by estimateMessagesTokens.
export { countHangul, estimateTokens } from "../shared/token-estimate.js";


// ─── Context Window Registry ─────────────────────────
//
// Single source of truth for context windows lives in
// `shared/pricing-data.ts:DEFAULT_PRICING`. This module defers all lookups
// there. The previous in-tree `MODEL_CONTEXT_WINDOWS` table was removed so
// pricing and context-window data share one maintained source.

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
 * as the denominator for "fullness" math. Subtracts LVIS fixed
 * buffer (output + safety reservation). See {@link getUsableContext}.
 *
 * Use this for compact decisions and any UI ring that should hit 100% at the
 * compact threshold rather than at the raw context window.
 */
export function getModelUsableContext(vendor: LLMVendor, model: string): number {
  return getUsableContext(getModelContextWindow(vendor, model));
}

/**
 * Token preflight trigger (절대 token count). Same-session checkpoint
 * compaction starts at 80% of the model-specific usable context budget.
 * 호출자: queryLoop 의 step 5/6 사이.
 *
 * **Dev override**: `LVIS_DEV_PREFLIGHT_OVERRIDE` 환경변수가 양의 정수면 그
 * 값을 그대로 사용. 실제 200K context 를 채우지 않고도 compact 시나리오 (130%
 * deadlock, FORCED path 등) 를 손쉽게 재현 가능. production NODE_ENV 에서는
 * 무시 — bypass 위험 차단.
 *
 * Example: `LVIS_DEV_PREFLIGHT_OVERRIDE=5000 bun run start` 로 실행하면
 * preflight 가 5K tokens 로 떨어져 짧은 대화만으로도 auto compact 트리거 가능.
 *
 * @example
 * // 200K Sonnet → usable 160K → 80% × 160K = 128K trigger
 * estimateMessagesTokens(history) >= getModelPreflightThreshold("claude", "claude-sonnet-4-6");
 */
export function getModelPreflightThreshold(vendor: LLMVendor, model: string): number {
  // Priority: runtime override (UI slider) > env var (LVIS_DEV_PREFLIGHT_OVERRIDE) > computed.
  if (_runtimePreflightOverride !== null) return _runtimePreflightOverride;
  const devOverride = readDevPreflightOverride();
  if (devOverride !== null) return devOverride;
  const windowThreshold = getPreflightThreshold(getModelContextWindow(vendor, model));
  // Issue #900 #3: small-tier 모델 (nano 200K TPM, mini 2M TPM 등) 은
  // contextWindow 보다 *분당 처리량 (TPM)* 한도가 훨씬 작음 — 단발 input 이
  // window 안이라도 TPM 초과로 429. preflight 가 TPM*0.8 도 같이 보고
  // *min* 으로 compact trigger — 사용자 영상의 271K nano 사고 prevention.
  // 0.8 safety margin: 대화 history 외에 system prompt / tool schemas /
  // pageindex 가 추가로 들어가 실제 전송 size 는 estimate 보다 큼.
  const pricing = lookupPricing(vendor, model);
  if (typeof pricing.tpmDefault === "number" && pricing.tpmDefault > 0) {
    const tpmThreshold = Math.floor(pricing.tpmDefault * 0.8);
    return Math.min(windowThreshold, tpmThreshold);
  }
  return windowThreshold;
}

let _devOverrideWarnedValue: number | null | undefined = undefined;
let _runtimePreflightOverride: number | null = null;

function readDevPreflightOverride(): number | null {
  if (process.env.NODE_ENV === "production") return null;
  const raw = process.env.LVIS_DEV_PREFLIGHT_OVERRIDE;
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  // 첫 read 시 한 번만 log — 매 호출 spam 방지.
  if (_devOverrideWarnedValue !== n) {
    // eslint-disable-next-line no-console
    console.warn(`[lvis] dev preflight override active: LVIS_DEV_PREFLIGHT_OVERRIDE=${n} tokens (production NODE_ENV 에서는 무시됨)`);
    _devOverrideWarnedValue = n;
  }
  return n;
}

/**
 * Runtime dev preflight override — IPC 가 UI slider 의 값을 push 할 때 사용.
 * production NODE_ENV 에서는 set 자체를 거부 (no-op).
 * `null` 전달 시 override clear → env var / computed 로 fallback.
 */
export function setRuntimePreflightOverride(n: number | null): void {
  if (process.env.NODE_ENV === "production") return;
  if (n === null) {
    _runtimePreflightOverride = null;
    return;
  }
  if (!Number.isFinite(n) || n <= 0) return;
  _runtimePreflightOverride = Math.floor(n);
}

/** Renderer UI 가 현재 활성 runtime override 값 (또는 null) 을 조회. */
export function getRuntimePreflightOverride(): number | null {
  return _runtimePreflightOverride;
}

// Compact pipeline: token preflight -> LLM compact -> same-session checkpoint.
// Automatic session splitting is not part of this model.

// ─── Types ──────────────────────────────────────────

// ─── Token Estimation ───────────────────────────────
//
// estimateTokens / countHangul are re-exported from shared/token-estimate.ts
// at the top of this module. estimateMessagesTokens stays here because it
// depends on engine-only types (GenericMessage, wire serialization, tool-result
// stubbing) and so cannot move down to shared/.

/** 메시지 배열의 총 토큰 추정 */
export function estimateMessagesTokens(messages: GenericMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    // Estimate tokens from the provider-wire shape, not the verbatim
    // in-memory shape. Marked tool_results keep raw content in memory for UI
    // and checkpoint inspection, but stream-collector stubs them immediately
    // before provider send. Counting the raw content here makes preflight and
    // session-load rings fire far earlier than the actual payload.
    total += estimateTokens(serializeMessageForWireEstimate(msg));
    if (msg.role === "user" && Array.isArray(msg.content)) {
      total += estimateMultimodalTokenOverhead(msg.content);
    }
  }
  return total;
}

function serializeMessageForWireEstimate(message: GenericMessage): string {
  if (message.role !== "tool_result") {
    return serializeMessageForEstimation(message);
  }
  if (message.meta?.serializedStub === true) {
    return serializeMessageForEstimation(message);
  }

  const content =
    message.meta?.compactedAt !== undefined
      ? buildToolResultStub(message.toolName, message.meta.truncated?.originalBytes ?? message.content.length)
      : message.meta?.truncated !== undefined
        ? buildToolResultTruncatedStub(message.toolUseId, message.toolName, message.meta.truncated)
        : message.content;

  return serializeMessageForEstimation({
    ...message,
    content,
  });
}


// ─── Mark Stale Tool Results (memory-verbatim, serialization-stub) ───────────
//
// Same-session checkpoint compaction uses the full marker pattern.
// 이전 동작: content 즉시 stub 으로 교체 → memory/wire/disk 단일 source.
// 현재 동작: meta.compactedAt 만 set, content *verbatim* 보존.
//   - memory: verbatim (UI / checkpoint preview 가 원본 표시 가능)
//   - wire: `wire-serialize.ts:stubMarkedToolResults` 가 provider 호출 직전 stub 변환
//   - disk: `MemoryManager.saveSession` 이 stub JSONL + file-backed artifact 로 영속화
//
// `meta.stripped` / `meta.strippedAt` / `meta.originalLength` 는 제거됨 (호환성 layer 없음).
// 단일 marker `meta.compactedAt` 가 "이 message 는 serialization 시 stub 으로 변환되어야 함" 을 의미.

export interface MarkStaleConfig {
  /** 말단에서부터 이 개수만큼의 tool_result는 raw 유지 (기본 8) */
  preserveRecentToolResults: number;
  /** 이 길이(자) 미만의 tool_result는 mark 대상에서 제외 (기본 200, LVIS noise floor) */
  minStubThreshold?: number;
}

export interface MarkStaleResult {
  /** 실제 mark 가 일어났는지 여부 */
  marked: boolean;
  /** mark 된 tool_result 개수 */
  markedCount: number;
  /** 직렬화 시 절약될 예상 문자 수 (UTF-16 code unit) (sum of original.length − stub.length) */
  freedCharsOnSerialize: number;
}

const DEFAULT_MARK_STALE_CONFIG: MarkStaleConfig = {
  preserveRecentToolResults: 8,
  minStubThreshold: 200,
};

/**
 * stub 텍스트 — wire/disk 직렬화 시 marked tool_result content 를 이 패턴으로 교체.
 * `wire-serialize.ts` 와 같은 패턴 사용 (단일 source of truth).
 */
export function buildToolResultStub(toolName: string | undefined, origLen: number): string {
  return buildToolResultStrippedStub(toolName, origLen);
}

/**
 * Preventive, LLM-free part marking. Memory verbatim 보존.
 *
 * - 최근 `preserveRecentToolResults` 개는 mark 면제 (assistant 가 직접 참조 가능)
 * - content 길이가 `minStubThreshold` 미만이면 mark 면제 (직렬화 시 절약 ≈ 0)
 * - 이미 marked (`meta.compactedAt` 존재) 메시지는 skip (idempotent)
 * - `toolUseId`, `content`, `toolName`, `isError` 모두 *verbatim* — meta 만 추가
 * - 입력 array 는 mutate 하지 않고 새 배열 반환. mark 된 메시지만 새 객체.
 */
export function markStaleToolResults(
  messages: GenericMessage[],
  config: MarkStaleConfig = DEFAULT_MARK_STALE_CONFIG,
): { messages: GenericMessage[]; result: MarkStaleResult } {
  const preserveCount = Math.max(0, config.preserveRecentToolResults);
  const minStub = config.minStubThreshold ?? DEFAULT_MARK_STALE_CONFIG.minStubThreshold ?? 200;

  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool_result") toolResultIndices.push(i);
  }

  if (toolResultIndices.length <= preserveCount) {
    return {
      messages,
      result: { marked: false, markedCount: 0, freedCharsOnSerialize: 0 },
    };
  }

  const markCandidates = toolResultIndices.slice(0, toolResultIndices.length - preserveCount);
  const eligibleCandidates = markCandidates.filter((i) => {
    const m = messages[i];
    if (m.role !== "tool_result") return false;
    if (m.meta?.compactedAt !== undefined) return false; // idempotent
    return m.content.length >= minStub;
  });
  if (eligibleCandidates.length === 0) {
    return {
      messages,
      result: { marked: false, markedCount: 0, freedCharsOnSerialize: 0 },
    };
  }
  const markCandidateIdxSet = new Set(eligibleCandidates);

  let markedCount = 0;
  let freedCharsOnSerialize = 0;
  const nowIso = new Date().toISOString();

  const out = messages.map((msg, i) => {
    if (!markCandidateIdxSet.has(i)) return msg;
    if (msg.role !== "tool_result") return msg;

    const origLen = msg.content.length;
    const stubLen = buildToolResultStub(msg.toolName, origLen).length;
    freedCharsOnSerialize += Math.max(0, origLen - stubLen);
    markedCount += 1;

    return {
      role: "tool_result",
      toolUseId: msg.toolUseId,
      toolName: msg.toolName,
      isError: msg.isError,
      content: msg.content, // *verbatim* — content 보존
      meta: {
        ...(msg.meta ?? {}),
        compactedAt: nowIso,
      },
    } as GenericMessage;
  });

  return {
    messages: out,
    result: {
      marked: markedCount > 0,
      markedCount,
      freedCharsOnSerialize,
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
