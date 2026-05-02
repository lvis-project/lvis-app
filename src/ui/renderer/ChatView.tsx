import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { KeyRound, Pencil, Star, GitBranch } from "lucide-react";
import { Button } from "../../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip.js";
import { ScrollArea } from "../../components/ui/scroll-area.js";
import { formatCostBadge } from "../../lib/cost-estimator.js";
import { RoutineCard } from "./components/RoutineCard.js";
import { RoutineRunningIndicator } from "./components/RoutineRunningIndicator.js";
import { TriggerCard } from "./components/TriggerCard.js";
import { ImportedTriggerCard } from "./components/ImportedTriggerCard.js";
import { AssistantCard } from "./components/AssistantCard.js";
import { UserMessageEditor } from "./components/UserMessageEditor.js";
import { ReasoningCard } from "./components/ReasoningCard.js";
import { ToolGroupCard } from "./components/ToolGroupCard.js";
import { ChatSearchOverlay } from "./components/ChatSearchOverlay.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover.js";
import { Calendar } from "../../components/ui/calendar.js";

/**
 * Today-date badge in the chat scroll header. Click opens a Popover with
 * the LVIS-styled calendar (shadcn/react-day-picker, palette-tuned). UI-only
 * for now — selected date isn't wired to history navigation yet.
 */
function DateBadge() {
  const [pickedDate, setPickedDate] = useState<Date | undefined>(undefined);
  const label = new Date().toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="rounded-full bg-card border px-3 py-1 text-[11px] text-foreground/70 cursor-pointer hover:bg-muted"
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-auto p-2 shadow-none border border-[#E6E1D6] bg-[#F9F7F3]">
        <Calendar mode="single" selected={pickedDate} onSelect={setPickedDate} />
      </PopoverContent>
    </Popover>
  );
}
import { SessionTodoPanel } from "./components/SessionTodoPanel.js";
import { SubAgentCard } from "./components/SubAgentCard.js";
import { SkillBadge } from "./components/SkillBadge.js";
import { WorkGroup } from "./components/WorkGroup.js";
import { TurnActionBar } from "./components/TurnActionBar.js";
import { getApi } from "./api-client.js";
import { highlightText } from "./utils/html-preview.js";
import { useChatContext } from "./context/ChatContext.js";
import { InputActionBar } from "./components/InputActionBar.js";
import { Composer, type ComposerHandle } from "./components/Composer.js";
import {
  ATTACH_MAX_COUNT,
  DENY_EXTENSIONS,
  type Attachment,
} from "./types/attachments.js";
import { buildMarkerText } from "./utils/attachment-markers.js";
import type { PluginEntry } from "./components/PluginGridButton.js";
import type { QuickAction } from "./components/CommandPopover.js";
import type { AskUserQuestionRequest } from "./components/AskUserQuestionCard.js";
import type { SubAgentSpawn } from "./components/SubAgentCard.js";
import type { SkillBadgeProps } from "./components/SkillBadge.js";

/**
 * ChatView — consumes cross-cutting state via `useChatContext()`. Action
 * callbacks stay as direct props so data flow for user-driven side effects
 * remains explicit at the App level.
 */
export interface ChatViewProps {
  onAsk: (q: string) => void | Promise<void>;
  onGuide: (q: string) => void | Promise<void>;
  onEditSave: (idx: number, text: string) => void | Promise<void>;
  onFork: (idx: number) => void | Promise<void>;
  onToggleStar: (idx: number) => void | Promise<void>;
  onRetryEffort: () => void | Promise<void>;
  isEntryStarred: (idx: number) => string | null;
  /** B4: abort current streaming turn */
  onAbort: () => void | Promise<void>;
  /** D6: submit thumbs up/down feedback for an assistant message */
  onFeedback?: (messageIdx: number, rating: "up" | "down", reason?: string) => void | Promise<void>;
  /** Workflow tool state — lifted to App level so panel survives view navigation */
  subAgentSpawns: SubAgentSpawn[];
  loadedSkills: SkillBadgeProps[];
  /** True when FloatingQuestionPanel (mounted in App) has pending questions — used to suppress routine overlay */
  hasAskQuestions: boolean;
  /** Plugin list for InputActionBar plugin grid */
  plugins: PluginEntry[];
  /** Navigate to a plugin view */
  onSelectPlugin: (viewKey: string) => void;
  /** Quick-action items for CommandPopover (빠른 실행 section) */
  commandActions: QuickAction[];
  /** Controlled open state for CommandPopover */
  commandPopoverOpen: boolean;
  onCommandPopoverOpenChange: (open: boolean) => void;
  installingPluginIds?: ReadonlySet<string>;
  onOpenMarketplace: () => void;
  marketplaceUrlReady?: boolean;
}

