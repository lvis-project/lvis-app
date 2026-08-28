import type {
  ApprovalPurposeSuggestion,
  PermissionReviewRiskLevel,
  PermissionReviewStatus,
} from "../shared/permission-review-status.js";
import type { LLMVendor } from "../shared/llm-vendor-defaults.js";
import type { HostShellExecutionPlanAuditProjection } from "../permissions/host-shell-execution-plan.js";
import type { McpUiPayload } from "../mcp/types.js";
import {
  normalizeSubscriptionUsageTelemetry,
  type SubscriptionUsageTelemetry,
} from "../shared/subscription-runtime.js";
import { isExternalSurfaceInputOrigin } from "../shared/chat-origin.js";
import { t } from "../i18n/index.js";

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




export type CheckpointTrigger = "auto-compact" | "manual";

export const EMPTY_ASSISTANT_RESPONSE_TEXT = t("be_chatStreamState.emptyAssistantResponse");

export type StreamEvent = {
  type: string;
  streamId?: number;
  text?: string;
  /** Host-resolved input provenance carried by `user_message` frames. */
  origin?: string;
  thought?: string;
  name?: string;
  error?: string;
  systemNotice?: "context-error" | "stream-error";
  result?: string;
  isError?: boolean;
  /** Tool call halted by a user stop rather than failing. */
  cancelled?: boolean;
  input?: Record<string, unknown>;
  groupId?: string;
  toolUseId?: string;
  displayOrder?: number;
  reviewStatus?: PermissionReviewStatus;
  toolCategory?: "read" | "write" | "shell" | "network" | "meta";
  source?: "builtin" | "plugin" | "mcp";
  pluginId?: string;
  mcpServerId?: string;
  /** Renderer-safe host shell substrate projection on tool completion. */
  executionPlan?: HostShellExecutionPlanAuditProjection;
  verdictLevel?: PermissionReviewRiskLevel;
  approvalPurpose?: ApprovalPurposeSuggestion;
  roundIndex?: number;
  stopReason?: "end_turn" | "tool_use" | "max_tokens";
  hasToolCalls?: boolean;
  removedMessages?: number;
  freedTokens?: number;
  /** Post-compact actual history token estimate (renderer uses this to
   *  refresh contextOverflowPct immediately; falls back to (lastKnown -
   *  freedTokens) when missing). */
  estimatedAfter?: number;



  triggerSource?: "estimate" | "context-tokens" | "manual" | "force-recover" | "rate-limit";
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



  compactStatus?: "summarized" | "content_truncated" | "noop" | "reduced_insufficient_forced";
  /** Truncation archive directory for original messages (CONTENT_TRUNCATED path). */
  truncatedDir?: string;
  /**
   * `guidance_injected` provenance — present when the whole injected batch was
   * a sub-agent report, so the transcript renders the child-report box rather
   * than the generic queued-message chip.
   */
  subAgentReport?: { title?: string };
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
  uiPayload?: McpUiPayload;
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



  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Provider/model that actually served the turn, after fallback resolution. */
  vendorProvider?: LLMVendor;
  vendorModel?: string;
  /** Per provider request usage segments for request-granular cost math. */
  usageByModel?: TokenUsageSegment[];
  /** Non-billable subscription-runtime usage, kept separate from API pricing. */
  subscriptionUsage?: SubscriptionUsageTelemetry[];
  breakdown?: Record<string, { count: number; ms: number }>;
};

