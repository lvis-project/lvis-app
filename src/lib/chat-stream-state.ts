/**
 * Checkpoint trigger reason on `compact_notice` events.
 * - "auto-compact": Layer 0 preflight 가 Layer 2 compact 를 실행 (post-infinity-session-v3 default)
 * - "manual":       사용자 명시 trigger (/compact)
 * Mirrors `CheckpointTrigger` in `memory/memory-manager.ts` but kept as a
 * string-literal union here so the renderer side has zero memory layer imports.
 */
export type CheckpointTier = "auto-compact" | "manual";

export const EMPTY_ASSISTANT_RESPONSE_TEXT =
  "응답이 비어있습니다. (도구 호출만 있었거나 LLM이 텍스트를 생성하지 않음)";

export type StreamEvent = {
  type: string;
  streamId?: number;
  text?: string;
  thought?: string;
  name?: string;
  error?: string;
  result?: string;
  isError?: boolean;
  input?: Record<string, unknown>;
  groupId?: string;
  toolUseId?: string;
  displayOrder?: number;
  roundIndex?: number;
  stopReason?: "end_turn" | "tool_use";
  hasToolCalls?: boolean;
  removedMessages?: number;
  freedTokens?: number;
  /** Post-compact actual history token estimate (renderer uses this to
   *  refresh contextOverflowPct immediately; falls back to (lastKnown -
   *  freedTokens) when missing). */
  estimatedAfter?: number;
  /**
   * `compact_started` event fields — pre-turn auto-compact in progress.
   * Renderer sets `isCompacting: true` on this event and clears it on
   * `compact_notice` (completion). Allows showing a "자동 압축 중..." indicator
   * during the blocking LLM compaction call.
   */
  triggerSource?: "estimate" | "actual-tokensIn" | "manual";
  estimatedBefore?: number;
  preflight?: number;
  /** Compact trigger tier on `compact_notice` — Layer 0 auto vs manual. */
  tier?: CheckpointTier;
  /** Rolling summary attached to a compact checkpoint (rendered preamble). */
  summary?: string;
  /** §PR-5: compact sequence number on `compact_notice` — enables view/branch actions. */
  compactNum?: number;
  /**
   * Phase 3 — compact 결과 분류. Renderer 가 status 별로 다른 banner
   * variant 를 표시 ("summarized" / "content_truncated" / "noop" /
   * "reduced_insufficient_forced"). `compact-status.ts` SOT.
   */
  compactStatus?: "summarized" | "content_truncated" | "noop" | "reduced_insufficient_forced";
  /** Layer A truncation 으로 격리된 원본 디렉토리 (CONTENT_TRUNCATED 경로). */
  truncatedDir?: string;
  /** Set to "command" on `done` events when the turn was a slash command. */
  route?: "command";
  /** Permission mode changed by slash command; renderer fans this into the badge event bus. */
  mode?: "default" | "strict" | "auto" | "allow";
  /** LLM call status events emitted before first stream content arrives. */
  phase?: "attempt" | "retry" | "fallback";
  label?: string;
  attempt?: number;
  maxAttempts?: number;
  from?: string;
  to?: string;
  reason?: string;
  /** MCP Apps spec §3.2 — optional UI payload emitted with tool_end events. */
  uiPayload?: {
    serverId: string;
    resourceUri: string;
    slot?: "chat" | "sidebar" | "tool-result";
    height?: number;
    title?: string;
  };
  /**
   * Wall-clock execution time of a single tool call (ms). Emitted on
   * `tool_end` for every path (success, error, deny, rate-limit) so the
   * renderer can show per-tool timing on each ToolGroupCard row.
   */
  durationMs?: number;
  /**
   * Turn aggregate footer — emitted as a single `type: "turn_summary"` event
   * after `done`. Carries totals computed in the conversation loop so the
   * renderer never needs to re-aggregate per-tool / per-round numbers.
   * `cumulativeToolMs` is summed from per-tool `durationMs` once available;
   * may be 0 in legacy/aborted turns. `breakdown` is the optional per-tool
   * dictionary used by the expand affordance.
   */
  turnDurationMs?: number;
  toolCount?: number;
  cumulativeToolMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  /**
   * Turn-aggregate fresh input tokens (sum of per-round
   * `inputTokens − cacheRead − cacheWrite`). Used by TokenCostBadge for the
   * billing-weight headline + cost calc. Distinct from `tokensIn` (last
   * round raw, used by TokenProgressRing for context-fill).
   */
  freshInputTokens?: number;
  /**
   * Cache breakdown — Anthropic prompt cache (read 90% 할인 / write 25% 가산).
   * Vercel AI SDK v6 가 inputTokens 를 cached 포함 정규화하므로 separately
   * surface. Reference: Kilo Code session.ts:354.
   */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  breakdown?: Record<string, { count: number; ms: number }>;
};

