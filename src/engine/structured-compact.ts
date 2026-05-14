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

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { GenericMessage, LLMProvider, StreamEvent } from "./llm/types.js";
import { serializeMessageForEstimation, userContentText } from "./llm/types.js";
import { estimateTokens, estimateMessagesTokens } from "./auto-compact.js";
import { lvisHome } from "../shared/lvis-home.js";
import {
  CompressionStatus,
  TRUNCATION_THRESHOLD_TOKENS,
  TRUNCATION_PRESERVED_LINES,
} from "../shared/compact-status.js";

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
  /**
   * Session id — 단일 거대 메시지 truncation pre-pass 가 원본 content 를
   * `~/.lvis/sessions/<sessionId>/truncated/` 디렉토리에 격리할 때 사용.
   */
  sessionId: string;
  /**
   * Preflight 토큰. compact 후 estimatedAfter 가 이 값의 일정 비율을 초과하면
   * last-resort raw truncation (`REDUCED_INSUFFICIENT_FORCED`) 발동.
   */
  preflightTokens: number;
  abortSignal?: AbortSignal;
}

export interface CompactWithBoundaryResult {
  /**
   * 사용자 가시 compact 결과 분류 — 단순 success/failure 가 아닌 4 상태로
   * 구분된다. Renderer 가 status 별로 다른 banner variant 를 표시한다.
   */
  status: CompressionStatus;
  /** SUMMARIZED 경로에서만 truthy. NOOP/CONTENT_TRUNCATED 경로에선 null. */
  boundary: Readonly<CompactBoundary> | null;
  newHistory: GenericMessage[];
  /** History 에서 stub 으로 대체된 메시지 수. NOOP=0, CONTENT_TRUNCATED=절단된 메시지 수, SUMMARIZED=요약된 메시지 수. */
  removedCount: number;
  /** post-compact estimated input tokens — caller 가 cumulativeUsage 리셋용. */
  estimatedAfter: number;
  /** CONTENT_TRUNCATED 경로의 원본 보존 디렉토리. 사용자 banner 에 표시. */
  truncatedDir?: string;
  /** Phase 2 truncation 으로 격리된 메시지 수. */
  truncatedCount: number;
}

/**
 * Per-message truncation pre-pass — Codex CLI `TruncationPolicy` 패턴.
 *
 * 단일 메시지가 `TRUNCATION_THRESHOLD_TOKENS` 를 초과하면:
 *   - 원본 content 를 `~/.lvis/sessions/<sessionId>/truncated/compact-<N>-msg-<idx>.txt` 로 격리
 *   - in-memory content 를 `<last N lines>\n[…full content saved to <path>]` 로 대체
 *
 * 효과:
 *   - 단일 200K+ 메시지가 compact LLM call 의 input context 를 초과하는 deadlock 해소
 *   - 원본은 보존되어 사용자가 archive 접근 가능
 *   - tool_use/tool_result content 모두 적용 (가장 흔한 oversize 케이스)
 */
async function truncateOversizeMessages(
  messages: GenericMessage[],
  sessionId: string,
  compactNum: number,
): Promise<{ messages: GenericMessage[]; truncatedCount: number; truncatedDir: string }> {
  const truncatedDir = path.join(lvisHome(), "sessions", sessionId, "truncated");
  let truncatedCount = 0;
  const result: GenericMessage[] = [];
  let dirCreated = false;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const msgTokens = estimateTokens(serializeMessageForEstimation(msg));
    if (msgTokens <= TRUNCATION_THRESHOLD_TOKENS) {
      result.push(msg);
      continue;
    }

    if (!dirCreated) {
      await fs.mkdir(truncatedDir, { recursive: true, mode: 0o700 });
      dirCreated = true;
    }

    const uuid = randomUUID();
    const fileName = `compact-${compactNum}-msg-${i}-${Date.now()}-${uuid}.txt`;
    const filePath = path.join(truncatedDir, fileName);
    const fullText = extractMessageText(msg);
    await fs.writeFile(filePath, fullText, { mode: 0o600 });

    const lines = fullText.split("\n");
    const preservedLines = lines.slice(-TRUNCATION_PRESERVED_LINES);
    const clippedText = [
      `[…earlier ${lines.length - preservedLines.length} lines truncated, full content saved to ${filePath}]`,
      ...preservedLines,
    ].join("\n");

    result.push(rebuildMessageWithText(msg, clippedText));
    truncatedCount++;
  }

  return { messages: result, truncatedCount, truncatedDir };
}

