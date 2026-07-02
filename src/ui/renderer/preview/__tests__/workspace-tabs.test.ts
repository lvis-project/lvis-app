// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useWorkspaceTabs } from "../workspace-tabs.js";

describe("useWorkspaceTabs", () => {
  it("starts empty (no default tabs) with no active tab", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    expect(result.current.tabs).toEqual([]);
    expect(result.current.activeTabId).toBeNull();
  });

  it("addTab appends a tab of the kind and activates it", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.addTab("browser"));
    const added = result.current.tabs.at(-1)!;
    expect(added.kind).toBe("browser");
    expect(added.ordinal).toBe(1);
    expect(result.current.activeTabId).toBe(added.id);
  });

  it("addTab supports the preview kind (launcher 'review')", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.addTab("preview"));
    const added = result.current.tabs.at(-1)!;
    expect(added.kind).toBe("preview");
    expect(result.current.activeTabId).toBe(added.id);
  });

  it("addTab assigns per-kind ordinals and unique ids", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.addTab("browser"));
    act(() => result.current.addTab("terminal"));
    act(() => result.current.addTab("browser"));
    const kinds = result.current.tabs.map((tab) => `${tab.kind}:${tab.ordinal}`);
    expect(kinds).toEqual(["browser:1", "terminal:1", "browser:2"]);
    const ids = result.current.tabs.map((tab) => tab.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("closeTab removes the tab and falls back to the previous tab when closing the active one", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.addTab("browser"));
    act(() => result.current.addTab("terminal")); // active
    const firstId = result.current.tabs[0]!.id;
    const activeId = result.current.activeTabId!;
    act(() => result.current.closeTab(activeId));
    expect(result.current.tabs.some((tab) => tab.id === activeId)).toBe(false);
    // Fallback = the tab before the closed one.
    expect(result.current.activeTabId).toBe(firstId);
  });

  it("closing the last tab empties the workspace (no never-empty guard) and clears the active tab", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.addTab("file-browser"));
    const onlyId = result.current.tabs[0]!.id;
    act(() => result.current.closeTab(onlyId));
    expect(result.current.tabs).toEqual([]);
    expect(result.current.activeTabId).toBeNull();
  });

  it("setBrowserTabUrl sets and clears the per-tab manual url, and closeTab drops it", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.addTab("browser"));
    const tabId = result.current.activeTabId!;
    act(() => result.current.setBrowserTabUrl(tabId, "https://example.com/"));
    expect(result.current.browserUrlByTab[tabId]).toBe("https://example.com/");
    act(() => result.current.setBrowserTabUrl(tabId, null));
    expect(tabId in result.current.browserUrlByTab).toBe(false);
    act(() => result.current.setBrowserTabUrl(tabId, "https://again.example/"));
    act(() => result.current.closeTab(tabId));
    expect(tabId in result.current.browserUrlByTab).toBe(false);
  });

  it("addTab creates a pinned container tab (content null)", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.addTab("terminal"));
    const tab = result.current.tabs.at(-1)!;
    expect(tab.mode).toBe("pinned");
    expect(tab.content).toBeNull();
  });

  const A = { source: "preview", targetId: "a" } as const;
  const B = { source: "browser", url: "https://b.example/" } as const;

  const ephemeralCount = (tabs: { mode: string }[]) => tabs.filter((t) => t.mode === "ephemeral").length;

  it("openInEphemeral opens a single ephemeral content tab", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.openInEphemeral(A));
    expect(result.current.tabs).toHaveLength(1);
    const tab = result.current.tabs[0]!;
    expect(tab.mode).toBe("ephemeral");
    expect(tab.content).toEqual(A);
    expect(result.current.activeTabId).toBe(tab.id);
  });

  it("openInEphemeral replaces the ephemeral slot in place (no second ephemeral)", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.openInEphemeral(A));
    const firstId = result.current.tabs[0]!.id;
    act(() => result.current.openInEphemeral(B));
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0]!.id).toBe(firstId);
    expect(result.current.tabs[0]!.content).toEqual(B);
    expect(result.current.tabs[0]!.mode).toBe("ephemeral");
  });

  it("openInEphemeral of the same content re-activates without creating a tab", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.openInEphemeral(A));
    act(() => result.current.openInEphemeral(A));
    expect(result.current.tabs).toHaveLength(1);
  });

  it("promoteToPinned frees the ephemeral slot so the next open appends", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.openInEphemeral(A));
    const id = result.current.tabs[0]!.id;
    act(() => result.current.promoteToPinned(id));
    expect(result.current.tabs[0]!.mode).toBe("pinned");
    act(() => result.current.openInEphemeral(B));
    expect(result.current.tabs).toHaveLength(2);
    expect(ephemeralCount(result.current.tabs)).toBe(1);
  });

  it("openPinned appends a pinned tab and leaves the ephemeral slot untouched", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.openInEphemeral(A));
    act(() => result.current.openPinned(B));
    expect(result.current.tabs).toHaveLength(2);
    expect(ephemeralCount(result.current.tabs)).toBe(1);
  });

  it("openPinned of existing ephemeral content promotes it (no new tab)", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.openInEphemeral(A));
    act(() => result.current.openPinned(A));
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0]!.mode).toBe("pinned");
  });

  it("openInEphemeral of pinned content keeps it pinned (no demote)", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.openPinned(A));
    act(() => result.current.openInEphemeral(A));
    expect(result.current.tabs[0]!.mode).toBe("pinned");
  });

  it("replacing an ephemeral browser tab drops its manual url", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.openInEphemeral(B));
    const id = result.current.tabs[0]!.id;
    act(() => result.current.setBrowserTabUrl(id, "https://manual.example/"));
    act(() => result.current.openInEphemeral(A));
    expect(id in result.current.browserUrlByTab).toBe(false);
  });

  it("keeps at most one ephemeral tab across a mixed sequence (invariant)", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.openInEphemeral(A));
    act(() => result.current.addTab("terminal"));
    act(() => result.current.openInEphemeral(B));
    act(() => result.current.openPinned({ source: "preview", targetId: "c" }));
    act(() => result.current.openInEphemeral({ source: "preview", targetId: "d" }));
    expect(ephemeralCount(result.current.tabs)).toBeLessThanOrEqual(1);
  });
});
