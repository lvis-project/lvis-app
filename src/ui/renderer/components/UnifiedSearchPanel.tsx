import { useEffect, useMemo, useState } from "react";
import type React from "react";
import { BookMarked, Clock3, FileText, Repeat2, Search, Star, X } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Badge } from "../../../components/ui/badge.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import type { RoutineRecord } from "../../../shared/routines-types.js";
import type { StarredItem } from "../hooks/use-starred.js";
import type { SessionSummary } from "../hooks/use-sessions.js";
import { useMemorySearch } from "../hooks/use-memory-search.js";
import type { LvisApi } from "../types.js";
import { highlightText } from "../utils/html-preview.js";

type ConversationMatch = {
  entryIndex: number;
  matchIndex: number;
  role: "사용자" | "어시스턴트";
  text: string;
};

export interface UnifiedSearchPanelProps {
  api: LvisApi;
  open: boolean;
  query: string;
  caseSensitive: boolean;
  entries: ChatEntry[];
  conversationMatches: number[];
  currentConversationMatch: number;
  sessions: SessionSummary[];
  starred: StarredItem[];
  onChangeQuery: (value: string) => void;
  onToggleCase: () => void;
  onNextConversationMatch: () => void;
  onPrevConversationMatch: () => void;
  onJumpToConversationMatch: (matchIndex: number) => void;
  onOpen: () => void;
  onClose: () => void;
  onLoadSession: (sessionId: string) => void | Promise<void>;
  onOpenMemoryView: () => void;
  onOpenRoutinesView: () => void;
}

function includesQuery(text: string, query: string, caseSensitive: boolean): boolean {
  if (!query) return true;
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  return haystack.includes(needle);
}

function previewText(text: string, max = 180): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function routineTitle(routine: RoutineRecord): string {
  return (
    routine.title?.trim() ||
    routine.notificationTitle?.trim() ||
    routine.prePrompt?.trim().slice(0, 42) ||
    routine.id.slice(0, 8)
  );
}

function routineBody(routine: RoutineRecord): string {
  return [
    routine.prePrompt,
    routine.notificationBody,
    routine.execution === "llm-session" ? "LLM 세션" : "알림",
    routine.id,
  ].filter(Boolean).join(" ");
}