export type ToolEntryItem = {
  toolUseId: string;
  name: string;
  displayOrder: number;
  /**
   * `cancelled` is its own state rather than a flag beside `error` on purpose:
   * every existing `status === "error"` check (badge, row styling, the group's
   * hasError roll-up) then stops matching a user stop for free, instead of each
   * one needing to remember to exclude it.
   */
  status: "running" | "done" | "error" | "cancelled";
  input?: Record<string, unknown>;
  result?: string;
  source?: "builtin" | "plugin" | "mcp";
  category?: "read" | "write" | "shell" | "network" | "meta";
  pluginId?: string;
  mcpServerId?: string;
  /** Renderer-safe host shell substrate projection on tool completion. */
  executionPlan?: HostShellExecutionPlanAuditProjection;
  /** Optional MCP Apps UI payload from MCP tool response. */
  uiPayload?: McpUiPayload;
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
  | {
      kind: "user";
      text: string;
      /**
       * External-surface provenance for a turn the desktop did not submit
       * (loopback API, Tailnet controller, chat-platform bridge). Set only by
       * `applyExternalUserMessage` from the live stream; the bubble itself
       * persists through normal history, the badge is live-stream display
       * state.
       */
      origin?: string;
      /** `sub-agent` is a child's A2A report, not anything the user typed. */
      injectHint?: "queue" | "interrupt" | "sub-agent";
      /** Sanitized child title shown on the sub-agent report box. */
      subAgentTitle?: string;
      createdAt?: number;
    }
  | { kind: "reasoning"; text: string; streaming?: boolean; createdAt?: number }
  | {
      kind: "assistant";
      text: string;
      streaming?: boolean;
      route?: "command";
      phase?: "work" | "final";
      createdAt?: number;
      systemNotice?: "context-error" | "stream-error";
      interrupted?: boolean;
      /**
       * Entry was rebuilt from persisted history rather than produced by the
       * live stream. Stamped ONLY by the disk-replay path (historyToEntries);
       * live streaming callers never set it. The renderer uses it at the
       * single banner render point (AssistantCard) to soften a replayed
       * systemNotice so an old error does not re-present as a fresh one
       * (Issue #2113). Display state only — never persisted.
       */
      restored?: boolean;
    }
  // Permission review verdict for one tool call. The entry is never removed
  // once created — it is the audit trail of what the reviewer decided, and the
  // renderer attaches it to the matching tool row (standalone only while no
  // tool row exists for its toolUseId).
  | {
      kind: "permission_review";
      status: PermissionReviewStatus;
      toolName: string;
      toolCategory?: "read" | "write" | "shell" | "network" | "meta";
      source?: "builtin" | "plugin" | "mcp";
      groupId: string;
      toolUseId: string;
      displayOrder: number;
      createdAt?: number;
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



      compactStatus?: "summarized" | "content_truncated" | "noop" | "reduced_insufficient_forced";
      /** Truncation archive directory for original messages (CONTENT_TRUNCATED path). */
      truncatedDir?: string;
    }
  // Marker placed at the head of a resumed session when a rolling


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

  // trigger session ran in an isolated ConversationLoop; once imported,
  // its prompt enters the main chat loop, but the visible entry is only
  // an input provenance marker. Assistant output, tool groups, and
  // turn_summary entries continue through the normal chat renderer.
  // Rendering the prompt as a user-message bubble would be wrong on two axes:

  //      a synthetic routing prefix misattributes authorship.
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
      /** Non-billable subscription-runtime usage, with its explicit provenance. */
      subscriptionUsage?: SubscriptionUsageTelemetry[];
      /** Per-tool aggregate (`{ count, ms }` per tool name). Omitted when no tools ran. */
      breakdown?: Record<string, { count: number; ms: number }>;
    };

type ReasoningEntry = Extract<ChatEntry, { kind: "reasoning" }>;
type AssistantEntry = Extract<ChatEntry, { kind: "assistant" }>;
type ToolGroupEntry = Extract<ChatEntry, { kind: "tool_group" }>;
type PermissionReviewEntry = Extract<ChatEntry, { kind: "permission_review" }>;

/**
 * Copies only renderer-safe subscription telemetry from an IPC or persisted
 * payload. Individual malformed segments are discarded rather than exposing
 * raw runtime data through the transcript.
 */
export function normalizeSubscriptionUsageList(
  value: unknown,
): SubscriptionUsageTelemetry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.flatMap((segment) => {
    const telemetry = normalizeSubscriptionUsageTelemetry(segment);
    return telemetry ? [telemetry] : [];
  });
  return normalized.length > 0 ? normalized : undefined;
}

function isTurnStartEntry(entry: ChatEntry | undefined): boolean {
  return entry?.kind === "user" || entry?.kind === "imported_trigger";
}

/**
 * The assistant entry of the turn currently at the end of the transcript —
 * the one an abort or an interrupting send cuts short. Walking back from the
 * end, the first assistant entry wins; crossing a turn start first means the
 * current turn has produced no assistant entry yet (a tool round), and the
 * previous turn's answer is not touched.
 */