export type ToolEntryItem = {
  toolUseId: string;
  name: string;
  displayOrder: number;
  status: "running" | "done" | "error";
  input?: Record<string, unknown>;
  result?: string;
  /** MCP Apps spec §3.2 — optional UI payload from MCP tool response. */
  uiPayload?: {
    serverId: string;
    resourceUri: string;
    slot?: "chat" | "sidebar" | "tool-result";
    height?: number;
    title?: string;
  };
  /**
   * Wall-clock execution duration in milliseconds. Set on tool completion
   * (success or error). Used by ToolGroupCard to render `⏱ 1.4s` next to
   * the tool name. Optional because running tools don't yet have a
   * duration; once `status` flips to "done"/"error" this is populated.
   */
  durationMs?: number;
};

export type ChatEntry =
  | { kind: "user"; text: string }
  | { kind: "reasoning"; text: string; streaming?: boolean }
  | { kind: "assistant"; text: string; streaming?: boolean; route?: "command"; phase?: "work" | "final" }
  | { kind: "tool_group"; groupId: string; groupIds: string[]; status: "running" | "done" | "error"; tools: ToolEntryItem[] }
  | {
      kind: "ask_user_answer";
      sourceToolUseId: string;
      dismissed?: boolean;
      rows: Array<{ label: string; value: string }>;
    }
  | { kind: "system"; text: string }
  // Structured replacement for the legacy "💾 이전 N개 대화를 요약했습니다"
  // system bubble. tier 는 Layer 0 auto-compact 또는 manual `/compact`. 기존
  // fork-based revertSessionId 는 PR-2-F-2 에서 폐지 (sessionId 불변).
  | {
      kind: "checkpoint";
      tier?: CheckpointTier;
      removedMessages: number;
      freedTokens: number;
      summary?: string;
      /** §PR-5: compact sequence number — enables view/branch actions on CheckpointDivider. */
      compactNum?: number;
      /**
       * Phase 3 — compact 결과 분류. CheckpointDivider 가 status 별로
       * 다른 visual variant (색상/아이콘/메시지) 를 표시한다.
       */
      compactStatus?: "summarized" | "content_truncated" | "noop" | "reduced_insufficient_forced";
      /** Layer A truncation 으로 격리된 원본 파일 디렉토리 (CONTENT_TRUNCATED 경로). */
      truncatedDir?: string;
    }
  // §457 PR-A: marker placed at the head of a resumed child session's
  // historical entry list when the parent session left a rolling
  // summaryPreamble. Lets the user see "이전 대화 이어서 시작 (요약 N자
  // 적용)" rather than silently inheriting context from the prompt
  // builder. `preambleChars` is the actual character count after the
  // 8 000-char cap; renderer formats the label.
  | {
      kind: "session_resume";
      preambleChars: number;
      parentSessionId?: string;
    }
  // Hidden carrier for session replay context usage. Unlike turn_summary,
  // this is an estimate rebuilt from persisted messages, not provider-reported
  // per-turn billing data.
  | {
      kind: "context_usage";
      tokensIn: number;
      source: "session-estimate";
    }
  // Overlay trigger that the user accepted ("지금 답하기"). The
  // trigger session ran in an isolated ConversationLoop; once imported,
  // its messages live in the chat loop's history (so the LLM has
  // context for the user's next turn) but the renderer collapses the
  // whole interaction into ONE card. Rendering as a user-message
  // bubble would be wrong on two axes:
  //   1. The plugin authored that prompt, not the user — showing "나" /
  //      keyword-routing prefix misattributes authorship.
  //   2. The trigger session is intentionally distinct from chat —
  //      flattening it to user→assistant pair erases the overlay-trigger
  //      provenance the user needs to triage what just happened.
  | {
      kind: "imported_trigger";
      /** Trigger session id (from the isolated loop). */
      sessionId: string;
      /** Origin tag, e.g. "overlay:meeting-detection". */
      source: string;
      /** Plugin-authored templated prompt — shown collapsed by default. */
      prompt: string;
      /** Overlay prompt summary (toast preview). */
      summary: string;
      /** Number of tool calls the trigger session made (0+). */
      toolCallCount: number;
      /** Wall-clock timestamp the import landed. */
      importedAt: string;
      /**
       * Chat LLM's response to the overlay prompt, streamed in after the
       * user clicks 확인하기. Lives inside the imported card so the
       * overlay trigger flow stays visually grouped — separate user/assistant
       * bubbles would scatter the interaction across the chat.
       */
      response?: string;
      /** True while the response is mid-stream. */
      responseStreaming?: boolean;
    }
  // Turn aggregate footer — appended after the final assistant entry of a
  // turn. Carries the totals shown by `TurnSummaryFooter` (step count,
  // wall-clock duration, token usage from the LLM provider, optional
  // per-tool breakdown). Persisted alongside other history entries so the
  // footer survives chat reloads and historical session rendering.
  | {
      kind: "turn_summary";
      turnDurationMs: number;
      toolCount: number;
      /**
       * Cumulative per-tool wall-clock ms summed across the turn. May be 0
       * when the executor has not yet been instrumented with durationMs
       * (companion PR `feat/tool-execution-duration-display`); the
       * renderer treats 0 as "per-tool slice unavailable" and elides it
       * from the footer summary line.
       */
      cumulativeToolMs: number;
      /**
       * Last round's raw input tokens. TokenProgressRing uses this for the
       * context-window fill indicator (cache reads still occupy slots).
       */
      tokensIn: number;
      /**
       * Turn-aggregate fresh input tokens (excludes cache reads/writes).
       * TokenCostBadge uses this for the billing-weight headline and cost
       * calculation. Required at emit time — engine always computes it now.
       */
      freshInputTokens: number;
      tokensOut: number;
      /**
       * Anthropic prompt cache breakdown. Optional — only set when the
       * provider reported non-zero cache read/write for this turn. Required
       * for the AssistantCard cost badge tooltip to show fresh vs cached
       * split + correct billable equivalent.
       */
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      /** Per-tool aggregate (`{ count, ms }` per tool name). Omitted when no tools ran. */
      breakdown?: Record<string, { count: number; ms: number }>;
    };

