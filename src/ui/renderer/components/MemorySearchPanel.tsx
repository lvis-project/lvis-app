import { useState } from "react";
import { Input } from "../../../components/ui/input.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../../components/ui/tabs.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { useMemorySearch, type NoteResult, type SessionResult } from "../hooks/use-memory-search.js";
import type { LvisApi } from "../types.js";

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "방금 전";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  return `${days}일 전`;
}

function NoteRow({ note }: { note: NoteResult }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      className="w-full text-left px-3 py-2 rounded hover:bg-muted/50 transition-colors border-b border-border/50 last:border-0"
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{note.title}</span>
        {note.updatedAt ? (
          <span className="text-[10px] text-muted-foreground shrink-0">{relativeTime(note.updatedAt)}</span>
        ) : null}
      </div>
      <p className={`text-xs text-muted-foreground mt-0.5 ${expanded ? "whitespace-pre-wrap break-words" : "truncate"}`}>
        {note.excerpt}
      </p>
    </button>
  );
}

function SessionRow({ session }: { session: SessionResult }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      className="w-full text-left px-3 py-2 rounded hover:bg-muted/50 transition-colors border-b border-border/50 last:border-0"
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">{session.sessionId.slice(0, 8)}</span>
        <span className="text-[10px] text-muted-foreground shrink-0">{relativeTime(session.timestamp)}</span>
      </div>
      <p className={`text-xs text-muted-foreground mt-0.5 ${expanded ? "whitespace-pre-wrap break-words" : "truncate"}`}>
        {session.matchedMessage}
      </p>
    </button>
  );
}

export interface MemorySearchPanelProps {
  api: LvisApi;
}

export function MemorySearchPanel({ api }: MemorySearchPanelProps) {
  const { query, setQuery, noteResults, sessionResults, loading } = useMemorySearch(api);

  return (
    <Card className="mx-auto flex min-h-0 min-w-0 flex-1 w-full max-w-6xl flex-col overflow-hidden">
      <CardHeader className="pb-4">
        <CardTitle>메모리</CardTitle>
        <CardDescription>저장된 메모와 세션을 검색하거나 전체 목록으로 확인합니다.</CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <Input
          placeholder="메모리 검색… (비워두면 전체 목록)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="text-sm"
          aria-label="메모리 검색"
        />
        <Tabs defaultValue="notes" className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TabsList className="w-full">
            <TabsTrigger value="notes" className="flex-1">
              메모{noteResults.length > 0 ? ` (${noteResults.length})` : ""}
            </TabsTrigger>
            <TabsTrigger value="sessions" className="flex-1">
              세션{sessionResults.length > 0 ? ` (${sessionResults.length})` : ""}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="notes" className="mt-2 flex-1 min-h-0 overflow-hidden">
            <ScrollArea className="h-full pr-2">
              {loading ? (
                <p className="px-3 py-4 text-xs text-muted-foreground">검색 중…</p>
              ) : noteResults.length === 0 ? (
                <p className="px-3 py-4 text-xs text-muted-foreground">
                  {query === "" ? "저장된 메모가 없습니다" : "결과 없음"}
                </p>
              ) : (
                noteResults.map((n) => <NoteRow key={n.title + n.updatedAt} note={n} />)
              )}
            </ScrollArea>
          </TabsContent>
          <TabsContent value="sessions" className="mt-2 flex-1 min-h-0 overflow-hidden">
            <ScrollArea className="h-full pr-2">
              {loading ? (
                <p className="px-3 py-4 text-xs text-muted-foreground">검색 중…</p>
              ) : sessionResults.length === 0 ? (
                <p className="px-3 py-4 text-xs text-muted-foreground">
                  {query === "" ? "저장된 세션이 없습니다" : "결과 없음"}
                </p>
              ) : (
                sessionResults.map((s) => <SessionRow key={s.sessionId + s.timestamp} session={s} />)
              )}
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
