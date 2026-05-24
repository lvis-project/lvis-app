import type {
  ApprovalPurposeSuggestion,
  PermissionReviewRiskLevel,
  PermissionReviewStatus,
} from "../shared/permission-review-status.js";
import type { LLMVendor } from "../shared/llm-vendor-defaults.js";

export type TokenUsageSegment = {
  vendorProvider: LLMVendor;
  vendorModel: string;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
};

/**
 * Checkpoint trigger reason on `compact_notice` events.
 * - "auto-compact": token preflight 가 LLM compact 를 실행
 * - "manual":       사용자 명시 trigger (/compact)
 * Mirrors `CheckpointTrigger` in `memory/memory-manager.ts` but kept as a
 * string-literal union here so the renderer side has zero memory layer imports.
 */
export type CheckpointTrigger = "auto-compact" | "manual";

export const EMPTY_ASSISTANT_RESPONSE_TEXT =
  "응답이 비어있습니다. (도구 호출만 있었거나 LLM이 텍스트를 생성하지 않음)";

export type StreamEvent = {
  type: string;
  streamId?: number;
  text?: string;
  thought?: string;
  name?: string;
  error?: string;
  systemNotice?: "context-error" | "stream-error";
  result?: string;
  isError?: boolean;
  input?: Record<string, unknown>;
  groupId?: string;
  toolUseId?: string;
  displayOrder?: number;
  reviewStatus?: PermissionReviewStatus;
  toolCategory?: "read" | "write" | "shell" | "network" | "meta";
  source?: "builtin" | "plugin" | "mcp";
  pluginId?: string;
  mcpServerId?: string;
  verdictLevel?: PermissionReviewRiskLevel;
  approvalPurpose?: ApprovalPurposeSuggestion;
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
  triggerSource?: "estimate" | "context-tokens" | "manual" | "force-recover";
  /**
   * `recovery_exhausted` event — emitted when force-recover budget is fully
   * consumed (#917). Renderer surfaces a persistent banner informing the user
   * that auto-compact can no longer recover the session (compact cannot reduce
   * context) and manual intervention is required (model change / new chat).
   */
  recoveryExhausted?: true;
  estimatedBefore?: number;
  preflight?: number;
  /** Compact trigger on `compact_notice` — token preflight vs manual command. */
  trigger?: CheckpointTrigger;
  /** Rolling summary attached to a compact checkpoint (rendered preamble). */
  summary?: string;
  /** Compact sequence number on `compact_notice` — enables view/branch actions. */
  compactNum?: number;
  /**
   * Compact 결과 분류. Renderer 가 status 별로 다른 banner
   * variant 를 표시 ("summarized" / "content_truncated" / "noop" /
   * "reduced_insufficient_forced"). `compact-status.ts` SOT.
   */
  compactStatus?: "summarized" | "content_truncated" | "noop" | "reduced_insufficient_forced";
  /** Truncation archive directory for original messages (CONTENT_TRUNCATED path). */
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
  /** Optional MCP Apps UI payload emitted with tool_end events. */
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
   * may be 0 in aborted turns. `breakdown` is the optional per-tool
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
   * billing-weight headline + cost calc. Distinct from `tokensIn`, which is
   * the engine-projected next request input SOT.
   */
  freshInputTokens?: number;
  /**
   * Cache breakdown — Anthropic prompt cache (read 90% 할인 / write 25% 가산).
   * Vercel AI SDK v6 가 inputTokens 를 cached 포함 정규화하므로 separately
   * surface.
   */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Provider/model that actually served the turn, after fallback resolution. */
  vendorProvider?: LLMVendor;
  vendorModel?: string;
  /** Per provider request usage segments for request-granular cost math. */
  usageByModel?: TokenUsageSegment[];
  breakdown?: Record<string, { count: number; ms: number }>;
};

export type ToolEntryItem = {
  toolUseId: string;
  name: string;
  displayOrder: number;
  status: "running" | "done" | "error";
  input?: Record<string, unknown>;
  result?: string;
  source?: "builtin" | "plugin" | "mcp";
  category?: "read" | "write" | "shell" | "network" | "meta";
  pluginId?: string;
  mcpServerId?: string;
  /** Optional MCP Apps UI payload from MCP tool response. */
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
  /**
   * Wall-clock timestamp (Date.now()) captured when this tool transitions
   * to "running" via applyToolStart. Read by ToolGroupCard to render a
   * live ticking elapsed counter (`⏱ 0.3s`, `⏱ 1.4s`, ...) while the
   * tool is in flight — so users can tell a long-running call is making
   * progress vs. hung. Cleared by applyToolEnd in favor of `durationMs`.
   */
  startedAt?: number;
};

