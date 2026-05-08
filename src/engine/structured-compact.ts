/**
 * Structured Compact — Layer 2 of `docs/blueprints/infinity-session-redesign-v3.md`.
 *
 * 이 파일은 interface + parser + prompt + LLM call (`compactWithBoundary`) 모두 제공.
 * `ConversationLoop.runPreflightGuard` 가 caller — Layer 0 preflight 도달 시 await.
 *
 * 핵심 추상화:
 *   - `CompactBoundary` — provider-neutral opaque-state slot (codex CLI v2 회귀 권장)
 *     OpenAI 향후 path 의 `openaiCompactionItem` 전체 저장 + Anthropic/Gemini 의
 *     `structuredSummary` 양쪽을 단일 인터페이스로 표현.
 *   - `ParsedSummary` — 12-section SUMMARY_TEMPLATE 의 구조화 결과 (OpenCode 7 + GPT-5 prompting 5).
 *   - `freezeBoundary()` — P7 invariant. ⑧ slot + Layer 3 storage + history[0] 3 view 일관 보장.
 *   - `compactWithBoundary()` — Layer 2 LLM call (동일 vendor 동급 모델, codex Q2 default).
 *
 * 청사진 §4.3, §5, §7.1 참조.
 */

import type { GenericMessage, LLMProvider, StreamEvent } from "./llm/types.js";
import { serializeMessageForEstimation, userContentText } from "./llm/types.js";
import { estimateTokens, estimateMessagesTokens } from "./auto-compact.js";

/** 12-section SUMMARY_TEMPLATE 헤더 (v3 §5.1). 순서/이름 모두 contract — 변경 시 templateVersion bump 필수. */
export const SUMMARY_TEMPLATE_HEADERS_V1 = [
  "Goal",
  "Constraints & Preferences",
  "Progress",
  "Key Decisions",
  "Relevant Files",
  "Next Steps",
  "Critical Context",
  "Current Plan",
  "Verification State",
  "Open Blockers",
  "Unsafe Pending Actions",
  "Last Tool Boundary",
] as const;

export type SummarySectionName = (typeof SUMMARY_TEMPLATE_HEADERS_V1)[number];

/**
 * Parsed 12-section summary. 각 섹션은 raw 본문 string 으로 보존 — LLM 이
 * 다음 turn 에서 이 boundary 를 read 할 때 본문 그대로 회상.
 *
 * `raw` field 는 parser 가 형식 위반을 만난 경우의 ungraceful fallback —
 * LLM 은 raw text 라도 의미 추론 가능하므로 *empty boundary* 보다 낫다.
 */
export interface ParsedSummary {
  templateVersion: 1;
  sections: Partial<Record<SummarySectionName, string>>;
  /** Parser 가 실패한 경우의 raw text. 정상 parse 시 absent. */
  raw?: string;
}

/**
 * Provider-neutral opaque-state slot — codex CLI v2 회귀 권장 패턴 (P2).
 *
 * - `vendorOpaqueState`: OpenAI 향후 path. compaction item 전체 (`{type: "compaction", encrypted_content, ...}`)
 *   를 저장. 현재 PR-2 범위에서는 Anthropic/Gemini 만 활성화되므로 placeholder.
 * - `structuredSummary`: 모든 vendor 의 차선 — 12-section 인간 readable.
 * - `recentVerbatim`: Cline preserve-recent 패턴. 끝 N 토큰 (per-model PRESERVE_RECENT_TOKENS).
 * - `pinnedArtifacts`: skill 도구 출력 + `meta.lock=true` 메시지의 영구 보존.
 * - `toolBoundaryLedger`: 마지막 K 라운드 tool_use/result 요약 — R6 fallback 시
 *   LLM 이 prior tool-chain 회상.
 *
 * Vendor precedence rule (architect v3 정정):
 *   `vendorOpaqueState` 가 *현재 활성 vendor* 와 일치하면 그것 *만* 직렬화 (`structuredSummary` 미포함).
 *   일치 안 하거나 부재 시 `structuredSummary` + `recentVerbatim` 으로 fallback.
 *   *두 채널 동시 직렬화 금지* — double-state hallucination 방지.
 */
