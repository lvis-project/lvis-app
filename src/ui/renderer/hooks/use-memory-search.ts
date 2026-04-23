import { useCallback, useEffect, useRef, useState } from "react";
import type { LvisApi } from "../types.js";

export interface NoteResult {
  title: string;
  excerpt: string;
  updatedAt: string;
}

export interface SessionResult {
  sessionId: string;
  matchedMessage: string;
  timestamp: string;
}

/**
 * D5 — memory search hook.
 *
 * Debounces query (200 ms), fires IPC calls, guards post-unmount setState
 * with aliveRef pattern (matching use-briefing.ts).
 */
export function useMemorySearch(api: LvisApi) {
  const [query, setQuery] = useState("");
  const [noteResults, setNoteResults] = useState<NoteResult[]>([]);
  const [sessionResults, setSessionResults] = useState<SessionResult[]>([]);
  const [loading, setLoading] = useState(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (!aliveRef.current) return;
      setLoading(true);
      try {
        const [notes, sessions] = await Promise.all([
          api.memorySearchEntries(query),
          api.memorySearchSessions(query),
        ]);
        if (!aliveRef.current) return;
        setNoteResults(notes ?? []);
        setSessionResults(sessions ?? []);
      } catch {
        if (!aliveRef.current) return;
        setNoteResults([]);
        setSessionResults([]);
      } finally {
        if (aliveRef.current) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [query, api]);

  const reset = useCallback(() => {
    setQuery("");
    setNoteResults([]);
    setSessionResults([]);
  }, []);

  return { query, setQuery, noteResults, sessionResults, loading, reset };
}
