import { Search, ChevronRight, X as XIcon } from "lucide-react";
import { Input } from "../../../components/ui/input.js";

/**
 * Sprint 4.C: Ctrl/Cmd+F overlay for in-conversation search. Scans
 * user + assistant entries. Parent owns the query state so message
 * rendering can re-highlight matches.
 */
export function ChatSearchOverlay({
  open,
  query,
  caseSensitive,
  matchCount,
  currentIdx,
  onChangeQuery,
  onToggleCase,
  onNext,
  onPrev,
  onClose,
}: {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  matchCount: number;
  currentIdx: number;
  onChangeQuery: (v: string) => void;
  onToggleCase: () => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="absolute right-4 top-2 z-20 flex items-center gap-2 rounded-md border bg-card px-2 py-1 shadow-md">
      <Search className="h-3.5 w-3.5 text-muted-foreground" />
      <Input
        autoFocus
        value={query}
        onChange={(e) => onChangeQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); if (e.shiftKey) onPrev(); else onNext(); }
          if (e.key === "Escape") { e.preventDefault(); onClose(); }
        }}
        placeholder="대화 검색..."
        className="h-7 w-48 text-xs"
      />
      <span className="text-[10px] text-muted-foreground tabular-nums">{matchCount === 0 ? "0/0" : `${currentIdx + 1}/${matchCount}`}</span>
      <button
        className={`rounded px-1 text-[10px] ${caseSensitive ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
        onClick={onToggleCase}
        title="대소문자 구분"
      >Aa</button>
      <button className="rounded p-0.5 hover:bg-muted" onClick={onPrev} title="이전"><ChevronRight className="h-3 w-3 rotate-180" /></button>
      <button className="rounded p-0.5 hover:bg-muted" onClick={onNext} title="다음"><ChevronRight className="h-3 w-3" /></button>
      <button className="rounded p-0.5 hover:bg-muted" onClick={onClose} title="닫기"><XIcon className="h-3 w-3" /></button>
    </div>
  );
}
