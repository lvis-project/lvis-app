import { useCallback, useMemo, useRef, useState } from "react";

/**
 * Workspace-tab store — the state that ChatSidePanel used to hold in
 * component-local `useState`. Lifting it out of the panel is the linchpin of
 * the ChatSidePanel redesign (issue #1415): while the state lived inside
 * ChatSidePanel, it was destroyed every time the panel unmounted (closing the
 * rail, leaving the home view, or switching sessions) and no external surface
 * (e.g. ActionPanel's open-action) could reach it.
 *
 * The store OWNS the tab list, the active tab, and the per-browser-tab manual
 * URL. It is mounted one level up (ChatView) — a component that stays mounted
 * across session navigation and the panel's open/close toggle — so tab state
 * now SURVIVES those transitions.
 *
 * Content-driven model (§6.10.2): the workspace opens EMPTY (no default tabs).
 * There are TWO kinds of tab:
 *   - LAUNCHER CONTAINER tabs (`addTab`) — a fresh terminal/browser/review/file
 *     surface the user explicitly opened. `content === null`, always `pinned`.
 *   - CONTENT tabs (`openInEphemeral` / `openPinned`) — a tab that points at a
 *     specific item (a preview-target or a web URL). ActionPanel left-click and
 *     indexer results route here.
 *
 * Ephemeral ↔ pinned (§6.10.2, VS Code preview-tab model): a single left-click
 * opens content in the ONE reusable ephemeral slot (replace-in-place); a
 * double-click / pin promotes it to a durable pinned tab. Invariant: at most
 * one ephemeral tab exists, guaranteed by construction (the only ephemeral
 * producer is `openInEphemeral`, which replaces the existing slot instead of
 * adding a second).
 *
 * Every tab is closeable; closing the last one empties the list and the
 * launcher takes over. Activity counts live solely in the ActionPanel (§6.10.4).
 */

export type WorkspaceTabKind = "file-browser" | "preview" | "browser" | "terminal";
export type WorkspaceTabMode = "ephemeral" | "pinned";

/**
 * Identity source of a content tab. The content-tab `kind` is derived from the
 * source (`browser` → browser viewer, `preview` → preview-target viewer).
 */
export type WorkspaceTabContentRef =
  | { source: "preview"; targetId: string }
  | { source: "browser"; url: string };

export interface WorkspaceTab {
  id: string;
  kind: WorkspaceTabKind;
  ordinal: number;
  mode: WorkspaceTabMode;
  /** `null` = launcher container tab (always pinned); non-null = content tab. */
  content: WorkspaceTabContentRef | null;
}

export interface WorkspaceTabsStore {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  browserUrlByTab: Record<string, string>;
  setActiveTabId: (id: string) => void;
  /**
   * Launcher: append a new pinned CONTAINER tab of the given kind and activate
   * it. Never touches the ephemeral slot. Every tab is closeable.
   */
  addTab: (kind: WorkspaceTabKind) => void;
  /**
   * Content routing (left-click). Opens `content` in the single ephemeral slot:
   * reuse the tab already showing this content (keeping its mode), else replace
   * the existing ephemeral tab in-place, else append a new ephemeral tab.
   */
  openInEphemeral: (content: WorkspaceTabContentRef) => void;
  /**
   * Content routing (double-click / open-and-keep). Opens `content` as a pinned
   * tab: reuse (and promote) an existing tab for this content, else append a new
   * pinned tab. Never touches the ephemeral slot.
   */
  openPinned: (content: WorkspaceTabContentRef) => void;
  /** Promote a tab to pinned (double-click / pin button). Idempotent. */
  promoteToPinned: (id: string) => void;
  closeTab: (id: string) => void;
  /** Set (or clear, with `null`) the manually-typed address for a browser tab. */
  setBrowserTabUrl: (tabId: string, url: string | null) => void;
}

function contentKey(ref: WorkspaceTabContentRef): string {
  return ref.source === "browser" ? `browser:${ref.url}` : `preview:${ref.targetId}`;
}

function contentKind(ref: WorkspaceTabContentRef): WorkspaceTabKind {
  return ref.source === "browser" ? "browser" : "preview";
}

interface WorkspaceState {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  browserUrlByTab: Record<string, string>;
}

const EMPTY_STATE: WorkspaceState = { tabs: [], activeTabId: null, browserUrlByTab: {} };

