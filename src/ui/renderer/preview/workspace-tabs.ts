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
 * Content-driven model (§6.10.2): the workspace opens EMPTY (no default tabs).
 * Tabs are created by user action (the empty-state launcher) or content routing
 * (ActionPanel / indexer results). Every tab is closeable; closing the last one
 * empties the list and the launcher takes over. There is no never-empty guard
 * and no per-kind count on the tab bar (activity signal lives solely in the
 * ActionPanel — §6.10.4).
 */

export type WorkspaceTabKind = "file-browser" | "preview" | "browser" | "terminal";

export interface WorkspaceTab {
  id: string;
  kind: WorkspaceTabKind;
  ordinal: number;
}

export interface WorkspaceTabsStore {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  browserUrlByTab: Record<string, string>;
  setActiveTabId: (id: string) => void;
  /** Append a new tab of the given kind and activate it. Every tab is closeable. */
  addTab: (kind: WorkspaceTabKind) => void;
  closeTab: (id: string) => void;
  /** Set (or clear, with `null`) the manually-typed address for a browser tab. */
  setBrowserTabUrl: (tabId: string, url: string | null) => void;
}

export function useWorkspaceTabs(): WorkspaceTabsStore {
  // No default tabs — the workspace starts empty and the launcher fills it.
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activeTabId, setActiveTabIdState] = useState<string | null>(null);
  const nextIdRef = useRef(1);
  const nextOrdinalRef = useRef<Record<WorkspaceTabKind, number>>({
    "file-browser": 1,
    preview: 1,
    browser: 1,
    terminal: 1,
  });
  const [browserUrlByTab, setBrowserUrlByTab] = useState<Record<string, string>>({});

  const setActiveTabId = useCallback((id: string) => {
    setActiveTabIdState(id);
  }, []);

  const addTab = useCallback((kind: WorkspaceTabKind) => {
    const ordinal = nextOrdinalRef.current[kind]++;
    const id = `${kind}:${nextIdRef.current++}`;
    setTabs((current) => [...current, { id, kind, ordinal }]);
    setActiveTabIdState(id);
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs((current) => {
      const closingIndex = current.findIndex((tab) => tab.id === id);
      const next = current.filter((tab) => tab.id !== id);
      setActiveTabIdState((active) => {
        if (active !== id) return active;
        // Fall back to the tab before the closed one; when the list empties,
        // activeTabId becomes null and the empty-state launcher renders.
        const fallback = next[Math.max(0, closingIndex - 1)] ?? next[0] ?? null;
        return fallback ? fallback.id : null;
      });
      return next;
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
