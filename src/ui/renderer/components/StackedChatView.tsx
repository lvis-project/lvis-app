/**
 * StackedChatView — PR-5 Phase 2 (feature flag: experimentalStackedChat).
 *
 * Kakao-style continuous message stream:
 * - Day separator between calendar-day boundaries.
 * - Inline checkpoint divider + summary toast after each compaction.
 * - Historical sessions (loaded from disk) rendered above active session.
 * - Active session entries ALWAYS rendered at the bottom (live streaming).
 * - Reverse infinite scroll: scroll to top → prefetches previous day.
 * - Input bar delegates to existing InputActionBar + Composer.
 */
import { Fragment, useRef, useEffect, useMemo } from "react";
import { flushSync } from "react-dom";
import type { LvisApi } from "../types.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import type { StackedSession } from "../hooks/use-stacked-chat.js";
import { InputActionBar } from "./InputActionBar.js";
import { Composer, type ComposerHandle } from "./Composer.js";
import { AssistantCard } from "./AssistantCard.js";
import { TurnActionBar } from "./TurnActionBar.js";
import { ToolGroupCard } from "./ToolGroupCard.js";
import { ReasoningCard } from "./ReasoningCard.js";
import { WorkGroup } from "./WorkGroup.js";
import { ImportedTriggerCard } from "./ImportedTriggerCard.js";
import { SessionTodoPanel } from "./SessionTodoPanel.js";
import { getApi } from "../api-client.js";
import { useChatContext } from "../context/ChatContext.js";
import { buildMarkerText } from "../utils/attachment-markers.js";
import { ATTACH_MAX_COUNT, DENY_EXTENSIONS, type Attachment } from "../types/attachments.js";
import type { PluginEntry } from "./PluginGridButton.js";
import type { QuickAction } from "./CommandPopover.js";

export interface StackedChatViewProps {
  /** Historical sessions (oldest → newest), loaded by useStackedChat — excludes current active */
  historicalSessions: StackedSession[];
  /** Current (active) session id */
  currentSessionId: string;
  /** Current session entries from useChatState */
  entries: ChatEntry[];
  /** True when streaming is in progress */
  streaming: boolean;
  /** Send question to active session */
  onAsk: (q: string) => void | Promise<void>;
  /** Guide hint during streaming */
  onGuide: (q: string) => void | Promise<void>;
  /** Abort current turn */
  onAbort: () => void | Promise<void>;
  /** True while initial/prefetch load */
  loading: boolean;
  /** True when no more historical days available */
  reachedEnd: boolean;
  /** Ref for top-sentinel element (IntersectionObserver target) */
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  /** Ref for the outer scroll container */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  /** Plugin list for InputActionBar */
  plugins: PluginEntry[];
  onSelectPlugin: (viewKey: string) => void;
  commandActions: QuickAction[];
  commandPopoverOpen: boolean;
  onCommandPopoverOpenChange: (open: boolean) => void;
  installingPluginIds?: ReadonlySet<string>;
  onOpenMarketplace: () => void;
  marketplaceUrlReady?: boolean;
  /** Retry the last turn at high effort */
  onRetryEffort: () => void | Promise<void>;
  /** Fork conversation from a given entry index */
  onFork: (entryIdx: number) => void | Promise<void>;
  /** Toggle star on a given entry index */
  onToggleStar: (entryIdx: number) => void;
  /** Returns star id if entry is starred, else null */
  isEntryStarred: (entryIdx: number) => string | null;
  /** Submit thumbs up/down feedback for an assistant message */
  onFeedback?: (messageIdx: number, rating: "up" | "down", reason?: string) => void | Promise<void>;
}

// ─── Day separator ───────────────────────────────────────────────────────────

function DaySeparator({ dateKey }: { dateKey: string }) {
  const label = formatDayLabel(dateKey);
  return (
    <div
      data-testid="day-separator"
      data-date={dateKey}
      className="flex items-center gap-3 py-4"
    >
      <span className="h-px flex-1 bg-border/50" />
      <span className="text-[11px] font-medium text-muted-foreground/70">
        {"📅"} {label}
      </span>
      <span className="h-px flex-1 bg-border/50" />
    </div>
  );
}

