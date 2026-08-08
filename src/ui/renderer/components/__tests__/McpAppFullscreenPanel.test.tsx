// @vitest-environment jsdom
/**
 * McpAppFullscreenPanel — `fullscreen` is a surface INSIDE the renderer.
 *
 * The load-bearing claim, and the one a regression would silently undo: an app that
 * asks for `fullscreen` gets a live card in this panel and NO second window. The
 * producer-driven case below drives the real `onrequestdisplaymode` handler with the
 * real deps McpAppView seeds its bridge with, so it fails if either half of the wiring
 * (the handler's allow-list, or McpAppView's applier) stops routing `fullscreen` here.
 */
import "../../../../../test/renderer/setup.js";
import { render, waitFor, act, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpAppFullscreenPanel } from "../McpAppFullscreenPanel.js";
import { McpAppView } from "../McpAppView.js";
import { McpAppPipPanel } from "../McpAppPipPanel.js";
import { ThemeWrapper } from "./mcp-app-test-helpers.js";
import { createOnRequestDisplayMode } from "../mcp-app-bridge/handlers/on-request-display-mode.js";
import {
  __resetMcpAppCardLocationStoreForTests,
  getCardLocation,
  getSlotOccupant,
  moveCard,
} from "../../state/mcp-app-card-location-store.js";
import type { McpUiPayload } from "../../../../mcp/types.js";

const { createMcpAppBridgeMock } = vi.hoisted(() => ({ createMcpAppBridgeMock: vi.fn() }));
vi.mock("../mcp-app-bridge.js", () => ({
  createMcpAppBridge: createMcpAppBridgeMock,
}));

const readUiResource = vi.fn(async (serverId: string) => ({
  proxyUrl: `lvis-mcp-app://${Buffer.from(serverId, "utf8").toString("hex")}/proxy.html?t=tok-${serverId}`,
  html: "<html><body>card</body></html>",
}));
const disposeUiSession = vi.fn();
/** The window seams a `fullscreen` request must never reach — stubbed as WORKING calls,
 *  so a regression that starts using one succeeds and is caught by the assertion. */
const openDetached = vi.fn(async () => ({
  ok: true as const,
  windowId: 7,
  viewKey: "mcp-app:676974687562:card-1",
}));
const closeDetached = vi.fn(async () => ({ ok: true as const }));

function stubLvis() {
  vi.stubGlobal("lvis", {
    mcp: {
      readUiResource,
      disposeUiSession,
      openDetached,
      closeDetached,
      onServerDisconnected: () => () => undefined,
      onDetachedClosed: () => () => undefined,
    },
  });
  (window as unknown as { lvis: unknown }).lvis = (globalThis as unknown as { lvis: unknown }).lvis;
}

const payload = (serverId: string): McpUiPayload => ({ serverId, resourceUri: "ui://card/1" });

function webviewNodes(container: HTMLElement): NodeListOf<Element> {
  return container.querySelectorAll("webview");
}

/** The display-mode halves (5th arg) of the Nth createMcpAppBridge call. */
function displayDeps(index: number) {
  return createMcpAppBridgeMock.mock.calls[index]![4] as {
    getDisplayMode: () => "inline" | "fullscreen" | "pip";
    applyDisplayMode: (mode: "inline" | "fullscreen" | "pip") => Promise<"inline" | "fullscreen" | "pip">;
  };
}

