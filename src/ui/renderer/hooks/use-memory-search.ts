import { useCallback, useEffect, useRef, useState } from "react";
import type { LvisApi } from "../types.js";

export interface NoteResult {
  title: string;
  excerpt: string;
  updatedAt?: string;
  filename?: string;
}

export interface SessionResult {
  sessionId: string;
  title?: string;
  matchedMessage: string;
  timestamp: string;
}

function stripTopHeading(content: string): string {
  return content.replace(/^#\s+.+(?:\r?\n)+/m, "").trim();
}

function memoryIndexResult(content: string | undefined, query = ""): NoteResult[] {
  const trimmed = content?.trim() ?? "";
  if (!trimmed) return [];
  if (query.trim() && !trimmed.toLowerCase().includes(query.trim().toLowerCase())) return [];
  return [{
    filename: "MEMORY.md",
    title: "메모리 인덱스",
    excerpt: stripTopHeading(trimmed),
  }];
}

/**
 * Memory search hook.
 *
 * Debounces query (200 ms), fires IPC calls, guards post-unmount setState
 * with aliveRef pattern.
 */
export function useMemorySearch(api: LvisApi) {
  const [query, setQuery] = useState("");
  const [noteCatalog, setNoteCatalog] = useState<NoteResult[]>([]);
  const [sessionCatalog, setSessionCatalog] = useState<SessionResult[]>([]);
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
    void (async () => {
      setLoading(true);
      try {
        const [memoryIndex, notes, sessions] = await Promise.all([
          api.memoryGetIndex(),
          api.memoryListEntries(),
          api.memoryListSessions(),
        ]);
        if (!aliveRef.current) return;
        const mappedNotes = (notes ?? []).map((note) => ({
          filename: note.filename,
          title: note.title,
          excerpt: stripTopHeading(note.content),
          updatedAt: note.updatedAt,
        }));
        const mappedMemory = [...memoryIndexResult(memoryIndex), ...mappedNotes];
        setNoteCatalog(mappedMemory);
        setSessionCatalog(sessions ?? []);
        setNoteResults(mappedMemory);
        setSessionResults(sessions ?? []);
      } catch {
        if (!aliveRef.current) return;
        setNoteCatalog([]);
        setSessionCatalog([]);
        setNoteResults([]);
        setSessionResults([]);
      } finally {
        if (aliveRef.current) setLoading(false);
      }
    })();
  }, [api]);

  useEffect(() => {
    if (query.trim() === "") {
      setNoteResults(noteCatalog);
      setSessionResults(sessionCatalog);
      setLoading(false);
      return;
    }
    const timer = setTimeout(async () => {
      if (!aliveRef.current) return;
      setLoading(true);
      try {
        const [memoryIndex, notes, sessions] = await Promise.all([
          api.memoryGetIndex(),
          api.memorySearchEntries(query),
          api.memorySearchSessions(query),
        ]);
        if (!aliveRef.current) return;
        setNoteResults([
          ...memoryIndexResult(memoryIndex, query),
          ...(notes ?? []),
        ]);
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
  }, [query, api, noteCatalog, sessionCatalog]);

  const reset = useCallback(() => {
    setQuery("");
    setNoteResults([]);
    setSessionResults([]);
  }, []);

  return { query, setQuery, noteResults, sessionResults, loading, reset };
}