export interface CompactBoundary {
  templateVersion: 1;
  /** OpenAI compaction item 전체 (향후 path). string 으로 평탄화 X. */
  vendorOpaqueState?: VendorOpaqueState;
  structuredSummary: ParsedSummary;
  recentVerbatim: GenericMessage[];
  pinnedArtifacts: string[];
  toolBoundaryLedger: ToolCallSummary[];
  /** boundary 생성 시각 (UI/디버깅용). */
  createdAt: string;
  /** 이 boundary 가 #N 번째 compact 의 결과인지 (numbered checkpoint chain). */
  compactNum: number;
}

export type VendorOpaqueState =
  | { vendor: "openai"; openaiCompactionItem: OpenAICompactionItem }
  // 향후 vendor 가 latent state API 를 제공하면 여기에 추가.
  ;

/**
 * OpenAI Responses API 의 compaction item — `/v1/responses/compact` 결과 그대로.
 * `encrypted_content` 는 ZDR/AES-encrypted opaque token (codex CLI v1 회귀 검증).
 * 이 type 은 향후 OpenAI path 활성화 시까지 placeholder.
 */
export interface OpenAICompactionItem {
  type: "compaction";
  encrypted_content: string;
  // OpenAI 가 추가 필드를 정의하면 여기에 확장.
  [k: string]: unknown;
}

/**
 * Tool boundary ledger entry — Codex GPT-5 prompting guide "last tool boundary" 패턴.
 * LLM 이 이 ledger 를 read 하면 prior tool 사용 흐름 회상 가능.
 */
export interface ToolCallSummary {
  round: number;
  toolName: string;
  /** 결과 요지 (200자 이내 trim). isError true 면 원인 first-line. */
  resultSummary: string;
  isError?: boolean;
}

/**
 * SUMMARY_TEMPLATE LLM 프롬프트 (v3 §5.1) — 12-section + 절차 규칙 5개 (P4).
 *
 * `{{conversationText}}` placeholder 는 호출자가 messagesToCompact 직렬화 결과로 치환.
 * `{{timestamp}}` / `{{compactNum}}` 도 마찬가지.
 *
 * NOTE: 이 prompt 의 `Critical Context` 섹션은 LVIS domain specific 항목 포함 — 활성 plugin /
 * routine ID / 작업 PR 번호 / 권한 모드. 청사진 Q1 의 default 결정 (사용자 도메인 입력으로 추가 확장 가능).
 */
export const SUMMARY_TEMPLATE_PROMPT_V1 = `당신은 대화 상태 관리자입니다. 아래 대화를 다음 12 섹션으로 요약하세요.

【절차 규칙 — Codex GPT-5 prompting guide】
1. context-gathering budget: 본문에 명시된 사실만 사용. 추가 검색/추론 금지.
2. early stop: 한 번의 read-through 로 12 섹션 채우기. iterative 정제 금지.
3. done criteria: 12 헤더 모두 *non-empty* 또는 명시적 "(미정)". 빈 섹션 금지.
4. persistence stop condition: 검증 실패 (헤더 누락) 시 1회 재시도, 2회 째 raw fallback.
5. unsafe pending action 명시 의무: DELETE/git push/외부 호출 등 사용자 승인 필요한 액션 누락 금지.

# Session State as of {{timestamp}} (compact #{{compactNum}}, templateVersion 1)

## Goal
사용자의 *현재* 최상위 목표 1-3 줄.

## Constraints & Preferences
명시된 제약 (기술/비즈/시간) + 사용자 선호. bullet.

## Progress
- [x] Done (≤ 5)
- [-] In Progress
- [ ] Pending

## Key Decisions
- decision (이유: why) — 5 개 이내, 최근 우선

## Relevant Files
경로:역할:상태 — read/edited/created, 마지막 동작 시점.

## Next Steps
직전 어시스턴트가 명시한 다음 액션. 없으면 "(미정)".

## Critical Context
잃으면 안 되는 것 — secret/ticket/endpoint/규칙. LVIS 도메인 specific 도 포함:
- 활성 plugin 목록
- 활성 routine ID
- 작업 PR 번호
- 권한 모드 (propose-only / auto)

## Current Plan
직전 LLM 의 multi-step 계획 (step k/N 진행 상황).

## Verification State
검증된/미검증 — "build pass / typecheck pass / e2e pass / human review".

## Open Blockers
풀려야 진행 가능한 외부 의존.

## Unsafe Pending Actions
사용자 승인 없이 실행되면 안 되는 액션.

## Last Tool Boundary
가장 최근 tool_use/tool_result 쌍 — round 번호 + tool 이름 + 결과 요지.

대화:
{{conversationText}}` as const;

