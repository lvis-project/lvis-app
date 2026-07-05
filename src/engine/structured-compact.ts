




import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { GenericMessage, LLMProvider, StreamEvent } from "./llm/types.js";
import { serializeMessageForEstimation, userContentText } from "./llm/types.js";
import { estimateTokens, estimateMessagesTokens } from "./auto-compact.js";
import { lvisHome } from "../shared/lvis-home.js";
import { createLogger } from "../lib/logger.js";
import {
  CompressionStatus,
  TRUNCATION_THRESHOLD_TOKENS,
  TRUNCATION_PRESERVED_LINES,
} from "../shared/compact-status.js";
import { t } from "../i18n/index.js";

const log = createLogger("compact");


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




export interface ParsedSummary {
  templateVersion: 1;
  sections: Partial<Record<SummarySectionName, string>>;

  raw?: string;
}




export interface CompactBoundary {
  templateVersion: 1;

  vendorOpaqueState?: VendorOpaqueState;
  structuredSummary: ParsedSummary;
  recentVerbatim: GenericMessage[];
  pinnedArtifacts: string[];
  toolBoundaryLedger: ToolCallSummary[];

  createdAt: string;

  compactNum: number;
}

export type VendorOpaqueState =
  | { vendor: "openai"; openaiCompactionItem: OpenAICompactionItem }

  ;




export interface OpenAICompactionItem {
  type: "compaction";
  encrypted_content: string;

  [k: string]: unknown;
}




export interface ToolCallSummary {
  round: number;
  toolName: string;

  resultSummary: string;
  isError?: boolean;
}




export const SUMMARY_TEMPLATE_PROMPT_V1: string = t("be_structuredCompact.summaryTemplatePrompt");