beforeEach(() => {
  __resetMcpAppCardLocationStoreForTests();
  readUiResource.mockClear();
  openDetached.mockClear();
  closeDetached.mockClear();
  stubLvis();
  createMcpAppBridgeMock.mockClear();
  createMcpAppBridgeMock.mockImplementation(() => ({
    bridge: { setHostContext: vi.fn() },
    transport: { close: vi.fn() },
    connected: Promise.resolve(),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetMcpAppCardLocationStoreForTests();
});

describe("McpAppFullscreenPanel — the fullscreen slot's surface", () => {
  it("is empty when no card occupies the fullscreen slot", () => {
    const { container } = render(<McpAppFullscreenPanel />, { wrapper: ThemeWrapper });
    expect(container.querySelector('[data-testid="mcp-app-fullscreen-panel"]')).toBeNull();
  });

  it("mounts a live McpAppView for the card the store says is in fullscreen", async () => {
    moveCard("card-1", { kind: "fullscreen" }, { payload: payload("github"), originSessionId: "sess-1" });

    const { container } = render(<McpAppFullscreenPanel />, { wrapper: ThemeWrapper });

    expect(container.querySelector('[data-testid="mcp-app-fullscreen-panel"]')).toBeTruthy();
    await waitFor(() => expect(webviewNodes(container)).toHaveLength(1));
  });

  it("hands the away mount the home's locationId and origin session, so its moves and messages land on the SAME card", async () => {
    moveCard("card-1", { kind: "fullscreen" }, { payload: payload("github"), originSessionId: "sess-abc" });
    const { container } = render(<McpAppFullscreenPanel />, { wrapper: ThemeWrapper });
    await waitFor(() => expect(webviewNodes(container)).toHaveLength(1));

    // The away mount moving the card lands on the HOME card's entry, not a fresh one.
    await act(() => displayDeps(0).applyDisplayMode("pip"));
    expect(getCardLocation("card-1")).toEqual({ kind: "pip" });
    expect(getSlotOccupant("pip")?.originSessionId).toBe("sess-abc");
  });

  it("exit button revives the card through the store (host-initiated, no app involvement)", async () => {
    moveCard("card-1", { kind: "fullscreen" }, { payload: payload("github"), originSessionId: "sess-1" });
    const { container, getByTestId } = render(<McpAppFullscreenPanel />, { wrapper: ThemeWrapper });
    await waitFor(() => expect(webviewNodes(container)).toHaveLength(1));

    act(() => {
      fireEvent.click(getByTestId("mcp-app-fullscreen-exit"));
    });

    await waitFor(() =>
      expect(container.querySelector('[data-testid="mcp-app-fullscreen-panel"]')).toBeNull(),
    );
    expect(getCardLocation("card-1")).toEqual({ kind: "inline" });
  });

  it("a DIFFERENT card claiming the fullscreen slot cleanly swaps the mounted McpAppView (keyed by cardId)", async () => {
    moveCard("card-1", { kind: "fullscreen" }, { payload: payload("github"), originSessionId: "sess-1" });
    const { container } = render(<McpAppFullscreenPanel />, { wrapper: ThemeWrapper });
    await waitFor(() => expect(webviewNodes(container)).toHaveLength(1));

    act(() => {
      moveCard("card-2", { kind: "fullscreen" }, { payload: payload("gitlab"), originSessionId: "sess-2" });
    });

    await waitFor(() => expect(readUiResource).toHaveBeenCalledWith("gitlab", "ui://card/1", undefined));
    // Exactly one <webview> at any moment — the swap is atomic (single-slot).
    await waitFor(() => expect(webviewNodes(container)).toHaveLength(1));
  });
});

describe("McpAppFullscreenPanel — driven by the app, through the real request handler", () => {
  it("an app requesting `fullscreen` is answered `fullscreen`, takes over IN THIS RENDERER, and opens no window", async () => {
    // Production topology: a transcript HOME mount plus the two away surfaces, exactly
    // as MainContent mounts them.
    const home = render(<McpAppView payload={payload("github")} />, { wrapper: ThemeWrapper });
    await waitFor(() => expect(webviewNodes(home.container)).toHaveLength(1));
    const panels = render(
      <>
        <McpAppPipPanel />
        <McpAppFullscreenPanel />
      </>,
      { wrapper: ThemeWrapper },
    );

    // The REAL `ui/request-display-mode` handler, over the REAL deps McpAppView seeded
    // its bridge with — not a hand-rolled applier.
    // Cast to the request half of the callback: the bridge passes a second
    // transport-extra argument this test has no use for, exactly as the handler's own
    // unit test does.
    const onRequestDisplayMode = createOnRequestDisplayMode({
      getMode: displayDeps(0).getDisplayMode,
      applyMode: displayDeps(0).applyDisplayMode,
    }) as unknown as (p: { mode: string }) => Promise<{ mode: string }>;

    const response = await act(() => onRequestDisplayMode({ mode: "fullscreen" }));

    // The spec answer the app receives.
    expect(response).toEqual({ mode: "fullscreen" });
    // No second window: the whole point of the remap.
    expect(openDetached).not.toHaveBeenCalled();
    // The card is live in the fullscreen panel and dormant at home — one live bridge.
    await waitFor(() =>
      expect(panels.container.querySelector('[data-testid="mcp-app-fullscreen-panel"]')).toBeTruthy(),
    );
    await waitFor(() => expect(webviewNodes(panels.container)).toHaveLength(1));
    expect(webviewNodes(home.container)).toHaveLength(0);
    expect(home.container.querySelector('[data-testid="mcp-app-fullscreen"]')).toBeTruthy();
  });

  it("the two away surfaces hold DIFFERENT cards at once, one live mount each", async () => {
    moveCard("card-a", { kind: "pip" }, { payload: payload("github"), originSessionId: "sess-1" });
    moveCard("card-b", { kind: "fullscreen" }, { payload: payload("gitlab"), originSessionId: "sess-2" });

    const pip = render(<McpAppPipPanel />, { wrapper: ThemeWrapper });
    const full = render(<McpAppFullscreenPanel />, { wrapper: ThemeWrapper });

    await waitFor(() => expect(webviewNodes(pip.container)).toHaveLength(1));
    await waitFor(() => expect(webviewNodes(full.container)).toHaveLength(1));
  });
});