export function UnifiedSearchPanel({
  api,
  open,
  query,
  caseSensitive,
  entries,
  conversationMatches,
  currentConversationMatch,
  sessions,
  starred,
  onChangeQuery,
  onToggleCase,
  onNextConversationMatch,
  onPrevConversationMatch,
  onJumpToConversationMatch,
  onOpen,
  onClose,
  onLoadSession,
  onOpenMemoryView,
  onOpenRoutinesView,
}: UnifiedSearchPanelProps) {
  const [routines, setRoutines] = useState<RoutineRecord[]>([]);
  const [routinesLoading, setRoutinesLoading] = useState(false);
  const {
    setQuery: setMemoryQuery,
    noteResults,
    sessionResults,
    loading: memoryLoading,
    reset: resetMemorySearch,
  } = useMemorySearch(api);

  const trimmedQuery = query.trim();

  useEffect(() => {
    setMemoryQuery(query);
  }, [query, setMemoryQuery]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setRoutinesLoading(true);
    void api.listRoutinesV2()
      .then((list) => {
        if (alive) setRoutines(list ?? []);
      })
      .catch(() => {
        if (alive) setRoutines([]);
      })
      .finally(() => {
        if (alive) setRoutinesLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [api, open]);

  const conversationResults = useMemo<ConversationMatch[]>(
    () =>
      conversationMatches
        .map((entryIndex, matchIndex) => {
          const entry = entries[entryIndex];
          if (!entry || (entry.kind !== "user" && entry.kind !== "assistant")) return null;
          return {
            entryIndex,
            matchIndex,
            role: entry.kind === "user" ? "사용자" : "어시스턴트",
            text: entry.text,
          } satisfies ConversationMatch;
        })
        .filter((item): item is ConversationMatch => item !== null)
        .slice(0, 8),
    [conversationMatches, entries],
  );

  const sessionResultsByTitle = useMemo(
    () =>
      sessions
        .filter((session) => includesQuery(session.title || "제목 없는 세션", trimmedQuery, caseSensitive))
        .slice(0, 8),
    [caseSensitive, sessions, trimmedQuery],
  );

  const starredResults = useMemo(() => {
    const seen = new Set<string>();
    const filtered: StarredItem[] = [];
    for (const item of starred) {
      if (!includesQuery(item.text || "", trimmedQuery, caseSensitive)) continue;
      const key = item.messageIndex === -1 ? `session:${item.sessionId}` : item.id;
      if (seen.has(key)) continue;
      seen.add(key);
      filtered.push(item);
      if (filtered.length >= 8) break;
    }
    return filtered;
  }, [caseSensitive, starred, trimmedQuery]);

  const routineResults = useMemo(
    () =>
      routines
        .filter((routine) =>
          includesQuery(`${routineTitle(routine)} ${routineBody(routine)}`, trimmedQuery, caseSensitive)
        )
        .slice(0, 8),
    [caseSensitive, routines, trimmedQuery],
  );

  const noResults =
    !memoryLoading &&
    !routinesLoading &&
    conversationResults.length === 0 &&
    sessionResults.length === 0 &&
    sessionResultsByTitle.length === 0 &&
    starredResults.length === 0 &&
    routineResults.length === 0 &&
    noteResults.length === 0;

  const handleClose = () => {
    resetMemorySearch();
    onClose();
  };

  const handleLoadSession = (sessionId: string) => {
    void onLoadSession(sessionId);
    handleClose();
  };

  return (
    <div
      className={`border-b bg-card/95 px-3 shadow-sm backdrop-blur transition-[padding] ${
        open ? "py-2" : "py-1.5"
      }`}
      data-testid="unified-search-panel"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <Input
            value={query}
            onFocus={onOpen}
            onChange={(event) => onChangeQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (event.shiftKey) onPrevConversationMatch();
                else onNextConversationMatch();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                handleClose();
              }
            }}
            placeholder="대화·세션·즐겨찾기·루틴·메모리 검색..."
            aria-label="통합 검색"
            data-testid="unified-search-input"
            className="h-8 min-w-0 flex-1 bg-background text-sm"
            autoFocus={open}
          />
          <span className="shrink-0 rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">
            {conversationMatches.length > 0
              ? `${currentConversationMatch + 1}/${conversationMatches.length}`
              : "0/0"}
          </span>
          <Button
            type="button"
            variant={caseSensitive ? "default" : "ghost"}
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={onToggleCase}
            title="대소문자 구분"
            aria-label="대소문자 구분"
          >
            Aa
          </Button>
          <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleClose} title="검색 닫기">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        {open && (
          <div
            className="max-h-[min(42dvh,360px)] overflow-y-auto rounded-md border bg-background/95"
            data-testid="unified-search-results"
          >
            <SearchSection
              title="현재 대화"
              count={conversationResults.length}
              icon={<Search className="h-3.5 w-3.5" />}
            >
              {conversationResults.map((result) => (
                <SearchResultButton
                  key={`${result.entryIndex}:${result.matchIndex}`}
                  label={`${result.role} · #${result.entryIndex + 1}`}
                  meta="현재 세션"
                  onClick={() => onJumpToConversationMatch(result.matchIndex)}
                >
                  {highlightText(previewText(result.text), trimmedQuery, { caseSensitive }) ?? previewText(result.text)}
                </SearchResultButton>
              ))}
            </SearchSection>

            <SearchSection
              title="대화 기록"
              count={sessionResults.length + sessionResultsByTitle.length}
              icon={<Clock3 className="h-3.5 w-3.5" />}
            >
              {sessionResults.map((session) => (
                <SearchResultButton
                  key={`memory-session:${session.sessionId}:${session.timestamp}`}
                  label={`대화 내용 · ${new Date(session.timestamp).toLocaleString("ko-KR")}`}
                  meta={session.sessionId.slice(0, 8)}
                  onClick={() => handleLoadSession(session.sessionId)}
                >
                  {highlightText(previewText(session.matchedMessage), trimmedQuery, { caseSensitive }) ?? previewText(session.matchedMessage)}
                </SearchResultButton>
              ))}
              {sessionResultsByTitle.map((session) => (
                <SearchResultButton
                  key={`session-title:${session.id}`}
                  label="세션 제목"
                  meta={new Date(session.modifiedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
                  onClick={() => handleLoadSession(session.id)}
                >
                  {highlightText(session.title || "제목 없는 세션", trimmedQuery, { caseSensitive }) ?? (session.title || "제목 없는 세션")}
                </SearchResultButton>
              ))}
            </SearchSection>

            <SearchSection
              title="즐겨찾기"
              count={starredResults.length}
              icon={<Star className="h-3.5 w-3.5" />}
            >
              {starredResults.map((item) => (
                <SearchResultButton
                  key={`starred:${item.id}`}
                  label={item.messageIndex === -1 ? "세션 즐겨찾기" : "메시지 즐겨찾기"}
                  meta={new Date(item.starredAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
                  onClick={() => handleLoadSession(item.sessionId)}
                >
                  {highlightText(previewText(item.text), trimmedQuery, { caseSensitive }) ?? previewText(item.text)}
                </SearchResultButton>
              ))}
            </SearchSection>

            <SearchSection
              title="루틴"
              count={routineResults.length}
              icon={<Repeat2 className="h-3.5 w-3.5" />}
              loading={routinesLoading}
            >
              {routineResults.map((routine) => (
                <SearchResultButton
                  key={`routine:${routine.id}`}
                  label={routine.execution === "llm-session" ? "LLM 루틴" : "알림 루틴"}
                  meta={routine.lastFiredAt ? new Date(routine.lastFiredAt).toLocaleString("ko-KR") : routine.id.slice(0, 8)}
                  onClick={onOpenRoutinesView}
                >
                  <span className="font-medium">{highlightText(routineTitle(routine), trimmedQuery, { caseSensitive }) ?? routineTitle(routine)}</span>
                  {routineBody(routine) ? (
                    <span className="ml-2 text-muted-foreground">
                      {highlightText(previewText(routineBody(routine), 96), trimmedQuery, { caseSensitive }) ?? previewText(routineBody(routine), 96)}
                    </span>
                  ) : null}
                </SearchResultButton>
              ))}
            </SearchSection>

            <SearchSection
              title="메모리"
              count={noteResults.length}
              icon={<BookMarked className="h-3.5 w-3.5" />}
              loading={memoryLoading}
            >
              {noteResults.slice(0, 8).map((note, index) => (
                <SearchResultButton
                  key={`note:${note.title}:${index}`}
                  label={note.title}
                  meta={note.updatedAt ? new Date(note.updatedAt).toLocaleString("ko-KR") : "메모리"}
                  onClick={onOpenMemoryView}
                >
                  {highlightText(previewText(note.excerpt ?? ""), trimmedQuery, { caseSensitive }) ?? previewText(note.excerpt ?? "")}
                </SearchResultButton>
              ))}
            </SearchSection>

            {noResults && (
              <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                {trimmedQuery ? "검색 결과가 없습니다." : "검색할 항목이 없습니다."}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SearchSection({
  title,
  count,
  icon,
  loading,
  children,
}: {
  title: string;
  count: number;
  icon: React.ReactNode;
  loading?: boolean;
  children: React.ReactNode;
}) {
  if (!loading && count === 0) return null;
  return (
    <section className="border-b last:border-b-0" data-testid={`unified-search-section-${title}`}>
      <div className="flex items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground">
        {icon}
        <span>{title}</span>
        <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
          {loading ? "검색 중" : count}
        </Badge>
      </div>
      <div className="pb-1">{children}</div>
    </section>
  );
}

function SearchResultButton({
  label,
  meta,
  onClick,
  children,
}: {
  label: string;
  meta?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-start gap-2 px-3 py-2 text-left hover:bg-muted/70"
      onClick={onClick}
    >
      <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[11px] font-medium text-muted-foreground">{label}</span>
          {meta ? <span className="truncate text-[10px] text-muted-foreground/70">{meta}</span> : null}
        </span>
        <span className="mt-0.5 block min-w-0 text-xs text-foreground [overflow-wrap:anywhere]">{children}</span>
      </span>
    </button>
  );
}