function currentTurnAssistantIdx(entries: readonly ChatEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.kind === "assistant") return i;
    if (isTurnStartEntry(entry)) return -1;
  }
  return -1;
}

export function markTurnAssistantInterrupted(entries: ChatEntry[]): ChatEntry[] {
  const idx = currentTurnAssistantIdx(entries);
  if (idx < 0) return entries;
  const entry = entries[idx] as AssistantEntry;
  if (entry.interrupted) return entries;
  const next = [...entries];
  // `streaming` is left to the turn's own closing frame; the finalizer finds
  // the entry to close by that flag.
  next[idx] = { ...entry, interrupted: true };
  return next;
}

/** Undo `markTurnAssistantInterrupted` for a send the host then refused. */
export function clearTurnAssistantInterrupted(entries: ChatEntry[]): ChatEntry[] {
  const idx = currentTurnAssistantIdx(entries);
  if (idx < 0) return entries;
  const entry = entries[idx] as AssistantEntry;
  if (!entry.interrupted) return entries;
  const next = [...entries];
  const { interrupted: _interrupted, ...rest } = entry;
  next[idx] = rest;
  return next;
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
 * Apply a `user_message` stream frame — the timeline's record of the input
 * text that started a turn. Every turn emits one regardless of origin ("one
 * stream, two origins"); this is the desktop transcript's single normalization
 * point for it. Turns this surface submitted itself (keyboard, staged, queue,
 * replay, agent wake) are already echoed optimistically at send time, so only
 * turns submitted by an external surface append a row here — with their origin
 * kept for the provenance badge.
 */
export function applyExternalUserMessage(
  entries: ChatEntry[],
  frame: { text?: string; origin?: string },
): ChatEntry[] {
  if (!isExternalSurfaceInputOrigin(frame.origin)) return entries;
  const text = typeof frame.text === "string" ? frame.text : "";
  if (text.length === 0) return entries;
  return [
    ...entries,
    { kind: "user", text, origin: frame.origin, createdAt: Date.now() },
  ];
}

/**
 * Undo the optimistic user bubble when the send it was appended for was REFUSED.
 *
 * The bubble is appended before the IPC resolves so the turn feels immediate. When the
 * send is rejected — a bound exceeded, a gate refusing the origin — main never recorded
 * that turn, so leaving the bubble puts a message in the transcript that exists only in
 * the renderer: it survives until reload, it is not in any session file, and the user
 * has no way to tell it never went.
 *
 * Removes the LAST entry only if it is still the user bubble. Stream frames for a
 * previous turn can land in between, and dropping whatever happens to be last would
 * delete someone else's content.
 */
export function dropOptimisticUserEntry(entries: ChatEntry[], text: string): ChatEntry[] {
  const last = entries[entries.length - 1];
  if (!last || last.kind !== "user" || last.text !== text) return entries;
  return entries.slice(0, -1);
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

  if (assistantIdx >= 0) {
    // Keep what the entry already carries — an interrupted marker set while
    // the stream was still delivering must survive the next delta.
    next[assistantIdx] = { ...(next[assistantIdx] as AssistantEntry), text, streaming: true };
  } else {
    next.push({ kind: "assistant" as const, text, streaming: true });
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
    /**
     * The turn this assistant message belongs to was aborted. Live streaming
     * marks the entry through `markStreamingAssistantInterrupted`; the reload
     * path has no such event and can only learn it from the persisted
     * `SerializedHistoryMessage.interrupted`, so `historyToEntries` passes it
     * here. Before it was consumed the flag was passed and silently dropped,
     * and the "interrupted" badge a user saw live disappeared on reload —
     * a finished-looking turn that had in fact been cut short.
     *
     * Sticky: once an entry carries the marker, a later re-finalize never
     * clears it (an abort is a fact about the turn, not about the render).
     */
    interrupted?: boolean;
    /**
     * Issue #2113 — the entry is being rebuilt from persisted history.
     * Passed ONLY by the disk-replay caller (historyToEntries); live
     * streaming callers never set it, so a live systemNotice banner and a
     * replayed one stay distinguishable at the render point.
     */
    restored?: boolean;
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
      // The turn that owns this entry starts before it and ends where the
      // next one starts — a question the user sent while this turn was still
      // closing is not one of its siblings.
      const turnStartIdx = findLastIdx(next.slice(0, assistantIdx), isTurnStartEntry);
      const nextTurnStartIdx = next.findIndex((e, i) => i > assistantIdx && isTurnStartEntry(e));
      const hasTurnSiblings = next
        .slice(turnStartIdx + 1, nextTurnStartIdx === -1 ? next.length : nextTurnStartIdx)
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
          ...(opts?.interrupted === true || assistant.interrupted === true
            ? { interrupted: true }
            : {}),
          ...(opts?.restored === true || assistant.restored === true
            ? { restored: true }
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
      ...(opts?.interrupted === true || assistant.interrupted === true
        ? { interrupted: true }
        : {}),
      ...(opts?.restored === true || assistant.restored === true
        ? { restored: true }
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
    ...(opts?.interrupted === true ? { interrupted: true } : {}),
    ...(opts?.restored === true ? { restored: true } : {}),
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

  const current = assistantIdx >= 0 ? (next[assistantIdx] as AssistantEntry) : undefined;
  // A turn the user cut short keeps whatever it had delivered — possibly
  // nothing; the closing error is the abort itself, not something to show
  // in its place.
  const interrupted = current?.interrupted === true;
  const baseEntry: AssistantEntry = {
    ...current,
    kind: "assistant" as const,
    text: interrupted ? current?.text ?? "" : message,
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
  const idx = findLastIdx(
    next,
    (candidate): candidate is PermissionReviewEntry =>
      candidate.kind === "permission_review" &&
      candidate.toolUseId === payload.toolUseId,
  );
  const previous = idx >= 0 ? next[idx] : undefined;
  const previousCreatedAt = previous?.kind === "permission_review" ? previous.createdAt : undefined;
  const entry: PermissionReviewEntry = {
    kind: "permission_review",
    status: payload.status,
    toolName: payload.toolName,
    groupId: payload.groupId,
    toolUseId: payload.toolUseId,
    displayOrder: payload.displayOrder ?? 0,
    createdAt: previousCreatedAt ?? Date.now(),
    ...(payload.toolCategory ? { toolCategory: payload.toolCategory } : {}),
    ...(payload.source ? { source: payload.source } : {}),
    ...(payload.verdictLevel ? { verdictLevel: payload.verdictLevel } : {}),
    ...(payload.reason ? { reason: payload.reason } : {}),
    ...(payload.approvalPurpose ? { approvalPurpose: payload.approvalPurpose } : {}),
  };
  if (idx >= 0) {
    next[idx] = entry;
    return next;
  }
  next.push(entry);
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
    /** User stopped the turn mid-call — rendered as halted, not failed. */
    cancelled?: boolean;
    uiPayload?: ToolEntryItem["uiPayload"];
    durationMs?: number;
    source?: "builtin" | "plugin" | "mcp";
    category?: "read" | "write" | "shell" | "network" | "meta";
    pluginId?: string;
    mcpServerId?: string;
    executionPlan?: ToolEntryItem["executionPlan"];
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
      status: (payload.cancelled
        ? "cancelled"
        : payload.isError
          ? "error"
          : "done") as "done" | "error" | "cancelled",
      result: payload.result,
      ...(payload.source ? { source: payload.source } : {}),
      ...(payload.category ? { category: payload.category } : {}),
      ...(payload.pluginId ? { pluginId: payload.pluginId } : {}),
      ...(payload.mcpServerId ? { mcpServerId: payload.mcpServerId } : {}),
      ...(payload.executionPlan !== undefined
        ? { executionPlan: payload.executionPlan }
        : {}),
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
      const record = answer as { choice?: unknown; choices?: unknown; freeText?: unknown };
      const selectedChoices = Array.isArray(record.choices)
        ? record.choices
            .filter((choice): choice is string => typeof choice === "string" && choice.trim().length > 0)
            .map((choice) => choice.trim())
        : [];
      const primaryChoices =
        typeof record.choice === "string" && record.choice.trim().length > 0
          ? [record.choice.trim()]
          : selectedChoices;
      const legacyFreeText =
        typeof record.freeText === "string" && record.freeText.trim().length > 0
          ? [record.freeText.trim()]
          : [];
      const value = [...primaryChoices, ...legacyFreeText].join(", ");
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
  if (!text) return t("be_chatStreamState.answerLabel", { index: String(index + 1) });
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
