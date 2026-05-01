import { useEffect, useState } from "react";
import { BookMarked, MessageSquare, Star } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../../components/ui/dialog.js";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../../../components/ui/command.js";
import { highlightText } from "../utils/html-preview.js";
import type { LvisApi } from "../types.js";
import type { StarredItem } from "../hooks/use-starred.js";
import type { SessionSummary } from "../hooks/use-sessions.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface MemoryEntry {
  filename: string;
  title: string;
  excerpt: string;
  updatedAt: string;
}

export interface GlobalSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: LvisApi;
  sessions: SessionSummary[];
  starred: StarredItem[];
  onLoadSession: (sessionId: string) => void | Promise<void>;
  onOpenMemoryView?: () => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function matchesQuery(text: string, query: string): boolean {
  if (!query) return true;
  return text.toLowerCase().includes(query.toLowerCase());
}

// ── Component ────────────────────────────────────────────────────────────────

export function GlobalSearchDialog({
  open,
  onOpenChange,
  api,
  sessions,
  starred,
  onLoadSession,
  onOpenMemoryView,
}: GlobalSearchDialogProps) {
  const [query, setQuery] = useState("");
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [memoriesLoading, setMemoriesLoading] = useState(false);

  // Trim once so IPC calls and local filters both use the same value.
  const trimmedQuery = query.trim();

  // Load memories when dialog opens or query changes.
  // Debounce 200 ms to avoid a new IPC request on every keystroke, then use
  // a `cancelled` flag to discard responses from superseded requests (IPC
  // calls can resolve out-of-order when the query changes rapidly).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setMemoriesLoading(true);
    const timer = setTimeout(() => {
      const fetch = trimmedQuery
        ? api.memorySearchEntries(trimmedQuery).then((results) =>
            results.map((r) => ({
              filename: r.filename ?? r.title,
              title: r.title,
              excerpt: r.excerpt,
              updatedAt: r.updatedAt,
            })),
          )
        : api.memoryListEntries().then((entries) =>
            entries.map((e) => ({
              filename: e.filename,
              title: e.title,
              excerpt: e.content?.slice(0, 120) ?? "",
              updatedAt: e.updatedAt ?? "",
            })),
          );
      fetch
        .then((entries) => { if (!cancelled) setMemories(entries); })
        .catch(() => { if (!cancelled) setMemories([]); })
        .finally(() => { if (!cancelled) setMemoriesLoading(false); });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, trimmedQuery, api]);

  // Filter sessions and starred locally (they are already in-memory).
  const filteredSessions = sessions.filter((s) =>
    matchesQuery(s.title || "제목 없는 세션", trimmedQuery),
  );

  // Starred items: deduplicate by sessionId so each session appears at most
  // once. When a session has multiple starred messages the first match wins.
  // (Session-level stars have messageIndex === -1 and are always unique per
  // session, but message-level stars can accumulate multiple entries for the
  // same session across different messageIndexes.)
  const filteredStarred = (() => {
    const seen = new Map<string, StarredItem>();
    for (const s of starred) {
      if (matchesQuery(s.text || "", trimmedQuery) && !seen.has(s.sessionId)) {
        seen.set(s.sessionId, s);
      }
    }
    return [...seen.values()];
  })();

  const handleClose = () => {
    onOpenChange(false);
    setQuery("");
    setMemories([]);
    setMemoriesLoading(false);
  };

  const handleSelectMemory = () => {
    handleClose();
    if (onOpenMemoryView) {
      onOpenMemoryView();
    }
  };

  const handleSelectSession = (sessionId: string) => {
    handleClose();
    void onLoadSession(sessionId);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) handleClose(); else onOpenChange(true); }}>
      <DialogContent className="max-w-xl p-0" data-testid="global-search-dialog">
        <DialogHeader className="sr-only">
          <DialogTitle>전체 검색</DialogTitle>
          <DialogDescription>메모리, 세션, 즐겨찾기를 통합 검색합니다.</DialogDescription>
        </DialogHeader>
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="전체 검색..."
            value={query}
            onValueChange={setQuery}
            data-testid="global-search-input"
          />
          <CommandList className="max-h-[420px]">
            {/* ── Memory section ─────────────────────────────────────── */}
            {(memoriesLoading || memories.length > 0) && (
              <CommandGroup
                heading={memoriesLoading ? "메모리 (로딩 중...)" : "메모리"}
                data-testid="global-search-group-memory"
              >
                {memoriesLoading ? (
                  <CommandItem disabled value="__memories-loading__">
                    <span className="text-xs text-muted-foreground">로딩 중...</span>
                  </CommandItem>
                ) : (
                  memories.map((m, idx) => (
                    <CommandItem
                      key={m.filename || `m-${idx}`}
                      value={`memory:${m.filename || idx}`}
                      onSelect={handleSelectMemory}
                    >
                      <BookMarked className="mr-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">
                          {highlightText(m.title, trimmedQuery) ?? m.title}
                        </div>
                        {m.excerpt && (
                          <div className="truncate text-[11px] text-muted-foreground">
                            {highlightText(m.excerpt, trimmedQuery) ?? m.excerpt}
                          </div>
                        )}
                      </div>
                    </CommandItem>
                  ))
                )}
              </CommandGroup>
            )}

            {/* ── Sessions section ────────────────────────────────────── */}
            {filteredSessions.length > 0 && (
              <CommandGroup heading="세션" data-testid="global-search-group-sessions">
                {filteredSessions.map((s) => (
                  <CommandItem
                    key={s.id}
                    value={`session:${s.id}`}
                    onSelect={() => handleSelectSession(s.id)}
                  >
                    <MessageSquare className="mr-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">
                        {highlightText(s.title || "제목 없는 세션", trimmedQuery) ?? (s.title || "제목 없는 세션")}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {new Date(s.modifiedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
                      </div>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {/* ── Starred section ─────────────────────────────────────── */}
            {filteredStarred.length > 0 && (
              <CommandGroup heading="즐겨찾기" data-testid="global-search-group-starred">
                {filteredStarred.map((s) => (
                  <CommandItem
                    key={s.id}
                    value={`starred:${s.id}`}
                    onSelect={() => handleSelectSession(s.sessionId)}
                  >
                    <Star className="mr-2 h-3.5 w-3.5 shrink-0 text-yellow-400" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">
                        {highlightText(s.text, trimmedQuery) ?? s.text}
                      </div>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {/* ── Empty state ─────────────────────────────────────────── */}
            {!memoriesLoading &&
              memories.length === 0 &&
              filteredSessions.length === 0 &&
              filteredStarred.length === 0 && (
                <CommandEmpty>
                  {query ? "검색 결과가 없습니다." : "저장된 항목이 없습니다."}
                </CommandEmpty>
              )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