/**
 * SUMMARY_TEMPLATE LLM 응답을 파싱. 12 섹션 모두 존재 + non-empty 인지 검증.
 *
 * 누락 시 호출자가 1회 재시도 (P4 절차 4). 2회째 실패 시 `raw` field 로 fallback —
 * LLM 은 raw text 라도 의미 추론 가능하므로 hard-fail 보다 graceful.
 *
 * @returns 파싱 성공 시 sections 채워진 ParsedSummary. 실패 시 raw 만 채워진 객체.
 */
export function parseSummary(text: string): ParsedSummary {
  const sections: Partial<Record<SummarySectionName, string>> = {};

  // Line-by-line parse — JS regex 는 `\Z` (end-of-string anchor) 미지원이라
  // multiline + lookahead 조합이 fragile. 명시적 split 으로 robust 한 contract.
  const validHeaders = new Set<string>(SUMMARY_TEMPLATE_HEADERS_V1);
  const lines = text.split("\n");
  let currentHeader: SummarySectionName | null = null;
  let currentBody: string[] = [];

  const flushCurrent = (): void => {
    if (currentHeader === null) return;
    const body = currentBody.join("\n").trim();
    if (body.length > 0) {
      sections[currentHeader] = body;
    }
  };

  for (const line of lines) {
    const headerMatch = /^##\s+(.+?)\s*$/.exec(line);
    if (headerMatch) {
      flushCurrent();
      const headerText = headerMatch[1];
      currentHeader = validHeaders.has(headerText) ? (headerText as SummarySectionName) : null;
      currentBody = [];
    } else if (currentHeader !== null) {
      currentBody.push(line);
    }
  }
  flushCurrent();

  // 검증: 모든 12 헤더 존재 + non-empty 여야 valid.
  const allPresent = SUMMARY_TEMPLATE_HEADERS_V1.every((h) => sections[h] !== undefined);
  if (!allPresent) {
    return {
      templateVersion: 1,
      sections,
      raw: text,
    };
  }

  return {
    templateVersion: 1,
    sections,
  };
}

/**
 * Generic deep-freeze — P7 invariant 보장을 위해 CompactBoundary 의 모든
 * nested object 를 재귀적으로 freeze.
 *
 * - primitive / null / undefined: 그대로 반환 (freeze 불필요)
 * - 이미 frozen: idempotent (재귀 중단)
 * - circular reference 없는 구조 (CompactBoundary 정의상 acyclic)
 */
function deepFreeze<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    deepFreeze((obj as Record<string, unknown>)[key]);
  }
  return obj;
}

/**
 * P7 invariant — boundary object 와 그 자식 구조를 *deeply freeze*.
 *
 * ⑧ slot + Layer 3 checkpoint storage + history[0] system block — 3 view 가
 * 동일 immutable reference 를 가리키도록 보장. step 9 이후 어떤 view 에서든
 * boundary 가 mutate 되면 race 발생하므로 deepFreeze 로 hard-block.
 *
 * GenericMessage 의 nested mutable fields (content array / toolCalls / thinkingBlocks 등)
 * 도 모두 재귀 freeze — Copilot round 2 지적 (PR-2 round 3 fix).
 */
export function freezeBoundary(boundary: CompactBoundary): Readonly<CompactBoundary> {
  deepFreeze(boundary);
  return boundary;
}

// ─── Layer 2 — compactWithBoundary (LLM call) ──────────

/** Stub message body 가 history 에 들어감 — 진짜 본문은 ⑧ slot 의 preamble. */
const BOUNDARY_STUB_TEMPLATE = (n: number): string =>
  `[이전 대화 요약 #${n} — 자세한 내용은 system prompt 의 ⑧ Compact Summary 섹션 참조]`;