function formatDayLabel(dateKey: string): string {
  const today = new Date();
  const todayKey = today.toISOString().split("T")[0] as string;

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const yesterdayKey = yesterday.toISOString().split("T")[0] as string;

  if (dateKey === todayKey) return `${dateKey} (오늘)`;
  if (dateKey === yesterdayKey) return `${dateKey} (어제)`;
  return dateKey;
}

// ─── Checkpoint divider ────────────────────────────────────────────────────────

function CheckpointDivider({ label, messageCount }: { label: string; messageCount: number }) {
  return (
    <div
      data-testid="checkpoint-divider"
      className="flex items-center gap-2 py-2 my-2"
    >
      <span className="h-px flex-1 bg-blue-500/30" />
      <span className="text-[10px] text-blue-400/65 font-medium">
        {"───"} {"📌"} 체크포인트 · {label} ({messageCount} messages) {"───"}
      </span>
      <span className="h-px flex-1 bg-blue-500/30" />
    </div>
  );
}

// ─── Summary toast ─────────────────────────────────────────────────────────────

function SummaryToast({ summary }: { summary: string }) {
  const trimmed = summary.length > 120 ? `${summary.slice(0, 117)}…` : summary;
  return (
    <div
      data-testid="summary-toast"
      className="mx-auto max-w-[70%] border-l-2 border-blue-500/40 bg-card/50 px-3 py-1.5 mb-3 rounded-r text-[11px] text-muted-foreground/70"
    >
      {"📝"} 이전 요약: {trimmed}
    </div>
  );
}

// ─── Session title marker ─────────────────────────────────────────────────────

function SessionMarker({ title, sessionId }: { title: string; sessionId: string }) {
  return (
    <div
      className="mx-auto text-center text-[11px] text-muted-foreground/40 py-0.5 px-3"
      data-testid="session-marker"
    >
      — {title || sessionId.slice(0, 8)} —
    </div>
  );
}

// ─── Renders a list of entries with WorkGroup support (mirrors ChatView logic) ─

interface EntriesListProps {
  entries: ChatEntry[];
  streaming: boolean;
  isEntryStarred: (entryIdx: number) => string | null;
  /** Active session only — undefined for read-only historical sessions */
  onRetryEffort?: () => void | Promise<void>;
  /** Active session only — undefined for read-only historical sessions */
  onFork?: (entryIdx: number) => void | Promise<void>;
  /** Active session only — undefined for read-only historical sessions */
  onToggleStar?: (entryIdx: number) => void;
  onFeedback?: (messageIdx: number, rating: "up" | "down", reason?: string) => void | Promise<void>;
  /** Base index offset for entry star/fork callbacks (for historical sessions) */
  idxOffset?: number;
}