type ReasoningEntry = Extract<ChatEntry, { kind: "reasoning" }>;
type AssistantEntry = Extract<ChatEntry, { kind: "assistant" }>;
type ToolGroupEntry = Extract<ChatEntry, { kind: "tool_group" }>;

export function appendUserEntry(entries: ChatEntry[], text: string): ChatEntry[] {
  return [...entries, { kind: "user", text }];
}

/**
 * Append the consolidated card for an accepted overlay trigger. Idempotent
 * on `sessionId` so a re-emitted import event (renderer reload, IPC
 * retry) doesn't insert two cards for the same trigger.
 */
export function appendImportedTriggerEntry(
  entries: ChatEntry[],
  payload: {
    sessionId: string;
    source: string;
    prompt: string;
    summary: string;
    toolCallCount: number;
    importedAt: string;
  },
): ChatEntry[] {
  const exists = entries.some(
    (e) => e.kind === "imported_trigger" && e.sessionId === payload.sessionId,
  );
  if (exists) return entries;
  return [
    ...entries,
    {
      kind: "imported_trigger",
      ...payload,
      response: "",
      responseStreaming: true,
    },
  ];
}

/**
 * Find the most recent imported_trigger entry with `responseStreaming`
 * still true. Returns -1 when none. Tool calls and reasoning events
 * may insert child entries AFTER an imported_trigger, so we don't
 * assume "last entry"; instead scan from the tail for the open
 * streaming card.
 */