export function parseSummary(text: string): ParsedSummary {
  const sections: Partial<Record<SummarySectionName, string>> = {};



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




export function freezeBoundary(boundary: CompactBoundary): Readonly<CompactBoundary> {
  deepFreeze(boundary);
  return boundary;
}

// ─── compactWithBoundary (LLM call) ─────────────────────


const BOUNDARY_STUB_TEMPLATE = (n: number): string =>
  t("be_structuredCompact.boundaryStub", { n: String(n) });


const MAX_PARSE_RETRY = 1;


const TOOL_BOUNDARY_LEDGER_K = 5;


const LEDGER_RESULT_MAX = 200;

/** Recent user turns that must survive compaction verbatim. */
export const DEFAULT_PRESERVE_RECENT_TURNS = 5;

export interface CompactWithBoundaryArgs {
  messages: GenericMessage[];
  llm: LLMProvider;
  model: string;

  preserveRecentTokens: number;
  /**
   * Minimum number of recent user turns to keep verbatim regardless of the token
   * ceiling. If compaction runs immediately after a new user question is
   * appended, that pending question is preserved in addition to the previous
   * completed turns.
   */
  preserveRecentTurns?: number;
  compactNum: number;



  sessionId: string;



  preflightTokens: number;
  abortSignal?: AbortSignal;
}

export interface CompactWithBoundaryResult {



  status: CompressionStatus;

  boundary: Readonly<CompactBoundary> | null;
  newHistory: GenericMessage[];

  removedCount: number;

  estimatedAfter: number;

  truncatedDir?: string;

  truncatedCount: number;
}




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
 *   - History-wide reverse-budget truncation: oldest messages
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
 * History-wide reverse-budget truncation.
 *
 * After `splitForBoundary` produces `toCompact`, this pass guarantees
 * `toCompact` fits into the LLM's input budget before the summary call.
 * Walks from oldest forward, dropping messages until the cumulative token
 * count is under `budget`. Dropped messages are archived to disk so users
 * can recover originals if needed.
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
  // If a single message is genuinely huge, per-message truncation
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
 * Structured compact with LLM call + opaque-state slot.
 *
 * 알고리즘:
 *   1. preserveRecentTokens + preserveRecentTurns 로 split (toCompact / toPreserve), tool_use/tool_result 무결성 보존
 *   2. SUMMARY_TEMPLATE_PROMPT_V1 LLM call — 동일 vendor 동급 모델
 *   3. parseSummary (실패 시 1회 재시도, 그래도 실패 시 raw fallback)
 *   4. pinnedArtifacts 수집 (skill / lock=true)
 *   5. toolBoundaryLedger 생성 (마지막 K 라운드)
 *   6. CompactBoundary assemble + freezeBoundary
 *   7. newHistory = [stub user message + boundary meta, ...toPreserve]
 *
 * 호출자 는 step 7 결과로 `history.restore()` + `setSummaryPreamble(renderBoundaryAsPreamble(boundary))`
 * 를 *동기* 순서로 실행해야 summary slot 정합성 보장.
 */
export async function compactWithBoundary(
  args: CompactWithBoundaryArgs,
): Promise<CompactWithBoundaryResult> {
  const {
    messages,
    llm,
    model,
    preserveRecentTokens,
    preserveRecentTurns = DEFAULT_PRESERVE_RECENT_TURNS,
    compactNum,
    sessionId,
    preflightTokens,
    abortSignal,
  } = args;

  // 0. Per-message truncation pre-pass.
  //    단일 거대 메시지 (>30K tokens) 가 LLM input context 초과하는 케이스 방지.
  const { messages: workingMessages, truncatedCount, truncatedDir: perMessageTruncDir } =
    await truncateOversizeMessages(messages, sessionId, compactNum);

  // 1. Split — token budget plus protected recent user-turn floor, tool 페어 안전.
  const { toCompact, toPreserve, protectedPreserveCount } = splitForBoundary(
    workingMessages,
    preserveRecentTokens,
    preserveRecentTurns,
  );

  if (toCompact.length === 0) {
    if (truncatedCount > 0) {
      // CONTENT_TRUNCATED — per-message truncation 만으로 충분히 reduce (LLM 호출 skip).
      const estimatedAfter = estimateMessagesTokens(workingMessages);
      log.info(`compact: status=content_truncated truncated=${truncatedCount} estimatedAfter=${estimatedAfter} compactNum=${compactNum}`);
      return {
        status: CompressionStatus.CONTENT_TRUNCATED,
        boundary: null,
        newHistory: workingMessages,
        removedCount: truncatedCount,
        estimatedAfter,
        truncatedDir: perMessageTruncDir,
        truncatedCount,
      };
    }
    // NOOP — history 가 충분히 작음. 정상 small-history 경로.
    const noopEstimatedAfter = estimateMessagesTokens(messages);
    log.info(`compact: status=noop estimatedAfter=${noopEstimatedAfter} compactNum=${compactNum}`);
    return {
      status: CompressionStatus.NOOP,
      boundary: null,
      newHistory: messages,
      removedCount: 0,
      estimatedAfter: noopEstimatedAfter,
      truncatedCount: 0,
    };
  }

  // 1a. History-wide reverse-budget truncation.
  //     Per-message truncation handles ONE huge
  //     message, but many medium messages (예: 200 × 1K tokens) summing
  //     to > preflight will still overflow the LLM input context. Drop
  //     oldest from `toCompact` (archive to disk) until total <= 90% preflight.
  const llmInputBudget = preflightTokens > 0 ? Math.floor(preflightTokens * 0.9) : Infinity;
  const reverseBudgetResult = await dropOldestUntilUnderBudget(
    toCompact,
    llmInputBudget,
    sessionId,
    compactNum,
  );
  const finalToCompact = reverseBudgetResult.messages;
  const reverseBudgetDir = reverseBudgetResult.truncatedDir;
  const totalTruncatedCount = truncatedCount + reverseBudgetResult.droppedCount;

  // 2-3. LLM call + parse with retry-once.
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
  //     (reverse-budget archive 이후 LLM 에 실제로 들어간 메시지들).
  const pinnedArtifacts = collectPinned(finalToCompact);
  const toolBoundaryLedger = makeToolLedger(finalToCompact, TOOL_BOUNDARY_LEDGER_K);

  // 6. Build + freeze boundary (동일 reference 보장).
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
  // `createdAt` parsed from the boundary ISO string so the renderer can place
  // the boundary on the calendar's day index after reload. `checkpointMeta`
  // is the renderer-facing summary the historyToEntries reconstruction
  // consumes to rebuild a `kind: "checkpoint"` divider on session reload —
  // without this the boundary would render as a raw user bubble showing the
  // stub template text. `freedTokens` here is the pre→post compact delta of
  // the messages that the LLM summarized; the conversation-loop's
  // onCompactOccurred emits the same number for the live UI path.
  const stubEstimatedAfter = estimateMessagesTokens([
    { role: "user" as const, content: BOUNDARY_STUB_TEMPLATE(compactNum) },
  ]);
  const stubFreedTokens = Math.max(
    0,
    estimateMessagesTokens(finalToCompact) - stubEstimatedAfter,
  );
  const stubRemovedMessages = finalToCompact.length + reverseBudgetResult.droppedCount;
  // Hoist the ISO→epoch conversion so the persisted `meta.createdAt` and the
  // in-memory `meta.compactedAt` are derived from the same parse — avoids
  // double-parsing the ISO string at construction time.
  const boundaryCreatedAtMs = new Date(boundary.createdAt).getTime();
  const stubMessage: GenericMessage = {
    role: "user",
    content: BOUNDARY_STUB_TEMPLATE(compactNum),
    meta: {
      compactBoundary: true,
      compactNum,
      removedCount: stubRemovedMessages,
      compactedAt: boundary.createdAt,
      boundary,
      createdAt: boundaryCreatedAtMs,
      checkpointMeta: {
        removedMessages: stubRemovedMessages,
        freedTokens: stubFreedTokens,
        compactNum,
        trigger: "auto-compact",
        ...(summary.raw ? { summary: summary.raw.slice(0, 200) } : {}),
      },
    },
  };
  let newHistory: GenericMessage[] = [stubMessage, ...toPreserve];
  let estimatedAfter = estimateMessagesTokens(newHistory);

  // 7a. REDUCED_INSUFFICIENT_FORCED — post-compact 이 preflight × 0.8 초과.
  //     last-resort 로 toPreserve 의 oldest 50% 를 강제 drop 하되, 최근
  //     preserveRecentTurns user turn 은 보호한다. **사용자 contract "원본 보존"
  //     충족 위해 dropped slice 도 archive 파일로 격리.**
  const forcedDropCap = Math.max(0, toPreserve.length - protectedPreserveCount);
  if (preflightTokens > 0 && estimatedAfter > preflightTokens * 0.8 && forcedDropCap > 0) {
    const rawDropCount = Math.min(Math.ceil(toPreserve.length / 2), forcedDropCap);
    // Tool-pair safety: surviving 의 첫 메시지가 orphan tool_result 가 되지
    // 않도록 dropCount 를 앞으로 민다. 그렇지 않으면 provider 가 400
    // (tool_use_id 미스매치) 으로 거부 — 원래 C1 deadlock fix 의도 회귀.
    const boundarySafeDropCount = adjustForwardToToolBoundary(toPreserve, rawDropCount);
    const protectedSafeDropCount = boundarySafeDropCount <= forcedDropCap ? boundarySafeDropCount : 0;
    const dropCount = clampDropBeforeLatestRenderableUser(toPreserve, protectedSafeDropCount);
    if (dropCount > 0) {
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
      const finalTruncDir = forcedArchiveDir || reverseBudgetDir || perMessageTruncDir || "";
      const finalTruncCount = totalTruncatedCount + dropCount;
      const forcedRemoved = finalToCompact.length + reverseBudgetResult.droppedCount + dropCount;
      log.warn(`compact: status=reduced_insufficient_forced removed=${forcedRemoved} truncated=${finalTruncCount} estimatedAfter=${estimatedAfter} preflight=${preflightTokens} compactNum=${compactNum}`);
      return {
        status: CompressionStatus.REDUCED_INSUFFICIENT_FORCED,
        boundary,
        newHistory,
        removedCount: forcedRemoved,
        estimatedAfter,
        truncatedCount: finalTruncCount,
        ...(finalTruncDir !== "" ? { truncatedDir: finalTruncDir } : {}),
      };
    }
    log.warn(`compact: forced-drop skipped to preserve last ${preserveRecentTurns} turn(s) and latest user message (estimatedAfter=${estimatedAfter} preflight=${preflightTokens} compactNum=${compactNum})`);
  }

  // SUMMARIZED — 정상 경로. CONTENT_TRUNCATED 는 위쪽 early-return 에서 이미
  // 처리됐고 (toCompact.length === 0 분기), dropOldestUntilUnderBudget 는
  // surviving.length > 1 invariant 를 유지하므로 여기 도달 시 finalToCompact 가
  // 비어있을 가능성 없음.
  const summarizedTruncDir = reverseBudgetDir || perMessageTruncDir || "";
  const summarizedRemoved = finalToCompact.length + reverseBudgetResult.droppedCount;
  log.info(`compact: status=summarized removed=${summarizedRemoved} truncated=${totalTruncatedCount} estimatedAfter=${estimatedAfter} compactNum=${compactNum}`);
  return {
    status: CompressionStatus.SUMMARIZED,
    boundary,
    newHistory,
    removedCount: summarizedRemoved,
    estimatedAfter,
    truncatedCount: totalTruncatedCount,
    ...(summarizedTruncDir !== "" ? { truncatedDir: summarizedTruncDir } : {}),
  };
}

/**
 * CompactBoundary → system prompt ⑧ slot preamble 텍스트 변환.
 *
 * Anthropic / Gemini 는 이 텍스트가 system prompt 안 `<prior-context-summary>` fence
 * 안에 들어감 (`system-prompt-builder.ts:447-453`) — prompt-injection vector 차단.
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
 * Token-aware split — 끝에서부터 preserveRecentTokens 까지 보존하되, 최근
 * preserveRecentTurns user turn 은 반드시 보존하고 나머지는 compact.
 *
 * Contract (compact 가 어떤 input 에도 reduce 보장하기 위한 의미):
 *   - preserveRecentTokens 는 **ceiling** — preserve 영역의 누적 토큰이 이 값을
 *     초과하면 더 이상 메시지를 포함시키지 않는다.
 *   - 단일 메시지가 preserveRecentTokens 를 단독으로 초과하면 preserve 는 빈
 *     배열이 되고 그 메시지를 포함한 전체가 compact 대상이 된다.
 *   - 단, 최근 user turn floor 는 token ceiling 보다 우선한다. 마지막 메시지가
 *     pending user question 이면 그 질문은 이전 5 completed turns 에 더해 보존한다.
 *   - tool_use/tool_result 페어가 boundary 에 의해 갈리는 경우
 *     `adjustToToolBoundary` 가 최대 3 step backward walk 하여 페어를 같은
 *     쪽으로 정렬한다. 더 깊은 tool chain 이면 partial-pair 허용 (LLM summary
 *     의 raw fallback 이 처리).
 */
function splitForBoundary(
  messages: GenericMessage[],
  preserveRecentTokens: number,
  preserveRecentTurns = DEFAULT_PRESERVE_RECENT_TURNS,
): { toCompact: GenericMessage[]; toPreserve: GenericMessage[]; protectedPreserveCount: number } {
  if (messages.length === 0) {
    return { toCompact: [], toPreserve: [], protectedPreserveCount: 0 };
  }
  const turnPreserveStart = findRecentTurnPreserveStart(messages, preserveRecentTurns);
  const protectedPreserveCount =
    turnPreserveStart < messages.length ? messages.length - turnPreserveStart : 0;
  if (preserveRecentTokens <= 0 && turnPreserveStart >= messages.length) {
    return { toCompact: messages, toPreserve: [], protectedPreserveCount: 0 };
  }
  let preserveStart = messages.length;
  let preservedTokens = 0;
  if (preserveRecentTokens > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = estimateTokens(serializeMessageForEstimation(messages[i]));
      if (preservedTokens + msgTokens > preserveRecentTokens) break;
      preservedTokens += msgTokens;
      preserveStart = i;
    }
  }
  preserveStart = Math.min(preserveStart, turnPreserveStart);
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
    protectedPreserveCount,
  };
}