/** parser 실패 시 1회 재시도. 2회째 raw fallback (R2). */
const MAX_PARSE_RETRY = 1;

/** Tool boundary ledger 에 보존할 마지막 K 라운드. */
const TOOL_BOUNDARY_LEDGER_K = 5;

/** Tool ledger 의 결과 요지 trim 길이. */
const LEDGER_RESULT_MAX = 200;

export interface CompactWithBoundaryArgs {
  messages: GenericMessage[];
  llm: LLMProvider;
  model: string;
  /** Cline preserve-recent-tokens — `getModelPreflightThreshold()` 의 일부 또는 별도 설정. */
  preserveRecentTokens: number;
  compactNum: number;
  abortSignal?: AbortSignal;
}

export interface CompactWithBoundaryResult {
  boundary: Readonly<CompactBoundary>;
  newHistory: GenericMessage[];
  removedCount: number;
  /** post-compact estimated input tokens — caller 가 cumulativeUsage 리셋용. */
  estimatedAfter: number;
}

/**
 * `compactWithBoundary` 가 no-op 시 반환 — `toCompact.length === 0` 경로.
 * caller 는 null 을 받으면 compact 건너뜀 (boundary/freeze 부작용 0).
 */
export type CompactWithBoundaryNoOp = null;

/**
 * Layer 2 — Structured compact with LLM call + opaque-state slot.
 *
 * 알고리즘 (v3 §4.3.3, P1 sync chain):
 *   1. preserveRecentTokens 로 split (toCompact / toPreserve), tool_use/tool_result 무결성 보존
 *   2. SUMMARY_TEMPLATE_PROMPT_V1 LLM call — 동일 vendor 동급 모델 (codex 권장)
 *   3. parseSummary (실패 시 1회 재시도, 그래도 실패 시 raw fallback)
 *   4. pinnedArtifacts 수집 (skill / lock=true)
 *   5. toolBoundaryLedger 생성 (마지막 K 라운드)
 *   6. CompactBoundary assemble + freezeBoundary
 *   7. newHistory = [stub user message + boundary meta, ...toPreserve]
 *
 * 호출자 (queryLoop, PR-2-C) 는 step 7 결과로 `history.restore()` + `setSummaryPreamble(renderBoundaryAsPreamble(boundary))`
 * 를 *동기* 순서로 실행해야 ⑧ slot 정합성 보장 (architect N2 sync chain).
 */
export async function compactWithBoundary(
  args: CompactWithBoundaryArgs,
): Promise<CompactWithBoundaryResult | CompactWithBoundaryNoOp> {
  const { messages, llm, model, preserveRecentTokens, compactNum, abortSignal } = args;

  // 1. Split — 끝에서부터 preserveRecentTokens 만큼 보존, tool 페어 안전.
  const { toCompact, toPreserve } = splitForBoundary(messages, preserveRecentTokens);

  if (toCompact.length === 0) {
    // 압축할 내용 없음 — boundary 자체를 만들지 않음. caller 가 null 을 받으면 compact skip.
    // (freezeBoundary 에 외부 messages 배열을 직접 넘기면 caller array 까지 frozen 되는 부작용 차단.)
    return null;
  }

  // 2-3. LLM call + parse with retry-once (R2 mitigation).
  const conversationText = renderConversation(toCompact);
  let summary: ParsedSummary | null = null;
  let lastRawText = "";
  for (let attempt = 0; attempt <= MAX_PARSE_RETRY; attempt++) {
    const text = await callSummaryLLM({
      llm,
      model,
      conversationText,
      compactNum,
      abortSignal,
    });
    lastRawText = text;
    const parsed = parseSummary(text);
    if (!parsed.raw) {
      summary = parsed;
      break;
    }
  }
  if (!summary) {
    // 2회 모두 형식 위반. raw 본문이라도 LLM 이 다음 턴에 의미 추론 가능 → graceful (R2).
    summary = { templateVersion: 1, sections: {}, raw: lastRawText };
  }

  // 4-5. Pinned artifacts + tool boundary ledger.
  const pinnedArtifacts = collectPinned(toCompact);
  const toolBoundaryLedger = makeToolLedger(toCompact, TOOL_BOUNDARY_LEDGER_K);

  // 6. Build + freeze boundary (P7 invariant — 3 view 동일 reference).
  const boundary = freezeBoundary({
    templateVersion: 1,
    structuredSummary: summary,
    recentVerbatim: toPreserve,
    pinnedArtifacts,
    toolBoundaryLedger,
    createdAt: new Date().toISOString(),
    compactNum,
  });

  // 7. Stub boundary message + preserved → newHistory.
  const stubMessage: GenericMessage = {
    role: "user",
    content: BOUNDARY_STUB_TEMPLATE(compactNum),
    meta: {
      compactBoundary: true,
      compactNum,
      removedCount: toCompact.length,
      compactedAt: boundary.createdAt,
      boundary,
    },
  };
  const newHistory: GenericMessage[] = [stubMessage, ...toPreserve];

  return {
    boundary,
    newHistory,
    removedCount: toCompact.length,
    estimatedAfter: estimateMessagesTokens(newHistory),
  };
}