function findStreamingImportedTriggerIndex(entries: ChatEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e.kind === "imported_trigger" && e.responseStreaming) return i;
  }
  return -1;
}

/**
 * Stream a delta into the open imported_trigger entry's response —
 * keeps the chat LLM's reply inside the imported-trigger card instead of
 * spawning a sibling assistant bubble. No-op when no streaming
 * imported_trigger exists (regular chat turn).
 */
export function appendDeltaToImportedTriggerResponse(
  entries: ChatEntry[],
  delta: string,
): ChatEntry[] {
  const idx = findStreamingImportedTriggerIndex(entries);
  if (idx < 0) return entries;
  const target = entries[idx] as Extract<ChatEntry, { kind: "imported_trigger" }>;
  const next: ChatEntry[] = [...entries];
  next[idx] = { ...target, response: (target.response ?? "") + delta };
  return next;
}

/** Mark the imported_trigger response as no longer streaming (server "done"). */
export function finalizeImportedTriggerResponse(
  entries: ChatEntry[],
  transformResponse?: (response: string) => string,
): ChatEntry[] {
  const idx = findStreamingImportedTriggerIndex(entries);
  if (idx < 0) return entries;
  const target = entries[idx] as Extract<ChatEntry, { kind: "imported_trigger" }>;
  const next: ChatEntry[] = [...entries];
  const response = target.response ?? "";
  next[idx] = {
    ...target,
    response: transformResponse && response ? transformResponse(response) : target.response,
    responseStreaming: false,
  };
  return next;
}

/** True while a streaming imported_trigger card is open (text deltas redirect into it). */
export function isImportedTriggerStreaming(entries: ChatEntry[]): boolean {
  return findStreamingImportedTriggerIndex(entries) >= 0;
}

export function upsertStreamingReasoning(
  entries: ChatEntry[],
  text: string,
): ChatEntry[] {
  if (!text) {
    return entries;
  }

  const next = [...entries];
  const reasoningIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "reasoning" }> =>
      entry.kind === "reasoning" && !!entry.streaming,
  );

  const reasoning = { kind: "reasoning" as const, text, streaming: true };
  if (reasoningIdx >= 0) {
    next[reasoningIdx] = reasoning;
    return next;
  }

  const assistantIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "assistant" }> =>
      entry.kind === "assistant" && !!entry.streaming,
  );
  if (assistantIdx >= 0) {
    next.splice(assistantIdx, 0, reasoning);
  } else {
    next.push(reasoning);
  }
  return next;
}

export function upsertStreamingAssistant(
  entries: ChatEntry[],
  text: string,
): ChatEntry[] {
  if (!text) {
    return entries;
  }

  const next = [...entries];
  const assistantIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "assistant" }> =>
      entry.kind === "assistant" && !!entry.streaming,
  );

  const assistant = { kind: "assistant" as const, text, streaming: true };
  if (assistantIdx >= 0) {
    next[assistantIdx] = assistant;
  } else {
    next.push(assistant);
  }
  return next;
}

export function finalizeStreamingReasoning(
  entries: ChatEntry[],
  fallbackText: string,
): ChatEntry[] {
  const next = [...entries];
  const reasoningIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "reasoning" }> =>
      entry.kind === "reasoning" && !!entry.streaming,
  );

  if (reasoningIdx >= 0) {
    const reasoning = next[reasoningIdx] as ReasoningEntry;
    const text = reasoning.text || fallbackText;
    if (!text) {
      next.splice(reasoningIdx, 1);
      return next;
    }
    next[reasoningIdx] = {
      ...reasoning,
      text,
      streaming: false,
    };
    return next;
  }

  if (!fallbackText) {
    return next;
  }

  const reasoning = {
    kind: "reasoning" as const,
    text: fallbackText,
    streaming: false,
  };
  const assistantIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "assistant" }> =>
      entry.kind === "assistant" && !!entry.streaming,
  );
  if (assistantIdx >= 0) {
    next.splice(assistantIdx, 0, reasoning);
  } else {
    next.push(reasoning);
  }
  return next;
}