function findRecentTurnPreserveStart(messages: GenericMessage[], preserveRecentTurns: number): number {
  const keepCompletedTurns = Math.max(0, Math.floor(preserveRecentTurns));
  if (keepCompletedTurns === 0) return messages.length;

  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "user" && msg.meta?.compactBoundary !== true) {
      userIndices.push(i);
    }
  }
  if (userIndices.length === 0) return messages.length;

  const last = messages[messages.length - 1];
  const trailingPendingUser = last.role === "user" && last.meta?.compactBoundary !== true;
  const turnsToKeep = keepCompletedTurns + (trailingPendingUser ? 1 : 0);
  const startIndex = Math.max(0, userIndices.length - turnsToKeep);
  return userIndices[startIndex] ?? messages.length;
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
 * 생성 가능 (raw fallback 과 동일 원리).
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

function clampDropBeforeLatestRenderableUser(messages: GenericMessage[], dropCount: number): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "user" && message.meta?.compactBoundary !== true) {
      return Math.min(dropCount, i);
    }
  }
  return dropCount;
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

/** SUMMARY_TEMPLATE LLM 호출. 동일 vendor 동급 모델. */
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
    systemPrompt: t("be_structuredCompact.callSummarySystemPrompt"),
    messages: [{ role: "user", content: filledPrompt }],
    tools: [],
    ...(args.abortSignal !== undefined && { abortSignal: args.abortSignal }),
  }) as AsyncIterable<StreamEvent>) {
    if (args.abortSignal?.aborted) {
      throw new Error("LLM compact aborted by signal");
    }
    if (ev.type === "text_delta" && ev.text) {
      text += ev.text;
    } else if (ev.type === "message_complete") {
      break;
    } else if (ev.type === "error") {
      throw new Error(`LLM compact error: ${ev.error}`);
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

/** 마지막 K 라운드 tool_use/tool_result 쌍을 ledger 로 저장. */
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
