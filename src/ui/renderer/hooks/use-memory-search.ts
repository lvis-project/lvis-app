import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../../i18n/runtime.js";
import type { LvisApi } from "../types.js";
import type { ProjectIdentity } from "../../../shared/project-identity.js";

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

function memoryProjectOptions(project: ProjectIdentity | undefined) {
  if (!project?.projectRoot) return undefined;
  return {
    projectRoot: project.projectRoot,
    projectName: project.projectName,
    includeUnscoped: project.isDefault === true,
  };
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
    title: t("useMemorySearch.memoryIndexTitle"),
    excerpt: stripTopHeading(trimmed),
  }];
}

function memoryGetIndex(api: LvisApi, project: ProjectIdentity | undefined) {
  const opts = memoryProjectOptions(project);
  return opts ? api.memoryGetIndex(opts) : api.memoryGetIndex();
}

function memoryListEntries(api: LvisApi, project: ProjectIdentity | undefined) {
  const opts = memoryProjectOptions(project);
  return opts ? api.memoryListEntries(opts) : api.memoryListEntries();
}

function memoryListSessions(api: LvisApi, project: ProjectIdentity | undefined) {
  const opts = memoryProjectOptions(project);
  return opts ? api.memoryListSessions(opts) : api.memoryListSessions();
}

function memorySearchEntries(api: LvisApi, query: string, project: ProjectIdentity | undefined) {
  const opts = memoryProjectOptions(project);
  return opts ? api.memorySearchEntries(query, opts) : api.memorySearchEntries(query);
}

function memorySearchSessions(api: LvisApi, query: string, project: ProjectIdentity | undefined) {
  const opts = memoryProjectOptions(project);
  return opts ? api.memorySearchSessions(query, opts) : api.memorySearchSessions(query);
}

/**
 * Memory search hook.
 *
 * Debounces query (200 ms), fires IPC calls, guards post-unmount setState
 * with aliveRef pattern.
 */
export function useMemorySearch(api: LvisApi, project?: ProjectIdentity) {
  const [query, setQuery] = useState("");
  const [noteCatalog, setNoteCatalog] = useState<NoteResult[]>([]);
  const [sessionCatalog, setSessionCatalog] = useState<SessionResult[]>([]);
  const [noteResults, setNoteResults] = useState<NoteResult[]>([]);
  const [sessionResults, setSessionResults] = useState<SessionResult[]>([]);
  const [loading, setLoading] = useState(false);
  const aliveRef = useRef(true);
  const projectKey = `${project?.projectRoot ?? ""}\0${project?.projectName ?? ""}\0${project?.isDefault === true ? "default" : ""}`;

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
          memoryGetIndex(api, project),
          memoryListEntries(api, project),
          memoryListSessions(api, project),
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
  }, [api, project, projectKey]);

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
          memoryGetIndex(api, project),
          memorySearchEntries(api, query, project),
          memorySearchSessions(api, query, project),
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
  }, [query, api, noteCatalog, sessionCatalog, project, projectKey]);

  const reset = useCallback(() => {
    setQuery("");
    setNoteResults([]);
    setSessionResults([]);
  }, []);

  return { query, setQuery, noteResults, sessionResults, loading, reset };
}