function EntriesList({
  entries,
  streaming,
  isEntryStarred,
  onRetryEffort,
  onFork,
  onToggleStar,
  onFeedback,
  idxOffset = 0,
}: EntriesListProps) {
  // O(n) single forward pass: classify entries into "intermediate" | "live" | "final".
  // Strategy: scan forward, track per-turn non-user entries; once the turn ends (next
  // user entry or end-of-list), the last non-user entry is "live"/"final" and all
  // preceding non-user entries in the turn are "intermediate".
  type EntryClass = "intermediate" | "live" | "final";
  const entryClassMap = new Map<number, EntryClass>();
  const entryTurnStartMap = new Map<number, number>();

  let lastUserIdx = -1;
  for (let k = entries.length - 1; k >= 0; k--) {
    if (entries[k]?.kind === "user") { lastUserIdx = k; break; }
  }

  let turnStart = -1;
  // Indices of non-user entries in the current turn (assistant/reasoning/tool_group).
  const turnWorkEntries: number[] = [];

  const flushTurn = () => {
    const last = turnWorkEntries.length - 1;
    for (let k = 0; k < turnWorkEntries.length; k++) {
      const idx = turnWorkEntries[k] as number;
      entryTurnStartMap.set(idx, turnStart >= 0 ? turnStart : 0);
      if (k < last) {
        entryClassMap.set(idx, "intermediate");
      } else {
        const e = entries[idx];
        entryClassMap.set(
          idx,
          e?.kind === "assistant" && !streaming ? "final" : "live",
        );
      }
    }
    turnWorkEntries.length = 0;
  };

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    if (e.kind === "user") {
      flushTurn();
      turnStart = i;
    } else if (e.kind === "assistant" || e.kind === "reasoning" || e.kind === "tool_group") {
      turnWorkEntries.push(i);
    }
  }
  flushTurn();

  const rendered: React.ReactNode[] = [];
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];
    if (!entry) { i++; continue; }
    const idx = i + idxOffset;

    if (entry.kind === "user") {
      rendered.push(
        <div
          key={idx}
          data-testid="user-message"
          className="ml-auto max-w-[75%] rounded-full bg-message-user px-3 py-1.5 text-sm text-message-user-foreground"
        >
          <div className="whitespace-pre-wrap">{entry.text}</div>
        </div>,
      );
      i++;
      continue;
    }

    if (entry.kind === "system") {
      if (entry.text.includes("checkpoint") || entry.text.includes("체크포인트")) {
        const summaryMatch = entry.text.match(/요약:\s*(.+)/);
        const countMatch = entry.text.match(/(\d+)\s*messages?/);
        rendered.push(
          <CheckpointDivider
            key={`cp-${idx}`}
            label="자동 정리"
            messageCount={countMatch ? parseInt(countMatch[1] ?? "0", 10) : 0}
          />,
        );
        if (summaryMatch?.[1]) {
          rendered.push(<SummaryToast key={`st-${idx}`} summary={summaryMatch[1]} />);
        }
      } else {
        rendered.push(
          <div key={idx} className="mx-auto text-center text-xs text-muted-foreground py-1 px-3 rounded-full bg-muted/50">
            {entry.text}
          </div>,
        );
      }
      i++;
      continue;
    }

    if (entry.kind === "imported_trigger") {
      rendered.push(
        <ImportedTriggerCard
          key={`trigger:${entry.sessionId}`}
          source={entry.source}
          prompt={entry.prompt}
          summary={entry.summary}
          toolCallCount={entry.toolCallCount}
          importedAt={entry.importedAt}
          response={entry.response}
          responseStreaming={entry.responseStreaming}
        />,
      );
      i++;
      continue;
    }

    // ── Intermediate: collect consecutive intermediate entries into one WorkGroup ──
    if (entryClassMap.get(i) === "intermediate") {
      const groupStart = i;
      const groupTurnStart = entryTurnStartMap.get(i) ?? 0;
      const groupIsActiveTurn = groupTurnStart === lastUserIdx && streaming;
      const groupEntries: { idx: number; node: React.ReactNode }[] = [];

      while (i < entries.length && entryClassMap.get(i) === "intermediate") {
        const e = entries[i];
        if (!e) { i++; continue; }
        if (e.kind === "reasoning") {
          groupEntries.push({ idx: i, node: <ReasoningCard key={i} entry={e} /> });
        } else if (e.kind === "tool_group") {
          groupEntries.push({ idx: i, node: <ToolGroupCard key={e.groupId} group={e} /> });
        } else if (e.kind === "assistant") {
          groupEntries.push({ idx: i, node: (
            <AssistantCard
              key={i}
              entry={e}
              highlightQuery=""
              isStarred={false}
              isFinal={false}
            />
          )});
        }
        i++;
      }

      rendered.push(
        <WorkGroup key={`wg-${groupStart + idxOffset}`} stepCount={groupEntries.length} streaming={groupIsActiveTurn}>
          {groupEntries.map((ge) => ge.node)}
        </WorkGroup>,
      );
      continue;
    }

    // ── Live: last entry in turn while streaming — no TurnActionBar ──
    if (entryClassMap.get(i) === "live") {
      if (entry.kind === "reasoning") {
        rendered.push(<ReasoningCard key={idx} entry={entry} />);
      } else if (entry.kind === "tool_group") {
        rendered.push(<ToolGroupCard key={entry.groupId} group={entry} />);
      } else if (entry.kind === "assistant") {
        rendered.push(
          <div key={idx}>
            <AssistantCard
              entry={entry}
              highlightQuery=""
              isStarred={!!isEntryStarred(idx)}
              isFinal={true}
            />
          </div>,
        );
      }
      i++;
      continue;
    }

    // ── Final: turn complete, last assistant — show TurnActionBar ──
    if (entryClassMap.get(i) === "final" && entry.kind === "assistant") {
      const starred = !!isEntryStarred(idx);
      const turnTokens = Math.ceil(((entry as { text?: string }).text?.length ?? 0) / 4);

      rendered.push(
        <div key={idx} className="rounded-md">
          <AssistantCard
            entry={entry}
            highlightQuery=""
            isStarred={starred}
            isFinal={true}
            turnTokens={turnTokens}
          />
          <TurnActionBar
            turnTokens={turnTokens}
            isStarred={starred}
            actions={{
              onRetry: onRetryEffort ? () => void onRetryEffort() : undefined,
              onFork: onFork ? () => void onFork(idx) : undefined,
              onToggleStar: onToggleStar ? () => onToggleStar(idx) : undefined,
            }}
            onFeedback={onFeedback ? (rating, reason) => void onFeedback(idx, rating, reason) : undefined}
          />
        </div>,
      );
      i++;
      continue;
    }

    // ── Fallback: unclassified edge-case entries ──
    if (entry.kind === "reasoning") {
      rendered.push(<ReasoningCard key={idx} entry={entry} />);
    } else if (entry.kind === "tool_group") {
      rendered.push(<ToolGroupCard key={entry.groupId} group={entry} />);
    }
    i++;
  }

  return <>{rendered}</>;
}