/** Extract a single text representation of a message for truncation. */
function extractMessageText(msg: GenericMessage): string {
  if (msg.role === "user") return userContentText(msg.content);
  if (msg.role === "assistant") {
    const tool = msg.toolCalls && msg.toolCalls.length > 0
      ? `\n[tool calls: ${msg.toolCalls.map((t) => t.name).join(", ")}]`
      : "";
    return `${msg.content}${tool}`;
  }
  // tool_result — include toolName + isError marker for provenance so the
  // archive file is self-describing without cross-referencing the assistant's
  // toolCalls metadata (critic MINOR-1).
  const provenance = `[tool_result: tool=${msg.toolName ?? "?"}${msg.isError ? " error" : ""}]\n`;
  return `${provenance}${msg.content}`;
}

/** Rebuild a message with new text content, preserving role + tool metadata. */
function rebuildMessageWithText(msg: GenericMessage, newText: string): GenericMessage {
  if (msg.role === "user") {
    return { ...msg, content: newText };
  }
  if (msg.role === "assistant") {
    return { ...msg, content: newText };
  }
  return { ...msg, content: newText };
}

/**
 * Archive a slice of messages to `~/.lvis/sessions/<id>/truncated/` as a JSON
 * file. Used by:
 *   - Layer A.5 (history-wide reverse-budget truncation): oldest messages
 *     beyond the LLM's input budget are archived rather than fed to the LLM.
 *   - REDUCED_INSUFFICIENT_FORCED path: oldest preserve slice that gets
 *     dropped is archived rather than silently destroyed.
 *
 * Returns the truncatedDir (always set if `messages.length > 0`), so callers
 * can surface the location to the user via the compact_notice banner.
 */
async function archiveDroppedMessages(
  messages: GenericMessage[],
  sessionId: string,
  compactNum: number,
  label: "precompact-drop" | "forced-drop",
): Promise<string> {
  if (messages.length === 0) return "";
  const truncatedDir = path.join(lvisHome(), "sessions", sessionId, "truncated");
  await fs.mkdir(truncatedDir, { recursive: true, mode: 0o700 });
  const uuid = randomUUID();
  const fileName = `compact-${compactNum}-${label}-${Date.now()}-${uuid}.json`;
  const filePath = path.join(truncatedDir, fileName);
  await fs.writeFile(filePath, JSON.stringify(messages, null, 2), { mode: 0o600 });
  return truncatedDir;
}

/**
 * Layer A.5 — history-wide reverse-budget truncation.
 *
 * After `splitForBoundary` produces `toCompact`, this pass guarantees
 * `toCompact` fits into the LLM's input budget before the summary call.
 * Walks from oldest forward, dropping messages until the cumulative token
 * count is under `budget`. Dropped messages are archived to disk so users
 * can recover originals if needed (Gemini CLI pattern).
 *
 * Resolves the "many medium messages accumulating to >budget" case that
 * per-message truncation (`truncateOversizeMessages`) cannot solve alone —
 * each message is under the per-message threshold (30K) but their sum
 * exceeds the LLM input window.
 */
