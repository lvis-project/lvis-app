/**
 * StackedChatView — PR-5 Phase 2 (feature flag: experimentalStackedChat).
 *
 * Kakao-style continuous message stream:
 * - Day separator between calendar-day boundaries.
 * - Inline checkpoint divider + summary toast after each compaction.
 * - User messages right-aligned (max 75%), assistant left (max 80%).
 * - Reverse infinite scroll: scroll to top → prefetches previous day.
 * - Input bar delegates to existing InputActionBar + Composer.
 * - No session card / collapsible — continuous flow only.
 */
import { useRef, useEffect } from "react";
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
import { SessionTodoPanel } from "./SessionTodoPanel.js";
import { getApi } from "../api-client.js";
import { useChatContext } from "../context/ChatContext.js";
import { buildMarkerText } from "../utils/attachment-markers.js";
import { ATTACH_MAX_COUNT, DENY_EXTENSIONS, type Attachment } from "../types/attachments.js";
import type { PluginEntry } from "./PluginGridButton.js";
import type { QuickAction } from "./CommandPopover.js";

export interface StackedChatViewProps {
  /** Loaded sessions (oldest → newest) */
  sessions: StackedSession[];
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

// ─── User bubble ──────────────────────────────────────────────────────────────

function UserBubble({ text }: { text: string }) {
  return (
    <div
      data-testid="user-message"
      className="ml-auto max-w-[75%] rounded-md border bg-primary px-3 py-2 text-sm text-primary-foreground"
    >
      <div className="mb-1 text-[11px] text-muted-foreground/60">나</div>
      <div className="whitespace-pre-wrap">{text}</div>
    </div>
  );
}

// ─── StackedChatView ──────────────────────────────────────────────────────────

export function StackedChatView({
  sessions,
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
}: StackedChatViewProps) {
  const workflowApi = getApi() as LvisApi;
  const composerRef = useRef<ComposerHandle | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to bottom whenever entries are added or the last message's
  // content changes (streaming updates). Uses "smooth" for new messages and
  // instant on mount.
  const lastEntryContent =
    entries.length > 0
      ? (entries[entries.length - 1] as { text?: string; content?: string } | undefined)?.text ?? ""
      : "";
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries.length, lastEntryContent]);
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

  // Build day → entries map from current session (active day messages)
  // Historical sessions are represented by their metadata only
  const groupedSessions = groupSessionsByDay(sessions);
  const todayKey = new Date().toISOString().split("T")[0] as string;
  const currentDayKey = sessions.find((s) => s.id === currentSessionId)?.dayKey ?? todayKey;

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

        {reachedEnd && sessions.length > 0 && (
          <div className="py-2 text-center text-[10px] text-muted-foreground/50">
            — 대화 시작 —
          </div>
        )}

        {/* Empty state */}
        {sessions.length === 0 && !loading && (
          <div className="py-12 text-center text-sm text-muted-foreground" data-testid="stacked-empty">
            LVIS 에이전트가 준비되었습니다. 질문을 입력하거나 /command를 사용하세요.
          </div>
        )}

        {/* Historical session summaries grouped by day */}
        {Array.from(groupedSessions.entries()).map(([dayKey, daySessions]) => (
          <div key={dayKey}>
            <DaySeparator dateKey={dayKey} />
            {daySessions.map((sess) => {
              const isActive = sess.id === currentSessionId;
              if (isActive) {
                // Active session: render live entries
                return (
                  <div key={sess.id} className="space-y-3">
                    {renderSessionEntries(entries, streaming)}
                  </div>
                );
              }
              // Historical session: show title as a system note
              return (
                <div
                  key={sess.id}
                  className="mx-auto text-center text-xs text-muted-foreground/50 py-1 px-3"
                  data-testid="session-marker"
                >
                  [{sess.title || sess.id.slice(0, 8)}]
                </div>
              );
            })}
          </div>
        ))}

        {/* If active session has no historical entries in sessions list, render current entries */}
        {sessions.length === 0 && entries.length > 0 && (
          <div className="space-y-3">
            {renderSessionEntries(entries, streaming)}
          </div>
        )}

        {/* Day separator for today if we have entries but sessions not loaded yet */}
        {sessions.length === 0 && entries.length === 0 && !loading && null}

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function groupSessionsByDay(sessions: StackedSession[]): Map<string, StackedSession[]> {
  const map = new Map<string, StackedSession[]>();
  for (const s of sessions) {
    const existing = map.get(s.dayKey);
    if (existing) {
      existing.push(s);
    } else {
      map.set(s.dayKey, [s]);
    }
  }
  return map;
}

function renderSessionEntries(entries: ChatEntry[], streaming: boolean): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const key = i;

    if (entry.kind === "user") {
      nodes.push(<UserBubble key={key} text={entry.text} />);
      continue;
    }
    if (entry.kind === "system") {
      // Checkpoint divider: system messages from compaction include a summary marker
      if (entry.text.includes("checkpoint") || entry.text.includes("체크포인트")) {
        const summaryMatch = entry.text.match(/요약:\s*(.+)/);
        const countMatch = entry.text.match(/(\d+)\s*messages?/);
        nodes.push(
          <CheckpointDivider
            key={`cp-${key}`}
            label="자동 정리"
            messageCount={countMatch ? parseInt(countMatch[1] ?? "0", 10) : 0}
          />,
        );
        if (summaryMatch?.[1]) {
          nodes.push(<SummaryToast key={`st-${key}`} summary={summaryMatch[1]} />);
        }
      } else {
        nodes.push(
          <div key={key} className="mx-auto text-center text-xs text-muted-foreground py-1 px-3 rounded-full bg-muted/50">
            {entry.text}
          </div>,
        );
      }
      continue;
    }
    if (entry.kind === "assistant") {
      const isFinal = !streaming || i < entries.length - 1;
      nodes.push(
        <div key={key} className="max-w-[80%]">
          <AssistantCard
            entry={entry}
            highlightQuery=""
            isStarred={false}
            isFinal={isFinal}
          />
          {isFinal && <TurnActionBar />}
        </div>,
      );
      continue;
    }
    if (entry.kind === "reasoning") {
      nodes.push(<ReasoningCard key={key} entry={entry} />);
      continue;
    }
    if (entry.kind === "tool_group") {
      nodes.push(<ToolGroupCard key={entry.groupId} group={entry} />);
      continue;
    }
  }
  return nodes;
}

// Re-export these for use in test/assertions
export { DaySeparator, CheckpointDivider, SummaryToast };