export function finalizeStreamingAssistant(
  entries: ChatEntry[],
  fallbackText: string,
  opts?: { route?: "command"; phase?: "work" | "final"; overrideText?: string },
): ChatEntry[] {
  const next = [...entries];
  const assistantIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "assistant" }> =>
      entry.kind === "assistant" && !!entry.streaming,
  );

  if (assistantIdx >= 0) {
    const assistant = next[assistantIdx] as AssistantEntry;
    const text = opts?.overrideText !== undefined ? opts.overrideText : assistant.text || fallbackText;
    if (!text) {
      // Preserve the entry (with empty text) when this turn produced
      // tool_group or checkpoint siblings — those cards already render the
      // turn's content and the entry must stay so the history timeline is
      // intact.  Only splice when the entry is truly orphaned (no siblings
      // in the current turn).
      const lastUserIdx = findLastIdx(next, (e) => e.kind === "user");
      const hasTurnSiblings = next
        .slice(lastUserIdx + 1)
        .some((e) => e.kind === "tool_group" || e.kind === "checkpoint");
      if (hasTurnSiblings) {
        next[assistantIdx] = {
          ...assistant,
          text: "",
          streaming: false,
          route: opts?.route,
          phase: opts?.phase,
        };
        return next;
      }
      next.splice(assistantIdx, 1);
      return next;
    }
    next[assistantIdx] = {
      ...assistant,
      text,
      streaming: false,
      // Always write the `route` field (even as `undefined`) so that stale
      // route values set during streaming intermediate state are explicitly
      // cleared rather than preserved via the spread. Each finalize call is
      // a complete state transition — there is no valid case where a
      // finalized entry should inherit a streaming-era route.
      route: opts?.route,
      phase: opts?.phase,
    };
    return next;
  }

  if (!fallbackText) {
    return next;
  }

  next.push({
    kind: "assistant",
    text: fallbackText,
    streaming: false,
    route: opts?.route,
    phase: opts?.phase,
  });
  return next;
}

export function setAssistantError(entries: ChatEntry[], message: string, fallbackThought: string = ""): ChatEntry[] {
  const next = finalizeStreamingReasoning(entries, fallbackThought);
  const assistantIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "assistant" }> =>
      entry.kind === "assistant" && !!entry.streaming,
  );

  if (assistantIdx >= 0) {
    next[assistantIdx] = { kind: "assistant", text: message, streaming: false };
  } else {
    next.push({ kind: "assistant", text: message, streaming: false });
  }
  return next;
}

export function applyToolStart(
  entries: ChatEntry[],
  payload: {
    groupId: string;
    toolUseId: string;
    name: string;
    displayOrder?: number;
    input?: Record<string, unknown>;
  },
): ChatEntry[] {
  const next = [...entries];
  let groupIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "tool_group" }> =>
      entry.kind === "tool_group" && entry.groupIds.includes(payload.groupId),
  );
  const adjacentGroupIdx = getAdjacentToolGroupIndex(next);

  const tool: ToolEntryItem = {
    toolUseId: payload.toolUseId,
    name: payload.name,
    displayOrder: payload.displayOrder ?? 0,
    status: "running",
    input: payload.input,
  };

  if (groupIdx >= 0) {
    const group = next[groupIdx] as ToolGroupEntry;
    const toolIdx = group.tools.findIndex((entry: ToolEntryItem) => entry.toolUseId === payload.toolUseId);
    const tools =
      toolIdx >= 0
        ? group.tools.map((entry: ToolEntryItem, index: number) => (index === toolIdx ? tool : entry))
        : [...group.tools, tool];

    next[groupIdx] = { ...group, status: "running", tools };
    return next;
  }

  if (adjacentGroupIdx >= 0) {
    const group = next[adjacentGroupIdx] as ToolGroupEntry;
    const groupIds = group.groupIds.includes(payload.groupId)
      ? group.groupIds
      : [...group.groupIds, payload.groupId];
    next[adjacentGroupIdx] = {
      ...group,
      groupIds,
      status: "running",
      tools: [...group.tools, tool],
    };
    return next;
  }

  const newGroup: ToolGroupEntry = {
    kind: "tool_group",
    groupId: payload.groupId,
    groupIds: [payload.groupId],
    status: "running",
    tools: [tool],
  };

  next.push(newGroup);
  return next;
}