async function dropOldestUntilUnderBudget(
  toCompact: GenericMessage[],
  budget: number,
  sessionId: string,
  compactNum: number,
): Promise<{ messages: GenericMessage[]; droppedCount: number; truncatedDir: string }> {
  if (budget <= 0 || toCompact.length === 0) {
    return { messages: toCompact, droppedCount: 0, truncatedDir: "" };
  }
  // Precompute per-message token counts once. The naive implementation
  // re-ran `estimateMessagesTokens(surviving)` after every shift (O(N²)
  // serialization cost on 200+ message histories while holding `isCompacting`
  // lock). Maintain a running total instead — O(N).
  const perMessageTokens = toCompact.map((m) => estimateTokens(serializeMessageForEstimation(m)));
  let currentTotal = perMessageTokens.reduce((a, b) => a + b, 0);
  if (currentTotal <= budget) {
    return { messages: toCompact, droppedCount: 0, truncatedDir: "" };
  }
  const dropped: GenericMessage[] = [];
  const surviving = [...toCompact];
  // `cursor` indexes into the *precomputed* `perMessageTokens` array, which
  // is in the original `toCompact` order. We rely on the invariant that
  // `surviving.shift()` drops the oldest, which maps 1:1 with `perMessageTokens[cursor]`
  // — this is fragile to future edits that change the drop order (e.g.,
  // drop-from-middle), so keep the array indexing consistent if reworked.
  let cursor = 0;
  // Keep at least 1 message — `surviving.length > 1` invariant stops the loop
  // before emptying toCompact (which would then trigger NOOP / no LLM call).
  // If a single message is genuinely huge, Layer A (per-message truncation)
  // already clipped it.
  while (currentTotal > budget && surviving.length > 1) {
    const oldest = surviving.shift();
    if (oldest === undefined) break;
    dropped.push(oldest);
    currentTotal -= perMessageTokens[cursor];
    cursor += 1;
  }
  const truncatedDir = await archiveDroppedMessages(dropped, sessionId, compactNum, "precompact-drop");
  return { messages: surviving, droppedCount: dropped.length, truncatedDir };
}

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
): Promise<CompactWithBoundaryResult> {
  const { messages, llm, model, preserveRecentTokens, compactNum, sessionId, preflightTokens, abortSignal } = args;

  // 0. Per-message truncation pre-pass (Phase 2, Codex pattern).
  //    단일 거대 메시지 (>30K tokens) 가 LLM input context 초과하는 케이스 방지.
  const { messages: workingMessages, truncatedCount, truncatedDir: layerATruncDir } =
    await truncateOversizeMessages(messages, sessionId, compactNum);

  // 1. Split — 끝에서부터 preserveRecentTokens 만큼 보존, tool 페어 안전.
  const { toCompact, toPreserve } = splitForBoundary(workingMessages, preserveRecentTokens);

  if (toCompact.length === 0) {
    if (truncatedCount > 0) {
      // CONTENT_TRUNCATED — Layer A 만으로 충분히 reduce (LLM 호출 skip).
      return {
        status: CompressionStatus.CONTENT_TRUNCATED,
        boundary: null,
        newHistory: workingMessages,
        removedCount: truncatedCount,
        estimatedAfter: estimateMessagesTokens(workingMessages),
        truncatedDir: layerATruncDir,
        truncatedCount,
      };
    }
    // NOOP — history 가 충분히 작음. 정상 small-history 경로.
    return {
      status: CompressionStatus.NOOP,
      boundary: null,
      newHistory: messages,
      removedCount: 0,
      estimatedAfter: estimateMessagesTokens(messages),
      truncatedCount: 0,
    };
  }

  // 1a. Layer A.5 — history-wide reverse-budget truncation (Gemini pattern,
  //     CRITICAL contract fix). Per-message truncation handles ONE huge
  //     message, but many medium messages (예: 200 × 1K tokens) summing
  //     to > preflight will still overflow the LLM input context. Drop
  //     oldest from `toCompact` (archive to disk) until total <= 90% preflight.
  const llmInputBudget = preflightTokens > 0 ? Math.floor(preflightTokens * 0.9) : Infinity;
  const layerAHalfResult = await dropOldestUntilUnderBudget(
    toCompact,
    llmInputBudget,
    sessionId,
    compactNum,
  );
  const finalToCompact = layerAHalfResult.messages;
  const layerAHalfDir = layerAHalfResult.truncatedDir;
  const totalTruncatedFromLayerA = truncatedCount + layerAHalfResult.droppedCount;

  // 2-3. LLM call + parse with retry-once (R2 mitigation).
  const conversationText = renderConversation(finalToCompact);
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
    summary = { templateVersion: 1, sections: {}, raw: lastRawText };
  }

  // 4-5. Pinned artifacts + tool boundary ledger — finalToCompact 기준
  //     (Layer A.5 archive 이후 LLM 에 실제로 들어간 메시지들).
  const pinnedArtifacts = collectPinned(finalToCompact);
  const toolBoundaryLedger = makeToolLedger(finalToCompact, TOOL_BOUNDARY_LEDGER_K);

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
      removedCount: finalToCompact.length + layerAHalfResult.droppedCount,
      compactedAt: boundary.createdAt,
      boundary,
    },
  };
  let newHistory: GenericMessage[] = [stubMessage, ...toPreserve];
  let estimatedAfter = estimateMessagesTokens(newHistory);

  // 7a. REDUCED_INSUFFICIENT_FORCED — post-compact 이 preflight × 0.8 초과.
  //     last-resort 로 toPreserve 의 oldest 50% 강제 drop. **사용자 contract
  //     "원본 보존" 충족 위해 dropped slice 도 archive 파일로 격리.**
  if (preflightTokens > 0 && estimatedAfter > preflightTokens * 0.8 && toPreserve.length > 0) {
    const rawDropCount = Math.ceil(toPreserve.length / 2);
    // Tool-pair safety: surviving 의 첫 메시지가 orphan tool_result 가 되지
    // 않도록 dropCount 를 앞으로 민다. 그렇지 않으면 provider 가 400
    // (tool_use_id 미스매치) 으로 거부 — 원래 C1 deadlock fix 의도 회귀.
    const dropCount = adjustForwardToToolBoundary(toPreserve, rawDropCount);
    const droppedSlice = toPreserve.slice(0, dropCount);
    const survivingPreserve = toPreserve.slice(dropCount);
    const forcedArchiveDir = await archiveDroppedMessages(
      droppedSlice,
      sessionId,
      compactNum,
      "forced-drop",
    );
    newHistory = [stubMessage, ...survivingPreserve];
    estimatedAfter = estimateMessagesTokens(newHistory);
    const finalTruncDir = forcedArchiveDir || layerAHalfDir || layerATruncDir || "";
    const finalTruncCount = totalTruncatedFromLayerA + dropCount;
    return {
      status: CompressionStatus.REDUCED_INSUFFICIENT_FORCED,
      boundary,
      newHistory,
      removedCount: finalToCompact.length + layerAHalfResult.droppedCount + dropCount,
      estimatedAfter,
      truncatedCount: finalTruncCount,
      ...(finalTruncDir !== "" ? { truncatedDir: finalTruncDir } : {}),
    };
  }

  // SUMMARIZED — 정상 경로. CONTENT_TRUNCATED 는 위쪽 early-return 에서 이미
  // 처리됐고 (toCompact.length === 0 분기), dropOldestUntilUnderBudget 는
  // surviving.length > 1 invariant 를 유지하므로 여기 도달 시 finalToCompact 가
  // 비어있을 가능성 없음.
  const summarizedTruncDir = layerAHalfDir || layerATruncDir || "";
  return {
    status: CompressionStatus.SUMMARIZED,
    boundary,
    newHistory,
    removedCount: finalToCompact.length + layerAHalfResult.droppedCount,
    estimatedAfter,
    truncatedCount: totalTruncatedFromLayerA,
    ...(summarizedTruncDir !== "" ? { truncatedDir: summarizedTruncDir } : {}),
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
 *
 * Contract (compact 가 어떤 input 에도 reduce 보장하기 위한 의미):
 *   - preserveRecentTokens 는 **ceiling** — preserve 영역의 누적 토큰이 이 값을
 *     초과하면 더 이상 메시지를 포함시키지 않는다.
 *   - 단일 메시지가 preserveRecentTokens 를 단독으로 초과하면 preserve 는 빈
 *     배열이 되고 그 메시지를 포함한 전체가 compact 대상이 된다.
 *   - tool_use/tool_result 페어가 boundary 에 의해 갈리는 경우
 *     `adjustToToolBoundary` 가 최대 3 step backward walk 하여 페어를 같은
 *     쪽으로 정렬한다. 더 깊은 tool chain 이면 partial-pair 허용 (LLM summary
 *     의 R2 raw fallback 이 처리).
 */
function splitForBoundary(
  messages: GenericMessage[],
  preserveRecentTokens: number,
): { toCompact: GenericMessage[]; toPreserve: GenericMessage[] } {
  if (messages.length === 0) {
    return { toCompact: [], toPreserve: [] };
  }
  if (preserveRecentTokens <= 0) {
    return { toCompact: messages, toPreserve: [] };
  }
  let preserveStart = messages.length;
  let preservedTokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(serializeMessageForEstimation(messages[i]));
    if (preservedTokens + msgTokens > preserveRecentTokens) break;
    preservedTokens += msgTokens;
    preserveStart = i;
  }
  preserveStart = adjustToToolBoundary(messages, preserveStart);
  // 추가 안전망 — backward walk 가 bounded (3 step) 이라 더 깊은 tool chain
  // 에서 preserveStart 가 여전히 orphan tool_result 를 가리킬 수 있음. forward
  // walk 로 tool_result prefix 를 toCompact 쪽으로 넘겨 toPreserve[0] 이
  // 절대 orphan tool_result 가 되지 않게 한다 — 그렇지 않으면 다음 turn 의
  // provider 호출이 tool_use_id 미스매치로 400.
  preserveStart = adjustForwardToToolBoundary(messages, preserveStart);
  return {
    toCompact: messages.slice(0, preserveStart),
    toPreserve: messages.slice(preserveStart),
  };
}

