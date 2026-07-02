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
});
