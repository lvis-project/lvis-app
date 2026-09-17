import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import {
  DEFAULT_PROCESSING_DISPLAY_LEVEL,
  type ProcessingDisplayLevel,
} from "../../../shared/processing-display-level.js";
import { classifyTurnEntries } from "../utils/classify-turn-entries.js";
import { shouldShowAssistantEntry } from "../utils/processing-display-policy.js";

interface SearchVisibility {
  processingDisplayLevel?: ProcessingDisplayLevel;
  streaming?: boolean;
}

/**
 * Unified search hook.
 *
 * Owns: Ctrl/Cmd+F open state, query + case toggle, current-conversation
 * match index list, and navigation callbacks. Global keydown listener
 * registers on mount / cleans up on unmount.
 */
export function useSearch(
  entries: ChatEntry[],
  {
    processingDisplayLevel = DEFAULT_PROCESSING_DISPLAY_LEVEL,
    streaming = false,
  }: SearchVisibility = {},
) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [matchIdx, setMatchIdx] = useState(0);

  // Ctrl/Cmd+F opens the unified search surface.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const matches = useMemo(() => {
    if (!query) return [] as number[];
    const q = caseSensitive ? query : query.toLowerCase();
    const hits: number[] = [];
    const { entryClassMap, entryTurnStartMap, lastTurnStartIdx } = classifyTurnEntries(entries, streaming);
    entries.forEach((e, i) => {
      if (e.kind !== "user" && e.kind !== "assistant" && e.kind !== "reasoning") return;
      if (e.kind === "reasoning" && processingDisplayLevel === "tools") return;
      // Active reasoning and the transient provider-status row intentionally
      // render only through the WorkGroup header, which has no entry-index
      // navigation target. Do not offer search results that cannot be focused.
      if (
        streaming
        && entryClassMap.get(i) === "intermediate"
        && entryTurnStartMap.get(i) === lastTurnStartIdx
        && (e.kind === "reasoning" || (e.kind === "assistant" && e.phase === "status"))
      ) return;
      if (
        e.kind === "assistant"
        && !shouldShowAssistantEntry(e, entryClassMap.get(i), processingDisplayLevel)
      ) return;
      const t = caseSensitive ? e.text : e.text.toLowerCase();
      if (t.includes(q)) hits.push(i);
    });
    return hits;
  }, [caseSensitive, entries, processingDisplayLevel, query, streaming]);

  // O(1) membership check for per-entry highlight in the big render loop.
  const matchSet = useMemo(() => new Set(matches), [matches]);

  useEffect(() => {
    if (matchIdx >= matches.length) setMatchIdx(0);
  }, [matches, matchIdx]);

  const highlight = open ? query : "";

  const changeQuery = useCallback((v: string) => {
    setQuery(v);
    setMatchIdx(0);
  }, []);

  const toggleCase = useCallback(() => setCaseSensitive((v) => !v), []);

  const openOverlay = useCallback(() => setOpen(true), []);
  const toggleOverlay = useCallback(() => setOpen((v) => !v), []);
  const closeOverlay = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  const nextMatch = useCallback(() => {
    setMatchIdx((i) => (matches.length === 0 ? 0 : (i + 1) % matches.length));
  }, [matches.length]);

  const prevMatch = useCallback(() => {
    setMatchIdx((i) => (matches.length === 0 ? 0 : (i - 1 + matches.length) % matches.length));
  }, [matches.length]);

  const jumpToMatch = useCallback((index: number) => {
    if (matches.length === 0) {
      setMatchIdx(0);
      return;
    }
    const next = Math.max(0, Math.min(index, matches.length - 1));
    setMatchIdx(next);
    setOpen(true);
  }, [matches.length]);

  return {
    open,
    query,
    caseSensitive,
    matches,
    matchSet,
    matchIdx,
    highlight,
    changeQuery,
    toggleCase,
    openOverlay,
    toggleOverlay,
    closeOverlay,
    nextMatch,
    prevMatch,
    jumpToMatch,
  };
}
