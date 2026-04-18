import { useCallback, type RefObject } from "react";
import type React from "react";
import { ChevronDown, Globe, KeyRound, Loader2, Paperclip, Pencil, Star, User, X as XIcon, GitBranch } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover.js";
import { Button } from "../../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card.js";
import { Textarea } from "../../components/ui/textarea.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip.js";
import { ScrollArea } from "../../components/ui/scroll-area.js";
import type { RolePreset } from "../../data/role-presets.js";
import { formatCostBadge, type EstimateBreakdown } from "../../lib/cost-estimator.js";
import type { ChatEntry } from "../../lib/chat-stream-state.js";
import { BriefingCard } from "./components/BriefingCard.js";
import { AssistantCard } from "./components/AssistantCard.js";
import { UserMessageEditor } from "./components/UserMessageEditor.js";
import { ReasoningCard } from "./components/ReasoningCard.js";
import { ToolGroupCard } from "./components/ToolGroupCard.js";
import { ChatSearchOverlay } from "./components/ChatSearchOverlay.js";
import { highlightText } from "./utils/html-preview.js";
import type { BriefingPayload } from "./types.js";

export interface ChatViewProps {
  // Chat state
  entries: ChatEntry[];
  streaming: boolean;
  editingEntryIdx: number | null;
  setEditingEntryIdx: (i: number | null) => void;
  editBusy: boolean;
  question: string;
  setQuestion: (q: string) => void;
  chatEndRef: RefObject<HTMLDivElement | null>;

  // API state
  hasApiKey: boolean | null;
  onOpenSettings: () => void;

  // Briefing
  briefing: BriefingPayload | null;
  onDismissBriefing: (feedback?: { reason: string; details?: string }) => void;
  onSnoozeBriefing: () => void;

  // Search
  searchOpen: boolean;
  searchQuery: string;
  searchCase: boolean;
  searchMatches: number[];
  searchMatchSet: Set<number>;
  searchIdx: number;
  searchHighlight: string;
  searchChangeQuery: (q: string) => void;
  searchToggleCase: () => void;
  searchNext: () => void;
  searchPrev: () => void;
  searchCloseOverlay: () => void;

  // Context / usage
  contextOverflowPct: number;
  usedTokens: number;
  contextBudget: number;
  contextPercent: number;
  contextColor: string;

  // Role presets
  rolePresets: RolePreset[];
  activePreset: RolePreset | null;
  activePresetId: string;
  setActivePresetId: (id: string) => void;

  // Attached docs / PageIndex
  attachedDocs: Array<{ id: string; name: string }>;
  setAttachedDocs: React.Dispatch<React.SetStateAction<Array<{ id: string; name: string }>>>;
  docPopoverOpen: boolean;
  setDocPopoverOpen: (v: boolean) => void;
  indexedDocs: Array<{ id: string; name: string }>;
  docsLoading: boolean;
  refreshIndexedDocs: () => void | Promise<void>;

  // Language lock
  langLock: "off" | "ko" | "en";
  setLangLock: React.Dispatch<React.SetStateAction<"off" | "ko" | "en">>;

  // Thinking toggle
  vendorSupportsThinking: boolean;
  enableThinkingChat: boolean;
  toggleThinking: (v: boolean) => Promise<void> | void;

  // Cost
  costEstimate: EstimateBreakdown;
  costBadgeClass: string;

  // Handlers
  onAsk: (q: string) => void | Promise<void>;
  onEditSave: (idx: number, text: string) => void | Promise<void>;
  onFork: (idx: number) => void | Promise<void>;
  onToggleStar: (idx: number) => void | Promise<void>;
  onRetryEffort: () => void | Promise<void>;
  isEntryStarred: (idx: number) => string | null;
}

export function ChatView(props: ChatViewProps) {
  const {
    entries, streaming, editingEntryIdx, setEditingEntryIdx, editBusy,
    question, setQuestion, chatEndRef,
    hasApiKey, onOpenSettings,
    briefing, onDismissBriefing, onSnoozeBriefing,
    searchOpen, searchQuery, searchCase, searchMatches, searchMatchSet, searchIdx, searchHighlight,
    searchChangeQuery, searchToggleCase, searchNext, searchPrev, searchCloseOverlay,
    contextOverflowPct, usedTokens, contextBudget, contextPercent, contextColor,
    rolePresets, activePreset, activePresetId, setActivePresetId,
    attachedDocs, setAttachedDocs, docPopoverOpen, setDocPopoverOpen,
    indexedDocs, docsLoading, refreshIndexedDocs,
    langLock, setLangLock,
    vendorSupportsThinking, enableThinkingChat, toggleThinking,
    costEstimate, costBadgeClass,
    onAsk, onEditSave, onFork, onToggleStar, onRetryEffort, isEntryStarred,
  } = props;

  const handleAskCurrent = useCallback(() => { void onAsk(question); }, [onAsk, question]);

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
      <ScrollArea className="h-full p-4"><div className="space-y-3">
        {briefing && (
          <BriefingCard
            briefing={briefing}
            onDismiss={onDismissBriefing}
            onSnooze={onSnoozeBriefing}
          />
        )}
        {entries.length === 0 && hasApiKey !== false && <div className="py-12 text-center text-sm text-muted-foreground">LVIS 에이전트가 준비되었습니다. 질문을 입력하거나 /command를 사용하세요.</div>}
        {entries.map((entry, idx) => {
          const isMatch = searchMatchSet.has(idx);
          const isCurrentMatch = searchOpen && searchMatches[searchIdx] === idx;
          const ringCls = isCurrentMatch ? "ring-2 ring-primary" : isMatch ? "ring-1 ring-primary/40" : "";
          if (entry.kind === "user") {
            if (editingEntryIdx === idx) {
              return (
                <UserMessageEditor
                  key={idx}
                  initialText={entry.text}
                  busy={editBusy}
                  onCancel={() => setEditingEntryIdx(null)}
                  onSave={(next) => void onEditSave(idx, next)}
                />
              );
            }
            const starId = isEntryStarred(idx);
            const starActive = !!starId;
            return (
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
          if (entry.kind === "reasoning") return <ReasoningCard key={idx} entry={entry} />;
          if (entry.kind === "tool_group") return <ToolGroupCard key={entry.groupId} group={entry} />;
          if (entry.kind === "system") return <div key={idx} className="mx-auto text-center text-xs text-muted-foreground py-1 px-3 rounded-full bg-muted/50">{entry.text}</div>;
          return (
            <div key={idx} className={`${ringCls} rounded-md`}>
              <AssistantCard
                entry={entry}
                highlightQuery={searchHighlight}
                isStarred={!!isEntryStarred(idx)}
                actions={{
                  onRetry: () => void onRetryEffort(),
                  onFork: () => void onFork(idx),
                  onToggleStar: () => void onToggleStar(idx),
                }}
              />
            </div>
          );
        })}
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
                void onAsk(question);
              }
            }}
            placeholder={hasApiKey === false ? "API 키를 먼저 설정해 주세요..." : "질문 입력 (Enter 전송 / Shift+Enter 줄바꿈) · /command 사용 가능"}
            className="min-h-[76px]" disabled={streaming} />
          <div className="flex flex-col items-stretch gap-1">
            <Button onClick={handleAskCurrent} disabled={streaming || !question.trim() || contextOverflowPct >= 0.95}>{streaming ? <Loader2 className="h-4 w-4 animate-spin" /> : "전송"}</Button>
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