/**
 * tool_use/tool_result 페어 무결성 보존 — **bounded backward walk only**.
 *
 * 기본 전략: idx 에서 backward 로 최대 3 step 까지만 walk. tool_result /
 * assistant+toolCalls 가 연속되면 그 만큼 뒤로 밀고, 그 외엔 즉시 break.
 *
 * **No forward fallback** — 이전 구현은 backward 가 0 으로 collapse 시
 * forward walk 로 fallback 했지만, 이는 `backward === 0` 만 트리거 조건으로
 * 사용해 entire-prefix-is-tool 와 deep-history-coincidentally-zero 두 케이스를
 * 구분 못 함 → non-deadlock 케이스에 forward walk 가 misfire 하여 toCompact
 * 가 의도 외로 비어지는 회귀 발생.
 *
 * 대신 backward 를 3-step 으로 bound — 더 깊은 tool chain 이면 partial-pair
 * 허용. LLM summary 는 orphan tool_use/tool_result 가 있어도 12-section
 * 생성 가능 (R2 raw fallback 과 동일 원리).
 */
function adjustToToolBoundary(messages: GenericMessage[], idx: number): number {
  const minIdx = Math.max(0, idx - 3);
  let cur = idx;
  while (cur > minIdx) {
    const m = messages[cur];
    if (m.role === "tool_result") {
      cur--;
    } else if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      cur--;
    } else {
      break;
    }
  }
  return cur;
}