export function ChatView({ onAsk, onGuide, onEditSave, onFork, onToggleStar, onRetryEffort, isEntryStarred, onAbort, onFeedback, subAgentSpawns, loadedSkills, hasAskQuestions, plugins, onSelectPlugin, commandActions, commandPopoverOpen, onCommandPopoverOpenChange, installingPluginIds, onOpenMarketplace, marketplaceUrlReady }: ChatViewProps) {
  // We still need the api for SessionTodoPanel; obtain it via singleton.
  const workflowApi = getApi();
  const composerRef = useRef<ComposerHandle | null>(null);
  const {
    entries, streaming, editingEntryIdx, setEditingEntryIdx, editBusy,
    question, setQuestion, chatEndRef, currentSessionId,
    hasApiKey, onOpenSettings,
    routineResult, routineQueueIndex, routineQueueTotal,
    onDismissRoutineResult, onSnoozeRoutineResult,
    onPrevRoutineResult, onNextRoutineResult, runningRoutines,
    triggerResult, onDismissTrigger, onAcceptTrigger,
    searchOpen, searchQuery, searchCase, searchMatches, searchMatchSet, searchIdx, searchHighlight,
    searchChangeQuery, searchToggleCase, searchNext, searchPrev, searchCloseOverlay, searchToggleOverlay,
    contextOverflowPct, usedTokens, contextBudget, contextPercent, contextColor,
    rolePresets, activePreset, activePresetId, setActivePresetId,
    attachments, setAttachments, attachmentNCounter,
    vendorSupportsThinking, enableThinkingChat, toggleThinking,
    costEstimate, costBadgeClass,
  } = useChatContext();


  // No auto-scroll needed for floating panel — it is positioned outside
  // the scroll viewport so it is always visible regardless of scroll position.

  // B4: Ctrl/Cmd+C while streaming and no text selected → abort
  useEffect(() => {
    if (!streaming) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "c") {
        const sel = window.getSelection();
        if (sel && sel.toString().length > 0) return; // let copy work normally
        // B4 fix: do not intercept Ctrl+C when focus is inside an editable element —
        // native copy must work in <input>, <textarea>, and contenteditable.
        const target = e.target as HTMLElement;
        const isEditable =
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable;
        if (isEditable) return;
        e.preventDefault();
        void onAbort();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [streaming, onAbort]);

  return (
    <div className="relative grid min-h-0 flex-1 grid-rows-[1fr_auto] mx-auto w-full max-w-3xl">
      {/* ChatSearchOverlay moved INSIDE ScrollArea below so its sticky top-0
          attaches to the chat scroll viewport instead of floating above it. */}
      {hasApiKey === false && (
        <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
          <Card className="w-[400px]"><CardHeader className="text-center"><KeyRound className="mx-auto mb-2 h-10 w-10 text-muted-foreground" /><CardTitle>API 키 설정 필요</CardTitle><CardDescription>채팅을 시작하려면 Claude API 키를 설정해 주세요.</CardDescription></CardHeader>
            <CardContent className="flex justify-center"><Button onClick={onOpenSettings}><KeyRound className="mr-2 h-4 w-4" />설정 열기</Button></CardContent>
          </Card>
        </div>
      )}
      {/* 루틴 floating overlay — 단일 슬롯에 진행 중 / 결과 중 하나만 표시.
          진행 중이면 RoutineRunningIndicator, 아니면 직전 결과 RoutineCard.
          긴 브리핑은 카드 내부에서 스크롤 (max-h-[60vh] + overflow-y-auto).
          FloatingQuestionPanel은 App 레벨에서 렌더링 — 뷰 전환 시에도 유지. */}
      {/* Suppress the floating routine overlay while an ask card is pending —
          a question demanding the user's response shouldn't compete with a
          running-routine indicator for attention. The overlay reappears
          automatically once the user resolves or dismisses the question. */}
      {(runningRoutines.size > 0 || routineResult) && !hasAskQuestions && (
        <div className="pointer-events-none absolute left-0 right-0 top-2 z-20 flex justify-center px-4">
          <div className="pointer-events-auto flex w-full max-w-2xl max-h-[60vh] flex-col overflow-hidden">
            {runningRoutines.size > 0 ? (
              <RoutineRunningIndicator runningRoutines={runningRoutines} />
            ) : routineResult ? (
              <RoutineCard
                key={`${routineResult.routineId}::${routineResult.generatedAt}`}
                result={routineResult}
                onDismiss={onDismissRoutineResult}
                onSnooze={onSnoozeRoutineResult}
                index={routineQueueIndex}
                total={routineQueueTotal}
                onPrev={onPrevRoutineResult}
                onNext={onNextRoutineResult}
              />
            ) : null}
          </div>
        </div>
      )}
      {/* Proactive trigger overlays — visibility-driven slot routing (P2):
            user-visible → centered modal-like card (below routine area)
            summary-only → top-right compact toast that auto-dismisses
            silent       → never reaches here (filtered in useTriggerResult)
          The trigger session is held in an isolated ConversationLoop so chat
          history below remains clean unless the user clicks "지금 답하기". */}
      {triggerResult && triggerResult.visibility === "user-visible" && (
        <div className="pointer-events-none absolute left-0 right-0 top-[calc(0.5rem+62vh)] z-20 flex justify-center px-4">
          <div className="pointer-events-auto flex w-full max-w-2xl max-h-[40vh] flex-col overflow-hidden">
            <TriggerCard
              key={triggerResult.sessionId}
              result={triggerResult}
              onDismiss={onDismissTrigger}
              onAccept={onAcceptTrigger}
            />
          </div>
        </div>
      )}
      {triggerResult && triggerResult.visibility === "summary-only" && (
        // z-30 keeps the toast above the routine area (z-20) on narrow
        // windows where the centered routine card and right-edge toast
        // overlap horizontally.
        <div className="pointer-events-none absolute right-4 top-2 z-30 flex justify-end">
          <div className="pointer-events-auto w-[380px] max-w-[calc(100vw-2rem)]">
            <TriggerCard
              key={triggerResult.sessionId}
              result={triggerResult}
              onDismiss={onDismissTrigger}
              onAccept={onAcceptTrigger}
            />
          </div>
        </div>
      )}
      <ScrollArea className="h-full px-3 py-4"><div className="space-y-3">
        <ChatSearchOverlay
          open={searchOpen}
          query={searchQuery}
          caseSensitive={searchCase}
          matchCount={searchMatches.length}
          currentIdx={searchIdx}
          onChangeQuery={searchChangeQuery}
          onToggleCase={searchToggleCase}
          onNext={searchNext}
          onPrev={searchPrev}
          onClose={searchCloseOverlay}
        />
        {/* Today's date badge — always shown above the conversation. Per-day
            session grouping (one badge per day-boundary inside a long
            conversation) requires a timestamp on each ChatEntry, which the
            current type doesn't carry; that's a follow-up. For now the badge
            represents "today" — auto-refreshes to the current locale date
            on render. */}
        <div className="flex justify-center">
          <DateBadge />
        </div>
        {/* Workflow tools (S1+S2): skill badges + sub-agents + ask-user inline.
            SessionTodoPanel is intentionally NOT here — it sits above the input
            cluster (see below the ScrollArea) so it stays visible regardless of
            chat scroll position. */}
        {loadedSkills.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap gap-2" data-testid="skill-badges-row">
            {loadedSkills.map((s, i) => (
              <SkillBadge key={`${s.name}:${i}`} {...s} />
            ))}
          </div>
        )}
        {subAgentSpawns.map((spawn) => (
          <SubAgentCard key={spawn.spawnId} spawn={spawn} />
        ))}
        {entries.length === 0 && hasApiKey !== false && !hasAskQuestions && <div className="py-12 text-center text-sm text-muted-foreground">LVIS 에이전트가 준비되었습니다. 질문을 입력하거나 /command를 사용하세요.</div>}
        {(() => {
          // Three-way entry classification eliminates retroactive-reclassification flicker.
          //
          // "intermediate" — has ≥1 subsequent entry in the same turn → lives in WorkGroup
          // "live"         — last entry in turn while global streaming is still active
          //                  → shown below WorkGroup, NO TurnActionBar (prevents premature
          //                    action-bar flash when a planning message transitions to a tool call)
          // "final"        — last assistant entry AND global streaming=false
          //                  → shown with TurnActionBar (turn truly complete)
          //
          // TurnActionBar therefore appears ONLY when the whole turn is done, never during it.

          // Last user-message index: determines which WorkGroup belongs to the active turn.
          let lastUserIdx = -1;
          for (let k = entries.length - 1; k >= 0; k--) {
            if (entries[k]?.kind === "user") { lastUserIdx = k; break; }
          }

          type EntryClass = "intermediate" | "live" | "final";
          const entryClassMap = new Map<number, EntryClass>();
          const finalTurnStartMap = new Map<number, number>(); // final idx → turn-start idx
          const entryTurnStartMap = new Map<number, number>(); // classified idx → turn-start idx

          let turnStart = -1;
          for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            if (!e) continue;
            if (e.kind === "user") { turnStart = i; continue; }
            if (e.kind !== "assistant" && e.kind !== "reasoning" && e.kind !== "tool_group") continue;

            let nextUserIdx = entries.length;
            for (let j = i + 1; j < entries.length; j++) {
              if (entries[j]?.kind === "user") { nextUserIdx = j; break; }
            }

            const hasSubsequent = entries.slice(i + 1, nextUserIdx).some(
              (ne) => ne.kind === "assistant" || ne.kind === "tool_group" || ne.kind === "reasoning",
            );

            const myTurnStart = turnStart >= 0 ? turnStart : 0;
            entryTurnStartMap.set(i, myTurnStart);

            if (hasSubsequent) {
              entryClassMap.set(i, "intermediate");
            } else if (e.kind === "assistant" && !streaming) {
              entryClassMap.set(i, "final");
              finalTurnStartMap.set(i, myTurnStart);
            } else {
              entryClassMap.set(i, "live");
            }
          }

          const rendered: React.ReactNode[] = [];
          let i = 0;
          while (i < entries.length) {
            const entry = entries[i];
            if (!entry) { i++; continue; }
            // Capture idx by value — closures in this loop must not close over mutable `i`
            const idx = i;

            const isMatch = searchMatchSet.has(idx);
            const isCurrentMatch = searchOpen && searchMatches[searchIdx] === idx;
            const ringCls = isCurrentMatch ? "ring-2 ring-primary" : isMatch ? "ring-1 ring-primary/40" : "";

            if (entry.kind === "user") {
              if (editingEntryIdx === i) {
                rendered.push(
                  <UserMessageEditor
                    key={idx}
                    initialText={entry.text}
                    busy={editBusy}
                    onCancel={() => setEditingEntryIdx(null)}
                    onSave={(next) => void onEditSave(idx, next)}
                  />
                );
              } else {
                const starId = isEntryStarred(idx);
                const starActive = !!starId;
                rendered.push(
                  <div key={idx} className={`group relative ml-auto w-fit max-w-[85%] rounded-full bg-message-user px-3 py-1.5 text-sm text-message-user-foreground ${ringCls}`}>
                    {/* "나" label removed — sender is implicit. Star + hover
                        actions float top-right via absolute positioning so
                        the bubble has no header chrome. */}
                    {starActive ? (
                      <Star className="absolute right-2 top-2 h-3 w-3 fill-yellow-400 text-yellow-400" />
                    ) : null}
                    <div className="absolute right-2 top-2 hidden gap-1 group-hover:flex bg-message-user/95 rounded">
                      <button className="rounded p-0.5 hover:bg-black/20" title="편집" onClick={() => setEditingEntryIdx(idx)}><Pencil className="h-3 w-3" /></button>
                      <button className="rounded p-0.5 hover:bg-black/20" title="분기" onClick={() => void onFork(idx)}><GitBranch className="h-3 w-3" /></button>
                      <button className="rounded p-0.5 hover:bg-black/20" title="즐겨찾기" onClick={() => void onToggleStar(idx)}>
                        <Star className={`h-3 w-3 ${starActive ? "fill-yellow-400 text-yellow-400" : ""}`} />
                      </button>
                    </div>
                    <div className="whitespace-pre-wrap">{searchHighlight ? highlightText(entry.text, searchHighlight) : entry.text}</div>
                  </div>
                );
              }
              i++;
              continue;
            }

            if (entry.kind === "system") {
              rendered.push(<div key={idx} className="mx-auto text-center text-xs text-muted-foreground py-1 px-3 rounded-full bg-muted/50">{entry.text}</div>);
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
                />
              );
              i++;
              continue;
            }

            // ── Intermediate: collect consecutive intermediate entries into one WorkGroup ──
            if (entryClassMap.get(i) === "intermediate") {
              const groupStart = i;
              const groupTurnStart = entryTurnStartMap.get(i) ?? 0;
              // Spinner is shown only while this WorkGroup belongs to the currently active turn
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
                      highlightQuery={searchHighlight}
                      isStarred={false}
                      isFinal={false}
                    />
                  )});
                }
                i++;
              }

              rendered.push(
                <WorkGroup key={`wg-${groupStart}`} stepCount={groupEntries.length} streaming={groupIsActiveTurn}>
                  {groupEntries.map((ge) => ge.node)}
                </WorkGroup>
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
                  <div key={idx} className={ringCls || undefined}>
                    <AssistantCard
                      entry={entry}
                      highlightQuery={searchHighlight}
                      isStarred={!!isEntryStarred(idx)}
                      isFinal={true}
                    />
                  </div>
                );
              }
              i++;
              continue;
            }

            // ── Final: turn complete, last assistant — show TurnActionBar ──
            if (entryClassMap.get(i) === "final" && entry.kind === "assistant") {
              const turnStartIdx = finalTurnStartMap.get(i) ?? 0;
              const turnTokens = entries.slice(turnStartIdx, i + 1).reduce((sum, e) => {
                if (e.kind === "assistant" || e.kind === "reasoning" || e.kind === "user") {
                  return sum + Math.ceil(((e as any).text?.length ?? 0) / 4);
                }
                if (e.kind === "tool_group") {
                  const toolSum = ((e as any).tools ?? []).reduce(
                    (ts: number, t: any) => ts + Math.ceil((JSON.stringify(t.input ?? {}).length + (t.result?.length ?? 0)) / 4),
                    0,
                  );
                  return sum + toolSum;
                }
                return sum;
              }, 0);

              rendered.push(
                <div key={idx} className={`${ringCls} rounded-md`}>
                  <AssistantCard
                    entry={entry}
                    highlightQuery={searchHighlight}
                    isStarred={!!isEntryStarred(idx)}
                    isFinal={true}
                    turnTokens={turnTokens}
                  />
                  <TurnActionBar
                    turnTokens={turnTokens}
                    isStarred={!!isEntryStarred(idx)}
                    actions={{
                      onRetry: () => void onRetryEffort(),
                      onFork: () => void onFork(idx),
                      onToggleStar: () => void onToggleStar(idx),
                    }}
                    onFeedback={onFeedback ? (rating, reason) => void onFeedback(idx, rating, reason) : undefined}
                  />
                </div>
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
          return rendered;
        })()}
        <div ref={chatEndRef} />
      </div></ScrollArea>
      {contextOverflowPct >= 0.95 && (
        <div className="border-t bg-destructive/10 px-3 py-1.5 text-xs text-destructive flex items-center gap-2">
          <span className="font-semibold">컨텍스트 {Math.round(contextOverflowPct * 100)}% 사용</span>
          <span>— 자동 압축이 필요합니다. 전송이 일시 차단됩니다.</span>
        </div>
      )}
      {contextOverflowPct >= 0.80 && contextOverflowPct < 0.95 && (
        <div className="border-t bg-amber-500/10 px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400 flex items-center gap-2">
          <span className="font-semibold">컨텍스트 {Math.round(contextOverflowPct * 100)}% 사용</span>
          <span>— 곧 자동 압축됩니다.</span>
        </div>
      )}
      {/* Assistant todo panel — anchored above the input cluster, below the
          chat scroll area. Stays visible regardless of where the user has
          scrolled the chat. The panel collapses by default once it has
          content; in the collapsed state the active item title streams next
          to the count so the user always sees what step is running. */}
      {/* AskUserQuestionCard instances are now rendered inside FloatingQuestionPanel
          (positioned absolutely at the top of this grid, z-40). Removed from
          inline stream to eliminate the buried-question UX pain point. */}
      <SessionTodoPanel api={workflowApi} sessionId={currentSessionId} />
      <div className="bg-background pb-1 space-y-2">
        <InputActionBar
          usedTokens={usedTokens}
          contextBudget={contextBudget}
          plugins={plugins}
          onSelectPlugin={onSelectPlugin}
          installingPluginIds={installingPluginIds}
          onOpenMarketplace={onOpenMarketplace}
          marketplaceUrlReady={marketplaceUrlReady}
          onInsertSlashCommand={(cmd) => setQuestion(question ? question + cmd + " " : cmd + " ")}
          onToggleChatSearch={searchToggleOverlay}
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
            // Build all candidate attachments first. The 5-cap is enforced
            // at *commit* time inside the setAttachments updater, so a
            // concurrent clipboard paste during the readImage await cannot
            // push us past the limit (the updater receives the latest
            // committed state, not the closure-captured one).
            const candidates: Attachment[] = [];
            for (const f of result.files) {
              const n = ++attachmentNCounter.current;
              if (f.isImage) {
                const img = await window.lvis.attach.readImage(f.path);
                if (
                  !img.ok ||
                  !img.dataUrl ||
                  !img.mimeType ||
                  img.width === undefined ||
                  img.height === undefined ||
                  img.bytes === undefined
                ) {
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
            // Atomic commit: setAttachments AND text-insert MUST land in
            // the same render commit, otherwise Composer's marker-sync
            // useEffect runs between the two and clears `attachments`
            // (because text still has no marker → liveAttachments=[] →
            // mismatch → destructive cleanup). Putting both inside one
            // flushSync batches them so the next render sees attachments
            // and marker text consistent.
            let acceptedMarkers = "";
            flushSync(() => {
              setAttachments((prev) => {
                const remaining = Math.max(0, ATTACH_MAX_COUNT - prev.length);
                const accepted = candidates.slice(0, remaining);
                if (accepted.length < candidates.length) {
                  console.warn(
                    `${candidates.length - accepted.length} attachment(s) dropped — ${ATTACH_MAX_COUNT}-cap reached during async open/read`,
                  );
                }
                acceptedMarkers = accepted.map((a) => `${buildMarkerText(a)} `).join("");
                return [...prev, ...accepted];
              });
              // Insert at caret in the SAME flushSync — batched with
              // setAttachments into one render so the destructive sync
              // useEffect never sees a mismatch.
              if (acceptedMarkers) {
                if (composerRef.current) {
                  composerRef.current.insertAtCursor(acceptedMarkers);
                } else {
                  setQuestion((prev) => prev + acceptedMarkers);
                }
              }
            });
            // Return focus to the composer textarea so the user can keep
            // typing or use Cmd/Ctrl+A immediately after the file dialog
            // closes — without this, focus stays on the action bar button
            // and the next keystroke goes nowhere visible.
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
        <div className="px-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={`text-[11px] font-mono ${costBadgeClass}`} title="예상 비용">
                {formatCostBadge(costEstimate.total)}
              </span>
            </TooltipTrigger>
            <TooltipContent className="text-xs">
              <div>입력: {costEstimate.inputTokens.toLocaleString()} tok · ${costEstimate.inputCost.toFixed(5)}</div>
              <div>출력(추정): {costEstimate.outputTokens.toLocaleString()} tok · ${costEstimate.outputCost.toFixed(5)}</div>
              <div className="font-semibold">합계: ${costEstimate.total.toFixed(5)}</div>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