export function useWorkspaceTabs(): WorkspaceTabsStore {
  const [state, setState] = useState<WorkspaceState>(EMPTY_STATE);
  const nextIdRef = useRef(1);
  const nextOrdinalRef = useRef<Record<WorkspaceTabKind, number>>({
    "file-browser": 1,
    preview: 1,
    browser: 1,
    terminal: 1,
  });

  const setActiveTabId = useCallback((id: string) => {
    setState((prev) => (prev.activeTabId === id ? prev : { ...prev, activeTabId: id }));
  }, []);

  const addTab = useCallback((kind: WorkspaceTabKind) => {
    setState((prev) => {
      const ordinal = nextOrdinalRef.current[kind]++;
      const id = `${kind}:${nextIdRef.current++}`;
      const tab: WorkspaceTab = { id, kind, ordinal, mode: "pinned", content: null };
      return { ...prev, tabs: [...prev.tabs, tab], activeTabId: id };
    });
  }, []);

  const openInEphemeral = useCallback((content: WorkspaceTabContentRef) => {
    const key = contentKey(content);
    const kind = contentKind(content);
    setState((prev) => {
      // R1: a tab already shows this content — activate it, keep its mode.
      const existing = prev.tabs.find((tab) => tab.content && contentKey(tab.content) === key);
      if (existing) {
        return prev.activeTabId === existing.id ? prev : { ...prev, activeTabId: existing.id };
      }
      // R2: replace the single ephemeral slot in-place (same id / position).
      const ephemeral = prev.tabs.find((tab) => tab.mode === "ephemeral");
      if (ephemeral) {
        const browserUrlByTab = { ...prev.browserUrlByTab };
        delete browserUrlByTab[ephemeral.id];
        return {
          tabs: prev.tabs.map((tab) =>
            tab.id === ephemeral.id ? { ...tab, kind, content, mode: "ephemeral" } : tab,
          ),
          activeTabId: ephemeral.id,
          browserUrlByTab,
        };
      }
      // R3: no ephemeral slot — append a new ephemeral content tab.
      const id = `${kind}:${nextIdRef.current++}`;
      const tab: WorkspaceTab = { id, kind, ordinal: 0, mode: "ephemeral", content };
      return { ...prev, tabs: [...prev.tabs, tab], activeTabId: id };
    });
  }, []);

  const openPinned = useCallback((content: WorkspaceTabContentRef) => {
    const key = contentKey(content);
    const kind = contentKind(content);
    setState((prev) => {
      // R1: reuse an existing tab for this content, promoting it if ephemeral.
      const existing = prev.tabs.find((tab) => tab.content && contentKey(tab.content) === key);
      if (existing) {
        return {
          ...prev,
          tabs: prev.tabs.map((tab) => (tab.id === existing.id ? { ...tab, mode: "pinned" } : tab)),
          activeTabId: existing.id,
        };
      }
      // R4: append a new pinned content tab; leave the ephemeral slot alone.
      const id = `${kind}:${nextIdRef.current++}`;
      const tab: WorkspaceTab = { id, kind, ordinal: 0, mode: "pinned", content };
      return { ...prev, tabs: [...prev.tabs, tab], activeTabId: id };
    });
  }, []);

  const promoteToPinned = useCallback((id: string) => {
    setState((prev) => {
      const target = prev.tabs.find((tab) => tab.id === id);
      if (!target || target.mode === "pinned") return prev;
      return {
        ...prev,
        tabs: prev.tabs.map((tab) => (tab.id === id ? { ...tab, mode: "pinned" } : tab)),
      };
    });
  }, []);

  const closeTab = useCallback((id: string) => {
    setState((prev) => {
      const closingIndex = prev.tabs.findIndex((tab) => tab.id === id);
      if (closingIndex < 0) return prev;
      const tabs = prev.tabs.filter((tab) => tab.id !== id);
      let activeTabId = prev.activeTabId;
      if (activeTabId === id) {
        // Fall back to the tab before the closed one; empties → null (launcher).
        const fallback = tabs[Math.max(0, closingIndex - 1)] ?? tabs[0] ?? null;
        activeTabId = fallback ? fallback.id : null;
      }
      const browserUrlByTab = { ...prev.browserUrlByTab };
      delete browserUrlByTab[id];
      return { tabs, activeTabId, browserUrlByTab };
    });
  }, []);

  const setBrowserTabUrl = useCallback((tabId: string, url: string | null) => {
    setState((prev) => {
      if (url == null) {
        if (!(tabId in prev.browserUrlByTab)) return prev;
        const browserUrlByTab = { ...prev.browserUrlByTab };
        delete browserUrlByTab[tabId];
        return { ...prev, browserUrlByTab };
      }
      return { ...prev, browserUrlByTab: { ...prev.browserUrlByTab, [tabId]: url } };
    });
  }, []);

  return useMemo(
    () => ({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      browserUrlByTab: state.browserUrlByTab,
      setActiveTabId,
      addTab,
      openInEphemeral,
      openPinned,
      promoteToPinned,
      closeTab,
      setBrowserTabUrl,
    }),
    [state, setActiveTabId, addTab, openInEphemeral, openPinned, promoteToPinned, closeTab, setBrowserTabUrl],
  );
}