/**
 * FORCED 분기 + splitForBoundary 의 안전망 — surviving / toPreserve 의 첫
 * 메시지가 orphan `tool_result` 가 되지 않도록 idx 를 forward 로 민다.
 *
 * 시나리오: `messages[idx-1]` = `assistant+toolCalls` (drop / compact 쪽),
 *   `messages[idx]` = `tool_result` (preserve / surviving 쪽) — assistant tool_use
 *   가 reduce 됐는데 tool_result 만 history 에 남음 → Anthropic/OpenAI 400
 *   invalid_request (tool_use_id mismatch). 해결: tool_result 가 보이면 계속
 *   forward walk.
 *
 * **Unbounded forward walk**: backward sibling 은 3-step bound 가 있지만 forward
 * 는 안전한 방향이라 bound 없음. 극단적으로 모든 메시지가 `tool_result` 면
 * `messages.length` 반환 — toPreserve 가 빈 배열이 되지만 `[stubMessage]` 만으로
 * 유효한 history. orphan 보다 빈 preserve 가 항상 안전.
 */
function adjustForwardToToolBoundary(messages: GenericMessage[], idx: number): number {
  let cur = idx;
  while (cur < messages.length) {
    const m = messages[cur];
    if (m.role === "tool_result") {
      cur++;
    } else {
      break;
    }
  }
  return cur;
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