export function applyToolEnd(
  entries: ChatEntry[],
  payload: {
    groupId: string;
    toolUseId: string;
    result?: string;
    isError?: boolean;
    uiPayload?: ToolEntryItem["uiPayload"];
    durationMs?: number;
  },
): ChatEntry[] {
  const next = [...entries];
  const groupIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "tool_group" }> =>
      entry.kind === "tool_group" && entry.groupIds.includes(payload.groupId),
  );
  if (groupIdx < 0) {
    return entries;
  }

  const group = next[groupIdx] as ToolGroupEntry;
  const tools = group.tools.map((tool: ToolEntryItem) =>
    tool.toolUseId === payload.toolUseId
      ? {
          ...tool,
          status: (payload.isError ? "error" : "done") as "done" | "error",
          result: payload.result,
          ...(payload.uiPayload && { uiPayload: payload.uiPayload }),
          ...(typeof payload.durationMs === "number" && { durationMs: payload.durationMs }),
        }
      : tool,
  );
  const completedTool = tools.find((tool: ToolEntryItem) => tool.toolUseId === payload.toolUseId);
  const stillRunning = tools.some((tool: ToolEntryItem) => tool.status === "running");
  next[groupIdx] = { ...group, status: stillRunning ? "running" : "done", tools };
  const answerEntry = completedTool ? askUserAnswerEntryFromTool(completedTool) : null;
  if (answerEntry && !next.some((entry) => entry.kind === "ask_user_answer" && entry.sourceToolUseId === answerEntry.sourceToolUseId)) {
    next.push(answerEntry);
  }
  return next;
}

function askUserAnswerEntryFromTool(
  tool: ToolEntryItem,
): Extract<ChatEntry, { kind: "ask_user_answer" }> | null {
  if (tool.name !== "ask_user_question") return null;
  if (!tool.result) return null;

  const parsed = safeJsonParse(tool.result);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const result = parsed as { answers?: unknown; dismissed?: unknown };
  if (result.dismissed === true) {
    return {
      kind: "ask_user_answer",
      sourceToolUseId: tool.toolUseId,
      dismissed: true,
      rows: [],
    };
  }
  if (!Array.isArray(result.answers)) return null;

  const questions = extractAskQuestions(tool.input);
  const rows = result.answers
    .map((answer, index) => {
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
      const record = answer as { choice?: unknown; freeText?: unknown };
      const value =
        typeof record.choice === "string" && record.choice.trim().length > 0
          ? record.choice.trim()
          : typeof record.freeText === "string" && record.freeText.trim().length > 0
            ? record.freeText.trim()
            : "";
      if (!value) return null;
      return {
        label: answerLabel(questions[index], index),
        value,
      };
    })
    .filter((row): row is { label: string; value: string } => row !== null);

  if (rows.length === 0) return null;
  return {
    kind: "ask_user_answer",
    sourceToolUseId: tool.toolUseId,
    rows,
  };
}

function extractAskQuestions(input: ToolEntryItem["input"]): Array<{ question?: string; summaryHint?: string }> {
  const raw = input?.questions;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return {};
    const record = item as { question?: unknown; summaryHint?: unknown };
    return {
      question: typeof record.question === "string" ? record.question : undefined,
      summaryHint: typeof record.summaryHint === "string" ? record.summaryHint : undefined,
    };
  });
}

function answerLabel(question: { question?: string; summaryHint?: string } | undefined, index: number): string {
  const hint = question?.summaryHint?.trim();
  if (hint) return hint;
  const text = question?.question?.trim();
  if (!text) return `답변 ${index + 1}`;
  return text.length <= 14 ? text : `${text.slice(0, 13)}…`;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function findLastIdx<T>(items: T[], predicate: (value: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) {
      return index;
    }
  }
  return -1;
}

function getAdjacentToolGroupIndex(entries: ChatEntry[]): number {
  if (entries[entries.length - 1]?.kind === "tool_group") {
    return entries.length - 1;
  }
  return -1;
}