/**
 * CompactBoundary → system prompt ⑧ slot preamble 텍스트 변환.
 *
 * Anthropic / Gemini 는 이 텍스트가 system prompt 안 `<prior-context-summary>` fence
 * 안에 들어감 (`system-prompt-builder.ts:447-453`) — prompt-injection vector 차단 (R9).
 * raw fallback 경우 raw 그대로 반환.
 */
export function renderBoundaryAsPreamble(boundary: CompactBoundary): string {
  if (boundary.structuredSummary.raw !== undefined && boundary.structuredSummary.raw.length > 0) {
    return boundary.structuredSummary.raw;
  }
  const sectionLines: string[] = [];
  for (const header of SUMMARY_TEMPLATE_HEADERS_V1) {
    const body = boundary.structuredSummary.sections[header];
    if (body) {
      sectionLines.push(`## ${header}`, body, "");
    }
  }

  if (boundary.toolBoundaryLedger.length > 0) {
    sectionLines.push("## Recent Tool Activity Ledger");
    for (const entry of boundary.toolBoundaryLedger) {
      const errFlag = entry.isError ? " [error]" : "";
      sectionLines.push(`- round ${entry.round}: ${entry.toolName}${errFlag} → ${entry.resultSummary}`);
    }
    sectionLines.push("");
  }

  if (boundary.pinnedArtifacts.length > 0) {
    sectionLines.push("## Pinned Artifacts");
    for (const a of boundary.pinnedArtifacts) {
      sectionLines.push(`- ${a}`);
    }
    sectionLines.push("");
  }

  const header = `# Compact #${boundary.compactNum} (${boundary.createdAt})`;
  return [header, "", ...sectionLines].join("\n").trimEnd();
}

// ─── Private helpers ────────────────────────────────

/**
 * Token-aware split — 끝에서부터 preserveRecentTokens 까지 보존, 나머지는 compact.
 * tool_use/tool_result 페어 무결성 보존 (claw-code findSafeBoundary 패턴).
 */
function splitForBoundary(
  messages: GenericMessage[],
  preserveRecentTokens: number,
): { toCompact: GenericMessage[]; toPreserve: GenericMessage[] } {
  if (messages.length === 0 || preserveRecentTokens <= 0) {
    return { toCompact: messages, toPreserve: [] };
  }
  let preserveStart = messages.length;
  let preservedTokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(serializeMessageForEstimation(messages[i]));
    preservedTokens += msgTokens;
    preserveStart = i;
    if (preservedTokens >= preserveRecentTokens) break;
  }
  preserveStart = adjustToToolBoundary(messages, preserveStart);
  return {
    toCompact: messages.slice(0, preserveStart),
    toPreserve: messages.slice(preserveStart),
  };
}

/** Move `idx` backwards if it splits a tool_use → tool_result pair. */
function adjustToToolBoundary(messages: GenericMessage[], idx: number): number {
  let cur = idx;
  while (cur > 0 && cur < messages.length) {
    const m = messages[cur];
    if (m.role === "tool_result") {
      cur--;
    } else if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      cur--;
    } else {
      break;
    }
  }
  return Math.max(0, cur);
}

