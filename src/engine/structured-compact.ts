/**
 * Structured Compact — Layer 2 of `docs/blueprints/infinity-session-redesign-v3.md`.
 *
 * 이 파일은 *interface + parser + prompt* 만 제공. 실제 LLM call wiring 은
 * 후속 sub-slice (PR-2-D) 에서. 호출자가 아직 없으므로 머지 시 행동 변경 0.
 *
 * 핵심 추상화:
 *   - `CompactBoundary` — provider-neutral opaque-state slot (codex CLI v2 회귀 권장)
 *     OpenAI 향후 path 의 `openaiCompactionItem` 전체 저장 + Anthropic/Gemini fallback
 *     `structuredSummary` 양쪽을 단일 인터페이스로 표현.
 *   - `ParsedSummary` — 12-section SUMMARY_TEMPLATE 의 구조화 결과 (OpenCode 7 + GPT-5 prompting 5).
 *   - `freezeBoundary()` — P7 invariant. ⑧ slot + Layer 3 storage + history[0] 3 view 일관 보장.
 *
 * 청사진 §4.3, §5, §7.1 참조.
 */

import type { GenericMessage } from "./llm/types.js";

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
 * P7 invariant — boundary object 와 그 자식 구조를 *deeply freeze*.
 *
 * ⑧ slot + Layer 3 checkpoint storage + history[0] system block — 3 view 가
 * 동일 immutable reference 를 가리키도록 보장. step 9 이후 어떤 view 에서든
 * boundary 가 mutate 되면 race 발생하므로 freeze 로 hard-block.
 */
export function freezeBoundary(boundary: CompactBoundary): Readonly<CompactBoundary> {
  Object.freeze(boundary.structuredSummary.sections);
  Object.freeze(boundary.structuredSummary);
  Object.freeze(boundary.recentVerbatim);
  Object.freeze(boundary.pinnedArtifacts);
  Object.freeze(boundary.toolBoundaryLedger);
  if (boundary.vendorOpaqueState) {
    Object.freeze(boundary.vendorOpaqueState);
  }
  Object.freeze(boundary);
  return boundary;
}