export type ChatEntry =
  | { kind: "user"; text: string; injectHint?: "queue" | "interrupt"; createdAt?: number }
  | { kind: "reasoning"; text: string; streaming?: boolean; createdAt?: number }
  | { kind: "assistant"; text: string; streaming?: boolean; route?: "command"; phase?: "work" | "final"; createdAt?: number; systemNotice?: "context-error" | "stream-error" }
  | {
      kind: "permission_review";
      status: PermissionReviewStatus;
      toolName: string;
      toolCategory?: "read" | "write" | "shell" | "network" | "meta";
      source?: "builtin" | "plugin" | "mcp";
      groupId: string;
      toolUseId: string;
      displayOrder: number;
      verdictLevel?: PermissionReviewRiskLevel;
      reason?: string;
      approvalPurpose?: ApprovalPurposeSuggestion;
    }
  | { kind: "tool_group"; groupId: string; groupIds: string[]; status: "running" | "done" | "error"; tools: ToolEntryItem[] }
  | {
      kind: "ask_user_answer";
      sourceToolUseId: string;
      dismissed?: boolean;
      rows: Array<{ label: string; value: string }>;
    }
  | { kind: "system"; text: string }
  // Structured compact checkpoint marker. The trigger distinguishes
  // token-preflight compaction from manual `/compact`; sessionId remains
  // unchanged unless the user explicitly branches from the checkpoint.
  | {
      kind: "checkpoint";
      trigger?: CheckpointTrigger;
      removedMessages: number;
      freedTokens: number;
      summary?: string;
      /** Compact sequence number — enables view/branch actions on CheckpointDivider. */
      compactNum?: number;
      /**
       * Compact 결과 분류. CheckpointDivider 가 status 별로
       * 다른 visual variant (색상/아이콘/메시지) 를 표시한다.
       */
      compactStatus?: "summarized" | "content_truncated" | "noop" | "reduced_insufficient_forced";
      /** Truncation archive directory for original messages (CONTENT_TRUNCATED path). */
      truncatedDir?: string;
    }
  // Marker placed at the head of a resumed session when a rolling
  // summaryPreamble is applied. Lets the user see "이전 대화 이어서 시작
  // (요약 N자 적용)" rather than silently inheriting context from the prompt
  // builder. `preambleChars` is the actual character count after the
  // 8 000-char cap; renderer formats the label.
  | {
      kind: "session_resume";
      preambleChars: number;
    }
  // Hidden carrier for post-compact context usage. Unlike turn_summary,
  // this is a compact-result estimate, not provider-reported per-turn billing
  // data. Session replay does not synthesize this carrier.
  | {
      kind: "context_usage";
      tokensIn: number;
      source: "compact-estimate";
    }
  // Overlay trigger that the user accepted ("확인하기"). The
  // trigger session ran in an isolated ConversationLoop; once imported,
  // its prompt enters the main chat loop, but the visible entry is only
  // an input provenance marker. Assistant output, tool groups, and
  // turn_summary entries continue through the normal chat renderer.
  // Rendering the prompt as a user-message bubble would be wrong on two axes:
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
       * when the executor has not yet been instrumented with durationMs; the
       * renderer treats 0 as "per-tool slice unavailable" and elides it
       * from the footer summary line.
       */
      cumulativeToolMs: number;
      /**
       * Turn-end projected context input. TokenProgressRing and the footer use
       * this same value so the user sees one context-fill SOT.
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
      /** Provider/model that actually served the turn, after fallback resolution. */
      vendorProvider?: LLMVendor;
      vendorModel?: string;
      /** Per provider request usage segments for request-granular cost math. */
      usageByModel?: TokenUsageSegment[];
      /** Per-tool aggregate (`{ count, ms }` per tool name). Omitted when no tools ran. */
      breakdown?: Record<string, { count: number; ms: number }>;
    };

type ReasoningEntry = Extract<ChatEntry, { kind: "reasoning" }>;
type AssistantEntry = Extract<ChatEntry, { kind: "assistant" }>;
type ToolGroupEntry = Extract<ChatEntry, { kind: "tool_group" }>;
type PermissionReviewEntry = Extract<ChatEntry, { kind: "permission_review" }>;

