// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useWorkspaceTabs } from "../workspace-tabs.js";

describe("useWorkspaceTabs", () => {
  it("starts with the four non-closeable default tabs and file-browser active", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    expect(result.current.tabs.map((tab) => tab.id)).toEqual([
      "file-browser:1",
      "preview:1",
      "browser:1",
      "terminal:1",
    ]);
    expect(result.current.tabs.every((tab) => !tab.closeable)).toBe(true);
    expect(result.current.activeTabId).toBe("file-browser:1");
  });

  it("addTab appends a closeable tab of the kind and activates it", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.addTab("browser"));
    const added = result.current.tabs.at(-1)!;
    expect(added.kind).toBe("browser");
    expect(added.closeable).toBe(true);
    expect(added.ordinal).toBe(2);
    expect(result.current.activeTabId).toBe(added.id);
  });

  it("addTab assigns per-kind ordinals and unique ids", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.addTab("browser"));
    act(() => result.current.addTab("terminal"));
    act(() => result.current.addTab("browser"));
    const kinds = result.current.tabs.map((tab) => `${tab.kind}:${tab.ordinal}`);
    expect(kinds).toContain("browser:2");
    expect(kinds).toContain("terminal:2");
    expect(kinds).toContain("browser:3");
    const ids = result.current.tabs.map((tab) => tab.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("closeTab removes the tab and falls back to the previous tab when closing the active one", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.addTab("browser")); // appended after terminal:1, now active
    const addedId = result.current.activeTabId;
    act(() => result.current.closeTab(addedId));
    expect(result.current.tabs.some((tab) => tab.id === addedId)).toBe(false);
    // Fallback = the tab before the closed one (terminal:1 was last default).
    expect(result.current.activeTabId).toBe("terminal:1");
  });

  it("closeTab keeps the last remaining tab (never-empty guard preserved)", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    // Close everything down to one; the guard returns the current list when a
    // close would empty it.
    act(() => result.current.closeTab("preview:1"));
    act(() => result.current.closeTab("browser:1"));
    act(() => result.current.closeTab("terminal:1"));
    expect(result.current.tabs.map((tab) => tab.id)).toEqual(["file-browser:1"]);
    act(() => result.current.closeTab("file-browser:1"));
    // Never-empty: last tab is retained.
    expect(result.current.tabs.map((tab) => tab.id)).toEqual(["file-browser:1"]);
  });

  it("setBrowserTabUrl sets and clears the per-tab manual url, and closeTab drops it", () => {
    const { result } = renderHook(() => useWorkspaceTabs());
    act(() => result.current.addTab("browser"));
    const tabId = result.current.activeTabId;
    act(() => result.current.setBrowserTabUrl(tabId, "https://example.com/"));
    expect(result.current.browserUrlByTab[tabId]).toBe("https://example.com/");
    act(() => result.current.setBrowserTabUrl(tabId, null));
    expect(tabId in result.current.browserUrlByTab).toBe(false);
    act(() => result.current.setBrowserTabUrl(tabId, "https://again.example/"));
    act(() => result.current.closeTab(tabId));
    expect(tabId in result.current.browserUrlByTab).toBe(false);
  });
});
