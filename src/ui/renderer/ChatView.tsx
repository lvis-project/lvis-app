import { useCallback, useEffect } from "react";
import { ChevronDown, Globe, KeyRound, Loader2, Paperclip, Pencil, Square, Star, User, X as XIcon, GitBranch } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover.js";
import { Button } from "../../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card.js";
import { Textarea } from "../../components/ui/textarea.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.js";
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
import { AskUserQuestionCard } from "./components/AskUserQuestionCard.js";
import { SessionTodoPanel } from "./components/SessionTodoPanel.js";
import { SubAgentCard } from "./components/SubAgentCard.js";
import { SkillBadge } from "./components/SkillBadge.js";
import { WorkGroup } from "./components/WorkGroup.js";
import { TurnActionBar } from "./components/TurnActionBar.js";
import { useWorkflowTools } from "./hooks/use-workflow-tools.js";
import { getApi } from "./api-client.js";
import { highlightText } from "./utils/html-preview.js";
import { useChatContext } from "./context/ChatContext.js";

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
}

export function ChatView({ onAsk, onGuide, onEditSave, onFork, onToggleStar, onRetryEffort, isEntryStarred, onAbort, onFeedback }: ChatViewProps) {
  // Workflow tools (S1+S2): inline cards layered above the chat entries.
  // We grab the api lazily to avoid threading another prop through the
  // context — the api is a singleton and equally valid here.
  const workflowApi = getApi();
  const {
    askQuestions,
    subAgentSpawns,
    loadedSkills,
    dismissAskQuestion,
  } = useWorkflowTools(workflowApi);
  const {
    entries, streaming, editingEntryIdx, setEditingEntryIdx, editBusy,
    question, setQuestion, chatEndRef,
    hasApiKey, onOpenSettings,
    routineResult, routineQueueIndex, routineQueueTotal,
    onDismissRoutineResult, onSnoozeRoutineResult,
    onPrevRoutineResult, onNextRoutineResult, runningRoutines,
    triggerResult, onDismissTrigger, onAcceptTrigger,
    searchOpen, searchQuery, searchCase, searchMatches, searchMatchSet, searchIdx, searchHighlight,
    searchChangeQuery, searchToggleCase, searchNext, searchPrev, searchCloseOverlay,
    contextOverflowPct, usedTokens, contextBudget, contextPercent, contextColor,
    rolePresets, activePreset, activePresetId, setActivePresetId,
    attachedDocs, setAttachedDocs, docPopoverOpen, setDocPopoverOpen,
    indexedDocs, docsLoading, refreshIndexedDocs,
    langLock, setLangLock,
    vendorSupportsThinking, enableThinkingChat, toggleThinking,
    costEstimate, costBadgeClass,
  } = useChatContext();

  const handleAskCurrent = useCallback(() => { void onAsk(question); }, [onAsk, question]);

  // Auto-scroll to the newly-appended ask card. App-level scroll effect
  // only fires on `entries` changes; ask cards are not entries, so without
  // this the card can land off-screen if it appears between assistant
  // turns (e.g. tool execution prompts the user mid-loop).
  useEffect(() => {
    if (askQuestions.length === 0) return;
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [askQuestions.length, chatEndRef]);

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
    <div className="relative grid min-h-0 flex-1 grid-rows-[1fr_auto]">
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
      {hasApiKey === false && (
        <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
          <Card className="w-[400px]"><CardHeader className="text-center"><KeyRound className="mx-auto mb-2 h-10 w-10 text-muted-foreground" /><CardTitle>API 키 설정 필요</CardTitle><CardDescription>채팅을 시작하려면 Claude API 키를 설정해 주세요.</CardDescription></CardHeader>
            <CardContent className="flex justify-center"><Button onClick={onOpenSettings}><KeyRound className="mr-2 h-4 w-4" />설정 열기</Button></CardContent>
          </Card>
        </div>
      )}
      {/* 루틴 floating overlay — 단일 슬롯에 진행 중 / 결과 중 하나만 표시.
          진행 중이면 RoutineRunningIndicator, 아니면 직전 결과 RoutineCard.
          긴 브리핑은 카드 내부에서 스크롤 (max-h-[60vh] + overflow-y-auto). */}
      {/* Suppress the floating routine overlay while an ask card is pending —
          a question demanding the user's response shouldn't compete with a
          running-routine indicator for attention. The overlay reappears
          automatically once the user resolves or dismisses the question. */}
      {(runningRoutines.size > 0 || routineResult) && askQuestions.length === 0 && (
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
      <ScrollArea className="h-full p-4"><div className="space-y-3">
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
        {entries.length === 0 && hasApiKey !== false && askQuestions.length === 0 && <div className="py-12 text-center text-sm text-muted-foreground">LVIS 에이전트가 준비되었습니다. 질문을 입력하거나 /command를 사용하세요.</div>}
        {(() => {
          // Pre-compute turn structure:
          // Identify turn boundaries and which assistant entry is the "final" one per turn.
          // A turn starts at a user message. The final assistant in a turn is the last
          // assistant entry before the next user message (or end of entries).
          // All entries between the user message and the final assistant are "intermediate".

          // Build a set of indices that are intermediate (non-final assistant, reasoning, tool_group within a turn)
          const intermediateSet = new Set<number>();
          // Map final assistant idx -> turn start idx (for turnTokens computation)
          const finalAssistantTurnStart = new Map<number, number>();

          let turnStart = -1;
          for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            if (!e) continue;
            if (e.kind === "user") {
              turnStart = i;
            } else if (e.kind === "assistant") {
              // Check if this is the final assistant in its turn
              const isFinal = !entries.slice(i + 1).some((ne) => ne.kind === "assistant" || ne.kind === "user");
              // More precisely: final if no assistant comes before the next user message
              let nextUserIdx = entries.length;
              for (let j = i + 1; j < entries.length; j++) {
                if (entries[j]?.kind === "user") { nextUserIdx = j; break; }
              }
              // An assistant entry is INTERMEDIATE if any assistant OR tool_group follows
              // within the same turn. tool_group following means the LLM made tool calls
              // and this is a planning message, not the final answer.
              const isLastAssistantInTurn = !entries.slice(i + 1, nextUserIdx).some(
                (ne) => ne.kind === "assistant" || ne.kind === "tool_group",
              );
              if (!isLastAssistantInTurn) {
                intermediateSet.add(i);
              } else {
                finalAssistantTurnStart.set(i, turnStart >= 0 ? turnStart : 0);
              }
            } else if (e.kind === "reasoning" || e.kind === "tool_group") {
              // These are intermediate if they're within a turn that has a final assistant after them
              // We'll mark them intermediate if there's any assistant after them before the next user
              let nextUserIdx = entries.length;
              for (let j = i + 1; j < entries.length; j++) {
                if (entries[j]?.kind === "user") { nextUserIdx = j; break; }
              }
              const hasAssistantAfter = entries.slice(i + 1, nextUserIdx).some((ne) => ne.kind === "assistant");
              if (hasAssistantAfter) {
                intermediateSet.add(i);
              }
            }
          }

          // Group consecutive intermediate entries within the same turn
          // We'll render them wrapped in WorkGroup
          const rendered: React.ReactNode[] = [];
          let i = 0;
          while (i < entries.length) {
            const entry = entries[i];
            if (!entry) { i++; continue; }
            // Capture idx by value to avoid closure-over-mutable-variable bug
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
                  <div key={idx} className={`group relative ml-auto max-w-[85%] rounded-md border bg-primary px-3 py-2 text-sm text-primary-foreground ${ringCls}`}>
                    <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span>나</span>
                      {starActive ? <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" /> : null}
                      <div className="ml-auto hidden gap-1 group-hover:flex">
                        <button className="rounded p-0.5 hover:bg-black/20" title="편집" onClick={() => setEditingEntryIdx(idx)}><Pencil className="h-3 w-3" /></button>
                        <button className="rounded p-0.5 hover:bg-black/20" title="분기" onClick={() => void onFork(idx)}><GitBranch className="h-3 w-3" /></button>
                        <button className="rounded p-0.5 hover:bg-black/20" title="즐겨찾기" onClick={() => void onToggleStar(idx)}>
                          <Star className={`h-3 w-3 ${starActive ? "fill-yellow-400 text-yellow-400" : ""}`} />
                        </button>
                      </div>
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

            // Collect a run of consecutive intermediate entries
            if (intermediateSet.has(i)) {
              const groupStart = i;
              const groupEntries: { idx: number; node: React.ReactNode }[] = [];
              while (i < entries.length && intermediateSet.has(i)) {
                const e = entries[i];
                if (!e) { i++; continue; }
                if (e.kind === "reasoning") {
                  groupEntries.push({ idx: i, node: <ReasoningCard key={idx} entry={e} /> });
                } else if (e.kind === "tool_group") {
                  groupEntries.push({ idx: i, node: <ToolGroupCard key={e.groupId} group={e} /> });
                } else if (e.kind === "assistant") {
                  groupEntries.push({ idx: i, node: (
                    <AssistantCard
                      key={idx}
                      entry={e}
                      highlightQuery={searchHighlight}
                      isStarred={!!isEntryStarred(idx)}
                      isFinal={false}
                    />
                  )});
                }
                i++;
              }
              // Determine if the group is still streaming
              const groupStreaming = groupEntries.some((ge) => {
                const e = entries[ge.idx];
                return e && (e as any).streaming === true;
              }) || (entries[i] && (entries[i] as any).streaming === true) || streaming;
              rendered.push(
                <WorkGroup key={`wg-${groupStart}`} stepCount={groupEntries.length} streaming={groupStreaming}>
                  {groupEntries.map((ge) => ge.node)}
                </WorkGroup>
              );
              continue;
            }

            // Final assistant entry
            if (entry.kind === "assistant") {
              const turnStartIdx = finalAssistantTurnStart.get(i) ?? 0;
              const turnTokens = entries
                .slice(turnStartIdx, i + 1)
                .reduce((sum, e) => {
                  if (e.kind === "assistant" || e.kind === "reasoning" || e.kind === "user") {
                    return sum + Math.ceil(((e as any).text?.length ?? 0) / 4);
                  }
                  if (e.kind === "tool_group") {
                    // Sum input JSON + result strings for all tools in the group
                    const toolSum = ((e as any).tools ?? []).reduce((ts: number, t: any) =>
                      ts + Math.ceil((JSON.stringify(t.input ?? {}).length + (t.result?.length ?? 0)) / 4), 0);
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
                  {!entry.streaming && (
                    <TurnActionBar
                      turnTokens={turnTokens}
                      isStarred={!!isEntryStarred(idx)}
                      actions={{
                        onRetry: () => void onRetryEffort(),
                        onFork: () => void onFork(idx),
                        onToggleStar: () => void onToggleStar(idx),
                      }}
                      onFeedback={onFeedback ? (rating, reason) => void onFeedback(i, rating, reason) : undefined}
                    />
                  )}
                </div>
              );
              i++;
              continue;
            }

            // reasoning/tool_group not intermediate (no final assistant after in this turn)
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
      {askQuestions.map((req) => (
        <AskUserQuestionCard
          key={req.id}
          api={workflowApi}
          request={req}
          onResolved={dismissAskQuestion}
        />
      ))}
      <SessionTodoPanel api={workflowApi} />
      <div className="border-t bg-card p-3 space-y-2">
        <div className="flex items-center justify-between gap-3 text-[11px]">
          <div className={`font-mono ${contextColor}`} title="추정 토큰 사용량 (대화 기반)">
            {usedTokens.toLocaleString()} / {contextBudget.toLocaleString()} tokens ({contextPercent}%)
          </div>
          <div className="flex items-center gap-2">
            {/* Sprint B — Role preset dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 gap-1 text-[11px]" title="역할 프리셋 선택">
                  <User className="h-3 w-3" /> {activePreset?.name ?? "기본"} <ChevronDown className="h-3 w-3 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {rolePresets.map((p) => (
                  <DropdownMenuItem key={p.id} onClick={() => setActivePresetId(p.id)}>
                    <span className={activePresetId === p.id ? "font-semibold" : ""}>{p.name}</span>
                    {p.isDefault ? null : <span className="ml-2 text-[10px] text-muted-foreground">effort: {p.effort} · t {p.temperature}</span>}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {/* Sprint B — PageIndex attach */}
            <Popover open={docPopoverOpen} onOpenChange={(o) => { setDocPopoverOpen(o); if (o) void refreshIndexedDocs(); }}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 gap-1 text-[11px]" title="문서 첨부">
                  <Paperclip className="h-3 w-3" />
                  {attachedDocs.length > 0 ? <span>{attachedDocs.length}</span> : null}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 p-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-medium">인덱싱된 문서</span>
                  <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => void refreshIndexedDocs()}>새로고침</Button>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {docsLoading ? (
                    <div className="py-6 text-center text-xs text-muted-foreground">로딩 중...</div>
                  ) : indexedDocs.length === 0 ? (
                    <div className="py-6 text-center text-xs text-muted-foreground">문서가 없습니다. PageIndex 플러그인에서 먼저 인덱싱하세요.</div>
                  ) : (
                    <div className="space-y-1">
                      {indexedDocs.map((d) => {
                        const attached = attachedDocs.some((a) => a.id === d.id);
                        return (
                          <button
                            key={d.id}
                            className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted ${attached ? "bg-muted" : ""}`}
                            onClick={() => setAttachedDocs((prev) => attached ? prev.filter((a) => a.id !== d.id) : [...prev, d])}
                          >
                            <input type="checkbox" checked={attached} readOnly className="h-3 w-3" />
                            <span className="truncate">{d.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </PopoverContent>
            </Popover>
            {/* Sprint B — Language lock toggle */}
            <Button
              variant={langLock === "off" ? "outline" : "default"}
              size="sm"
              className="h-7 gap-1 text-[11px]"
              title="응답 언어 강제"
              onClick={() => setLangLock((v) => v === "off" ? "ko" : v === "ko" ? "en" : "off")}
            >
              <Globe className="h-3 w-3" />
              {langLock === "off" ? "자동" : langLock === "ko" ? "한국어" : "English"}
            </Button>
            {vendorSupportsThinking && (
              <label className="flex items-center gap-1.5 text-muted-foreground cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5"
                  checked={enableThinkingChat}
                  onChange={(e) => void toggleThinking(e.target.checked)}
                />
                <span>Thinking</span>
              </label>
            )}
          </div>
        </div>
        {/* Sprint B — attached-doc chips */}
        {attachedDocs.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {attachedDocs.map((d) => (
              <span key={d.id} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px]">
                <span>🗎 {d.name}</span>
                <button
                  className="rounded-full p-0.5 hover:bg-background"
                  onClick={() => setAttachedDocs((prev) => prev.filter((a) => a.id !== d.id))}
                  title="첨부 해제"
                ><XIcon className="h-3 w-3" /></button>
              </span>
            ))}
          </div>
        )}
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Textarea value={question} onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
               if (e.nativeEvent.isComposing) return;
               if (e.key === "Enter" && !e.shiftKey) {
                 e.preventDefault();
                 void (streaming ? onGuide(question) : onAsk(question));
               }
             }}
            placeholder={hasApiKey === false ? "API 키를 먼저 설정해 주세요..." : streaming ? "응답 방향 지시 입력 (Enter 힌트 전송 / Shift+Enter 줄바꿈)" : "질문 입력 (Enter 전송 / Shift+Enter 줄바꿈) · /command 사용 가능"}
            className="min-h-[76px]" />
          <div className="flex flex-col items-stretch gap-1">
            {streaming
              ? <Button variant="destructive" onClick={() => void onAbort()} title="스트리밍 중단 (Ctrl/Cmd+C)"><Square className="h-4 w-4 mr-1" />중단</Button>
              : <Button onClick={handleAskCurrent} disabled={!question.trim() || contextOverflowPct >= 0.95}><Loader2 className="h-4 w-4 mr-1 hidden" />전송</Button>
            }
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={`text-center text-[11px] font-mono ${costBadgeClass}`} title="예상 비용">
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
    </div>
  );
}