/** Conversation 직렬화 — LLM 프롬프트 본문용. trimmed per-message + role marker. */
function renderConversation(messages: GenericMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      lines.push(`[user] ${userContentText(msg.content).slice(0, 800)}`);
    } else if (msg.role === "assistant") {
      const tool = msg.toolCalls && msg.toolCalls.length > 0
        ? ` (called: ${msg.toolCalls.map((t) => t.name).join(", ")})`
        : "";
      lines.push(`[assistant${tool}] ${msg.content.slice(0, 800)}`);
    } else {
      const errFlag = msg.isError ? " [error]" : "";
      lines.push(`[tool_result ${msg.toolName ?? "?"}${errFlag}] ${msg.content.slice(0, 400)}`);
    }
  }
  return lines.join("\n");
}

/** SUMMARY_TEMPLATE LLM 호출. 동일 vendor 동급 모델 (codex 권장 — Q2 default). */
async function callSummaryLLM(args: {
  llm: LLMProvider;
  model: string;
  conversationText: string;
  compactNum: number;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const isoTime = new Date().toISOString();
  const templateValues: Record<string, string> = {
    conversationText: args.conversationText,
    timestamp: isoTime,
    compactNum: String(args.compactNum),
  };
  const filledPrompt = SUMMARY_TEMPLATE_PROMPT_V1.replace(
    /\{\{(\w+)\}\}/g,
    (_match, key) => templateValues[key] ?? _match,
  );

  let text = "";
  for await (const ev of args.llm.streamTurn({
    model: args.model,
    systemPrompt:
      "당신은 대화 상태 관리자입니다. 12-section structured summary 를 정확히 출력하세요. 형식 위반 금지.",
    messages: [{ role: "user", content: filledPrompt }],
    tools: [],
    ...(args.abortSignal !== undefined && { abortSignal: args.abortSignal }),
  }) as AsyncIterable<StreamEvent>) {
    if (args.abortSignal?.aborted) {
      throw new Error("Layer 2 compact aborted by signal");
    }
    if (ev.type === "text_delta" && ev.text) {
      text += ev.text;
    } else if (ev.type === "message_complete") {
      break;
    } else if (ev.type === "error") {
      throw new Error(`Layer 2 LLM error: ${ev.error}`);
    }
  }
  return text.trim();
}

/** skill route 도구 출력 + `meta.lock=true` 메시지의 압축 면제 — 정확한 paths/IDs 수집. */
function collectPinned(messages: GenericMessage[]): string[] {
  const pinned = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "tool_result" && msg.toolName === "skill") {
      const head = msg.content.split("\n")[0]?.slice(0, 200) ?? "";
      if (head) pinned.add(`skill:${head}`);
    }
    if (msg.meta?.lock === true) {
      const sig = msg.role === "user"
        ? `lock-user:${userContentText(msg.content).slice(0, 80)}`
        : msg.role === "assistant"
          ? `lock-assistant:${msg.content.slice(0, 80)}`
          : `lock-tool:${msg.toolName ?? "?"}:${msg.content.slice(0, 80)}`;
      pinned.add(sig);
    }
  }
  return Array.from(pinned);
}

/** 마지막 K 라운드 tool_use/tool_result 쌍을 ledger 로 — Codex GPT-5 prompting "last tool boundary" 패턴. */
function makeToolLedger(messages: GenericMessage[], k: number): ToolCallSummary[] {
  const entries: ToolCallSummary[] = [];
  let round = 0;
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      round++;
    }
    if (msg.role !== "tool_result") continue;
    const trimmed = msg.content.length > LEDGER_RESULT_MAX
      ? msg.content.slice(0, LEDGER_RESULT_MAX) + "…"
      : msg.content;
    const entry: ToolCallSummary = {
      round,
      toolName: msg.toolName ?? "?",
      resultSummary: trimmed,
    };
    if (msg.isError) entry.isError = true;
    entries.push(entry);
  }
  return entries.slice(-k);
}
