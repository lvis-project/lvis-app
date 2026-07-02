import { useCallback, useMemo, useRef, useState } from "react";

/**
 * Workspace-tab store — the state that ChatSidePanel used to hold in
 * component-local `useState`. Lifting it out of the panel is the linchpin of
 * the ChatSidePanel redesign (issue #1415): while the state lived inside
 * ChatSidePanel, it was destroyed every time the panel unmounted (closing the
 * rail, leaving the home view, or switching sessions) and no external surface
 * (e.g. ActionPanel's future open-action) could reach it.
 *
 * The store OWNS the tab list, the active tab, and the per-browser-tab manual
 * URL. It is mounted one level up (ChatView) — a component that stays mounted
 * across session navigation and the panel's open/close toggle — so tab state
 * now SURVIVES those transitions.
 *
 * This is a PURE LIFT: the default tab set, the counts, and the close rules are
 * IDENTICAL to the previous in-panel behavior. Subsequent PRs (no-default tabs,
 * all-closeable, launcher, ephemeral↔pinned) change the model; this hook only
 * moves WHERE the state lives.
 */

export type WorkspaceTabKind = "file-browser" | "preview" | "browser" | "terminal";

export interface WorkspaceTab {
  id: string;
  kind: WorkspaceTabKind;
  ordinal: number;
  closeable: boolean;
}

/** The mount-time tab set — four non-closeable default tabs (unchanged). */
function defaultTabs(): WorkspaceTab[] {
  return [
    { id: "file-browser:1", kind: "file-browser", ordinal: 1, closeable: false },
    { id: "preview:1", kind: "preview", ordinal: 1, closeable: false },
    { id: "browser:1", kind: "browser", ordinal: 1, closeable: false },
    { id: "terminal:1", kind: "terminal", ordinal: 1, closeable: false },
  ];
}

export interface WorkspaceTabsStore {
  tabs: WorkspaceTab[];
  activeTabId: string;
  browserUrlByTab: Record<string, string>;
  setActiveTabId: (id: string) => void;
  /** Append a new closeable tab of the given kind and activate it. */
  addTab: (kind: "file-browser" | "browser" | "terminal") => void;
  closeTab: (id: string) => void;
  /** Set (or clear, with `null`) the manually-typed address for a browser tab. */
  setBrowserTabUrl: (tabId: string, url: string | null) => void;
}

export function useWorkspaceTabs(): WorkspaceTabsStore {
  const [tabs, setTabs] = useState<WorkspaceTab[]>(defaultTabs);
  const [activeTabId, setActiveTabIdState] = useState("file-browser:1");
  const nextIdRef = useRef(2);
  const nextOrdinalRef = useRef<Record<WorkspaceTabKind, number>>({
    "file-browser": 2,
    preview: 2,
    browser: 2,
    terminal: 2,
  });
  const [browserUrlByTab, setBrowserUrlByTab] = useState<Record<string, string>>({});

  const setActiveTabId = useCallback((id: string) => {
    setActiveTabIdState(id);
  }, []);

  const addTab = useCallback((kind: "file-browser" | "browser" | "terminal") => {
    const ordinal = nextOrdinalRef.current[kind]++;
    const id = `${kind}:${nextIdRef.current++}`;
    setTabs((current) => [...current, { id, kind, ordinal, closeable: true }]);
    setActiveTabIdState(id);
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs((current) => {
      const closingIndex = current.findIndex((tab) => tab.id === id);
      const next = current.filter((tab) => tab.id !== id);
      setActiveTabIdState((active) => {
        if (active !== id) return active;
        const fallback = next[Math.max(0, closingIndex - 1)] ?? next[0];
        return fallback ? fallback.id : active;
      });
      return next.length > 0 ? next : current;
    });
    setBrowserUrlByTab((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  const setBrowserTabUrl = useCallback((tabId: string, url: string | null) => {
    setBrowserUrlByTab((current) => {
      if (url == null) {
        if (!(tabId in current)) return current;
        const next = { ...current };
        delete next[tabId];
        return next;
      }
      return { ...current, [tabId]: url };
    });
  }, []);

  return useMemo(
    () => ({
      tabs,
      activeTabId,
      browserUrlByTab,
      setActiveTabId,
      addTab,
      closeTab,
      setBrowserTabUrl,
    }),
    [tabs, activeTabId, browserUrlByTab, setActiveTabId, addTab, closeTab, setBrowserTabUrl],
  );
}