function isTurnStartEntry(entry: ChatEntry | undefined): boolean {
  return entry?.kind === "user" || entry?.kind === "imported_trigger";
}

export function appendUserEntry(
  entries: ChatEntry[],
  text: string,
  injectHint?: "queue" | "interrupt",
): ChatEntry[] {
  // Stamp createdAt at construction so the live UI shows the original send
  // time (and the calendar's per-day jump indexer sees the entry) before
  // the next session reload pulls it through historyToEntries.
  // Without this, the engine's ConversationHistory.append() stamp lives on
  // a parallel array the renderer doesn't share — the UI would show no
  // timestamp on fresh turns until the user reopens the session.
  return [
    ...entries,
    { kind: "user", text, createdAt: Date.now(), ...(injectHint ? { injectHint } : {}) },
  ];
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
    },
  ];
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
  opts?: {
    route?: "command";
    phase?: "work" | "final";
    overrideText?: string;
    /**
     * Persisted creation timestamp from disk replay. When supplied, overrides
     * the live `Date.now()` stamp so reloaded sessions show the original turn
     * time. Live streaming callers omit this — the live path stamps Date.now().
     */
    createdAt?: number;
    /**
     * Issue #911 — when the assistant message is a host-emitted system
     * notice (context-error, stream-error), pass the marker through so
     * the renderer can apply destructive styling. Reload path reads this
     * from `SerializedHistoryMessage.systemNotice`; live path emits it
     * from `conversation-loop.ts` when stream.kind === "context_error"
     * / "stream_error".
     */
    systemNotice?: "context-error" | "stream-error";
  },
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
      const lastTurnStartIdx = findLastIdx(next, isTurnStartEntry);
      const hasTurnSiblings = next
        .slice(lastTurnStartIdx + 1)
        .some((e) => e.kind === "tool_group" || e.kind === "checkpoint");
      if (hasTurnSiblings) {
        next[assistantIdx] = {
          ...assistant,
          text: "",
          streaming: false,
          route: opts?.route,
          phase: opts?.phase,
          createdAt: opts?.createdAt ?? assistant.createdAt ?? Date.now(),
          ...(opts?.systemNotice !== undefined
            ? { systemNotice: opts.systemNotice }
            : assistant.systemNotice !== undefined
              ? { systemNotice: assistant.systemNotice }
              : {}),
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
      // Stamp createdAt at first finalization so the live TurnActionBar shows
      // the original turn time — without this the timestamp prop is undefined
      // until the next session reload, defeating the PR's user-visible goal.
      // Preserve existing createdAt on re-finalize (idempotency).
      createdAt: opts?.createdAt ?? assistant.createdAt ?? Date.now(),
      ...(opts?.systemNotice !== undefined
        ? { systemNotice: opts.systemNotice }
        : assistant.systemNotice !== undefined
          ? { systemNotice: assistant.systemNotice }
          : {}),
    };
    return next;
  }

  if (!fallbackText) {
    return next;
  }

  // No streaming assistant in `entries` — this is either the disk-replay
  // path (historyToEntries) or an edge case where the reasoning-only turn
  // produced an assistant out of order. On the replay path, persisted
  // `opts.createdAt` carries the original turn time when available. When
  // the persisted message has NO createdAt (legacy session written before
  // per-message stamping shipped), leave the field undefined — the UI
  // renders nothing rather than fake the load time as the original time
  // (CLAUDE.md "No Fallback Code"). Live callers (which DO want a stamp)
  // reach the streaming-entry branch above, not this push branch.
  next.push({
    kind: "assistant",
    text: fallbackText,
    streaming: false,
    route: opts?.route,
    phase: opts?.phase,
    ...(opts?.createdAt !== undefined ? { createdAt: opts.createdAt } : {}),
    ...(opts?.systemNotice !== undefined ? { systemNotice: opts.systemNotice } : {}),
  });
  return next;
}