// ─── StackedChatView ──────────────────────────────────────────────────────────

export function StackedChatView({
  historicalSessions,
  currentSessionId,
  entries,
  streaming,
  onAsk,
  onGuide,
  onAbort,
  loading,
  reachedEnd,
  sentinelRef,
  scrollContainerRef,
  plugins,
  onSelectPlugin,
  commandActions,
  commandPopoverOpen,
  onCommandPopoverOpenChange,
  installingPluginIds,
  onOpenMarketplace,
  marketplaceUrlReady,
  onRetryEffort,
  onFork,
  onToggleStar,
  isEntryStarred,
  onFeedback,
}: StackedChatViewProps) {
  const workflowApi = getApi() as LvisApi;
  const composerRef = useRef<ComposerHandle | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to bottom when active entries are added or last entry's content changes.
  // "isAtTop" guard: don't force-scroll while user is reading history at the top.
  const lastEntryContent =
    entries.length > 0
      ? (entries[entries.length - 1] as { text?: string } | undefined)?.text ?? ""
      : "";
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
      return;
    }
    // Only auto-scroll if user is near the bottom (within 200px)
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < 200) {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [entries.length, lastEntryContent, scrollContainerRef]);

  const {
    question,
    setQuestion,
    attachments,
    setAttachments,
    attachmentNCounter,
    usedTokens,
    contextBudget,
    hasApiKey,
    contextOverflowPct,
    vendorSupportsThinking,
    enableThinkingChat,
    toggleThinking,
    rolePresets,
    activePreset,
    activePresetId,
    setActivePresetId,
  } = useChatContext();

  // Compute today's date key for the active session's day separator
  const todayKey = new Date().toISOString().split("T")[0] as string;

  // Group historical sessions by day
  const historicalByDay = useMemo(() => {
    const map = new Map<string, StackedSession[]>();
    for (const s of historicalSessions) {
      const existing = map.get(s.dayKey);
      if (existing) {
        existing.push(s);
      } else {
        map.set(s.dayKey, [s]);
      }
    }
    // Sort by day ascending (oldest first)
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [historicalSessions]);

  // Compute the active session's day key based on entries or today
  const activeDayKey = useMemo(() => {
    // Use today as default — entries don't carry per-entry timestamps yet
    return todayKey;
  }, [todayKey]);

  // Determine if today's historical data is already present (to avoid duplicate DaySeparator)
  const todayHasHistorical = historicalByDay.some(([dayKey]) => dayKey === activeDayKey);

  const hasAnyContent = historicalSessions.length > 0 || entries.length > 0;

  return (
    <div className="relative grid min-h-0 flex-1 grid-rows-[1fr_auto] mx-auto w-full max-w-3xl">
      {/* Scroll container */}
      <div
        ref={scrollContainerRef}
        className="flex flex-col overflow-y-auto p-4 gap-0"
        data-testid="stacked-scroll-container"
      >
        {/* Top sentinel for reverse infinite scroll */}
        <div ref={sentinelRef} className="shrink-0" data-testid="scroll-sentinel" />

        {/* Loading indicator */}
        {loading && (
          <div
            data-testid="stacked-loading"
            className="py-2 text-center text-[11px] text-muted-foreground border-b border-dashed border-border/40 mb-2"
          >
            {"▴"} 이전 기록 불러오는 중...
          </div>
        )}

        {reachedEnd && hasAnyContent && (
          <div className="py-2 text-center text-[10px] text-muted-foreground/50">
            — 대화 시작 —
          </div>
        )}

        {/* Empty state — shown only when no historical and no active entries */}
        {!hasAnyContent && !loading && (
          <div className="py-12 text-center text-sm text-muted-foreground" data-testid="stacked-empty">
            LVIS 에이전트가 준비되었습니다. 질문을 입력하거나 /command를 사용하세요.
          </div>
        )}

        {/* Historical sessions grouped by day */}
        {historicalByDay.map(([dayKey, daySessions]) => (
          <Fragment key={dayKey}>
            <DaySeparator dateKey={dayKey} />
            {daySessions.map((sess, sIdx) => {
              if (sess.entries.length === 0) return null;
              return (
              <Fragment key={sess.id}>
                {/* Show session title marker only between multiple sessions in the same day */}
                {daySessions.length > 1 && sIdx > 0 && (
                  <SessionMarker title={sess.title} sessionId={sess.id} />
                )}
                <EntriesList
                  entries={sess.entries}
                  streaming={false}
                  isEntryStarred={() => null}
                />
              </Fragment>
              );
            })}
          </Fragment>
        ))}

        {/* Active session section — ALWAYS rendered, lives at the bottom of the stack */}
        {/* Only add DaySeparator for today if not already shown by historical grouping */}
        {!todayHasHistorical && entries.length > 0 && (
          <DaySeparator dateKey={activeDayKey} />
        )}
        {todayHasHistorical && entries.length > 0 && (
          <div className="my-1 flex items-center gap-2">
            <span className="h-px flex-1 bg-border/30" />
            <span className="text-[10px] text-muted-foreground/40">현재 대화</span>
            <span className="h-px flex-1 bg-border/30" />
          </div>
        )}

        {entries.length > 0 && (
          <EntriesList
            entries={entries}
            streaming={streaming}
            isEntryStarred={isEntryStarred}
            onRetryEffort={onRetryEffort}
            onFork={onFork}
            onToggleStar={onToggleStar}
            onFeedback={onFeedback}
          />
        )}

        {/* Scroll anchor — kept at bottom so auto-scroll lands past the last message */}
        <div ref={chatEndRef} data-testid="chat-end-anchor" />
        <div className="shrink-0 pb-2" />
      </div>

      {/* Session todo panel + Input bar — always at bottom */}
      <SessionTodoPanel api={workflowApi} sessionId={currentSessionId} />
      <div className="border-t bg-card pb-3 space-y-2">
        <InputActionBar
          usedTokens={usedTokens}
          contextBudget={contextBudget}
          plugins={plugins}
          onSelectPlugin={onSelectPlugin}
          installingPluginIds={installingPluginIds}
          onOpenMarketplace={onOpenMarketplace}
          marketplaceUrlReady={marketplaceUrlReady}
          onInsertSlashCommand={(cmd) => setQuestion(question ? question + cmd + " " : cmd + " ")}
          onToggleChatSearch={() => {/* no-op in stacked view */}}
          commandActions={commandActions}
          commandPopoverOpen={commandPopoverOpen}
          onCommandPopoverOpenChange={onCommandPopoverOpenChange}
          attachDisabled={
            attachments.length >= ATTACH_MAX_COUNT ||
            hasApiKey === false ||
            contextOverflowPct >= 0.95
          }
          attachDisabledReason={
            hasApiKey === false
              ? "no-api-key"
              : contextOverflowPct >= 0.95
                ? "context-overflow"
                : "limit"
          }
          onAttach={async () => {
            const result = await window.lvis.attach.openFile();
            if (result.canceled) return;
            if (result.rejected.length > 0) {
              console.warn("attachment rejected (deny-list):", result.rejected, "deny:", DENY_EXTENSIONS);
            }
            const candidates: Attachment[] = [];
            for (const f of result.files) {
              const n = ++attachmentNCounter.current;
              if (f.isImage) {
                const img = await window.lvis.attach.readImage(f.path);
                if (!img.ok || !img.dataUrl || !img.mimeType || img.width === undefined || img.height === undefined || img.bytes === undefined) {
                  console.warn("readImage failed", f.path, img.error);
                  continue;
                }
                candidates.push({
                  id: `img-${Date.now()}-${n}`,
                  n,
                  kind: "image",
                  path: f.path,
                  mimeType: img.mimeType,
                  width: img.width,
                  height: img.height,
                  bytes: img.bytes,
                  dataUrl: img.dataUrl,
                });
              } else {
                candidates.push({
                  id: `file-${Date.now()}-${n}`,
                  n,
                  kind: "file",
                  path: f.path,
                  name: f.name,
                  ext: f.ext,
                  bytes: f.bytes,
                });
              }
            }
            if (candidates.length === 0) {
              composerRef.current?.focus();
              return;
            }
            let acceptedMarkers = "";
            flushSync(() => {
              setAttachments((prev) => {
                const remaining = Math.max(0, ATTACH_MAX_COUNT - prev.length);
                const accepted = candidates.slice(0, remaining);
                acceptedMarkers = accepted.map((a) => `${buildMarkerText(a)} `).join("");
                return [...prev, ...accepted];
              });
            });
            if (acceptedMarkers) {
              if (composerRef.current) {
                composerRef.current.insertAtCursor(acceptedMarkers);
              } else {
                setQuestion((prev) => prev + acceptedMarkers);
              }
            }
            composerRef.current?.focus();
          }}
          rolePresets={rolePresets}
          activePreset={activePreset}
          activePresetId={activePresetId}
          onSelectPreset={setActivePresetId}
          vendorSupportsThinking={vendorSupportsThinking}
          enableThinkingChat={enableThinkingChat}
          onToggleThinking={toggleThinking}
        />
        <Composer
          ref={composerRef}
          text={question}
          onTextChange={setQuestion}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          allocateN={() => ++attachmentNCounter.current}
          saveClipboardImage={(b64) => window.lvis.attach.saveClipboardImage(b64)}
          openExternal={(p) => window.lvis.attach.openExternal(p)}
          onSend={() => void (streaming ? onGuide(question) : onAsk(question))}
          onAbort={() => void onAbort()}
          streaming={streaming}
          disabled={hasApiKey === false || contextOverflowPct >= 0.95}
          onWarning={(msg) => console.warn(msg)}
          placeholder={
            hasApiKey === false
              ? "API 키를 먼저 설정해 주세요..."
              : streaming
                ? "응답 방향 지시 입력 (Enter 힌트 전송 / Shift+Enter 줄바꿈)"
                : "질문 입력 (Enter 전송 · Cmd/Ctrl+V 첨부) · /command 사용 가능"
          }
        />
      </div>
    </div>
  );
}

// Re-export these for use in test/assertions
export { DaySeparator, CheckpointDivider, SummaryToast };