export function setAssistantError(
  entries: ChatEntry[],
  message: string,
  fallbackThought: string = "",
  systemNotice?: "context-error" | "stream-error",
): ChatEntry[] {
  // Issue #911 — live error path. When the caller knows the error is a
  // host-emitted system notice (context-error / stream-error), stamp the
  // marker so AssistantCard renders destructive styling immediately,
  // matching what reload sees from jsonl. Without this, the user sees the
  // error first as a normal assistant reply and only gets the red banner
  // after refreshing the session.
  const next = finalizeStreamingReasoning(entries, fallbackThought);
  const assistantIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "assistant" }> =>
      entry.kind === "assistant" && !!entry.streaming,
  );

  const baseEntry = {
    kind: "assistant" as const,
    text: message,
    streaming: false,
    ...(systemNotice !== undefined ? { systemNotice } : {}),
  };

  if (assistantIdx >= 0) {
    next[assistantIdx] = baseEntry;
  } else {
    next.push(baseEntry);
  }
  return next;
}

export function upsertPermissionReview(
  entries: ChatEntry[],
  payload: {
    status: PermissionReviewStatus;
    toolName: string;
    toolCategory?: "read" | "write" | "shell" | "network" | "meta";
    source?: "builtin" | "plugin" | "mcp";
    groupId: string;
    toolUseId: string;
    displayOrder?: number;
    verdictLevel?: PermissionReviewRiskLevel;
    reason?: string;
    approvalPurpose?: ApprovalPurposeSuggestion;
  },
): ChatEntry[] {
  const next = [...entries];
  const entry: PermissionReviewEntry = {
    kind: "permission_review",
    status: payload.status,
    toolName: payload.toolName,
    groupId: payload.groupId,
    toolUseId: payload.toolUseId,
    displayOrder: payload.displayOrder ?? 0,
    ...(payload.toolCategory ? { toolCategory: payload.toolCategory } : {}),
    ...(payload.source ? { source: payload.source } : {}),
    ...(payload.verdictLevel ? { verdictLevel: payload.verdictLevel } : {}),
    ...(payload.reason ? { reason: payload.reason } : {}),
    ...(payload.approvalPurpose ? { approvalPurpose: payload.approvalPurpose } : {}),
  };
  const idx = findLastIdx(
    next,
    (candidate): candidate is PermissionReviewEntry =>
      candidate.kind === "permission_review" &&
      candidate.toolUseId === payload.toolUseId,
  );
  if (idx >= 0) {
    next[idx] = entry;
    return next;
  }
  next.push(entry);
  return next;
}

export function dropPermissionReviewEntries(
  entries: ChatEntry[],
  payload?: { groupId?: string; toolUseId?: string },
): ChatEntry[] {
  if (!payload?.groupId && !payload?.toolUseId) {
    return entries.filter((entry) => entry.kind !== "permission_review");
  }
  return entries.filter((entry) => {
    if (entry.kind !== "permission_review") return true;
    if (payload.toolUseId) return entry.toolUseId !== payload.toolUseId;
    if (payload.groupId && entry.groupId === payload.groupId) return false;
    return true;
  });
}

export function applyToolStart(
  entries: ChatEntry[],
  payload: {
    groupId: string;
    toolUseId: string;
    name: string;
    displayOrder?: number;
    input?: Record<string, unknown>;
    source?: "builtin" | "plugin" | "mcp";
    category?: "read" | "write" | "shell" | "network" | "meta";
    pluginId?: string;
    mcpServerId?: string;
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
    ...(payload.source ? { source: payload.source } : {}),
    ...(payload.category ? { category: payload.category } : {}),
    ...(payload.pluginId ? { pluginId: payload.pluginId } : {}),
    ...(payload.mcpServerId ? { mcpServerId: payload.mcpServerId } : {}),
    startedAt: Date.now(),
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
    source?: "builtin" | "plugin" | "mcp";
    category?: "read" | "write" | "shell" | "network" | "meta";
    pluginId?: string;
    mcpServerId?: string;
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
  const tools = group.tools.map((tool: ToolEntryItem) => {
    if (tool.toolUseId !== payload.toolUseId) return tool;
    const { startedAt: _startedAt, ...rest } = tool;
    return {
      ...rest,
      status: (payload.isError ? "error" : "done") as "done" | "error",
      result: payload.result,
      ...(payload.source ? { source: payload.source } : {}),
      ...(payload.category ? { category: payload.category } : {}),
      ...(payload.pluginId ? { pluginId: payload.pluginId } : {}),
      ...(payload.mcpServerId ? { mcpServerId: payload.mcpServerId } : {}),
      ...(payload.uiPayload && { uiPayload: payload.uiPayload }),
      ...(typeof payload.durationMs === "number" && { durationMs: payload.durationMs }),
    };
  });
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
