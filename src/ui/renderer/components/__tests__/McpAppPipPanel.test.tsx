// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { render, waitFor, act, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpAppPipPanel } from "../McpAppPipPanel.js";
import { McpAppView } from "../McpAppView.js";
import { ThemeWrapper } from "./mcp-app-test-helpers.js";
import {
  __resetMcpAppCardLocationStoreForTests,
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

describe("McpAppPipPanel — renders nothing without an occupant", () => {
  it("is empty when no card occupies the pip slot", () => {
    const { container } = render(<McpAppPipPanel />, { wrapper: ThemeWrapper });
    expect(container.querySelector('[data-testid="mcp-app-pip-panel"]')).toBeNull();
  });
});

describe("McpAppPipPanel — renders the current pip occupant", () => {
  it("mounts a live McpAppView for the card the store says is in pip", async () => {
    moveCard("card-1", { kind: "pip" }, { payload: payload("github"), originSessionId: "sess-1" });

    const { container } = render(<McpAppPipPanel />, { wrapper: ThemeWrapper });

    expect(container.querySelector('[data-testid="mcp-app-pip-panel"]')).toBeTruthy();
    await waitFor(() => expect(webviewNodes(container)).toHaveLength(1));
  });

  it("close button revives the card through the store (host-initiated, no app involvement)", async () => {
    moveCard("card-1", { kind: "pip" }, { payload: payload("github"), originSessionId: "sess-1" });
    const { container, getByTestId } = render(<McpAppPipPanel />, { wrapper: ThemeWrapper });
    await waitFor(() => expect(webviewNodes(container)).toHaveLength(1));

    act(() => {
      fireEvent.click(getByTestId("mcp-app-pip-close"));
    });

    await waitFor(() => expect(container.querySelector('[data-testid="mcp-app-pip-panel"]')).toBeNull());
  });

  it("a DIFFERENT card claiming the pip slot cleanly swaps the mounted McpAppView (keyed by cardId)", async () => {
    moveCard("card-1", { kind: "pip" }, { payload: payload("github"), originSessionId: "sess-1" });
    const { container } = render(<McpAppPipPanel />, { wrapper: ThemeWrapper });
    await waitFor(() => expect(webviewNodes(container)).toHaveLength(1));
    expect(createMcpAppBridgeMock).toHaveBeenCalledTimes(1);

    act(() => {
      moveCard("card-2", { kind: "pip" }, { payload: payload("gitlab"), originSessionId: "sess-2" });
    });

    await waitFor(() => expect(readUiResource).toHaveBeenCalledWith("gitlab", "ui://card/1"));
    // Exactly one <webview> at any moment — the swap is atomic (single-slot).
    await waitFor(() => expect(webviewNodes(container)).toHaveLength(1));
  });
});

describe("McpAppPipPanel — draggable, clamped to the viewport", () => {
  it("moves on pointer drag and clamps within window bounds", async () => {
    moveCard("card-1", { kind: "pip" }, { payload: payload("github"), originSessionId: "sess-1" });
    const { getByTestId, container } = render(<McpAppPipPanel />, { wrapper: ThemeWrapper });
    await waitFor(() => expect(webviewNodes(container)).toHaveLength(1));

    const panel = container.querySelector('[data-testid="mcp-app-pip-panel"]') as HTMLElement;
    const startLeft = parseInt(panel.style.left, 10);
    const startTop = parseInt(panel.style.top, 10);

    const handle = getByTestId("mcp-app-pip-drag-handle");
    act(() => {
      fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 });
      fireEvent.pointerMove(window, { clientX: 60, clientY: 130, pointerId: 1 });
      fireEvent.pointerUp(window, { clientX: 60, clientY: 130, pointerId: 1 });
    });

    expect(parseInt(panel.style.left, 10)).toBe(startLeft - 40);
    expect(parseInt(panel.style.top, 10)).toBe(startTop + 30);
  });

  it("arrow keys on the drag handle move the panel by a fixed step", async () => {
    moveCard("card-1", { kind: "pip" }, { payload: payload("github"), originSessionId: "sess-1" });
    const { getByTestId, container } = render(<McpAppPipPanel />, { wrapper: ThemeWrapper });
    await waitFor(() => expect(webviewNodes(container)).toHaveLength(1));

    const panel = container.querySelector('[data-testid="mcp-app-pip-panel"]') as HTMLElement;
    const startLeft = parseInt(panel.style.left, 10);

    act(() => {
      fireEvent.keyDown(getByTestId("mcp-app-pip-drag-handle"), { key: "ArrowLeft" });
    });

    expect(parseInt(panel.style.left, 10)).toBe(startLeft - 16);
  });
});

describe("McpAppPipPanel — coexists with a detached view (independent surfaces)", () => {
  it("a pip card (this panel) and a detached card (a separate McpAppView mount) are BOTH live at once", async () => {
    // Card A is in pip.
    moveCard("card-a", { kind: "pip" }, { payload: payload("github"), originSessionId: "sess-1" });
    const pip = render(<McpAppPipPanel />, { wrapper: ThemeWrapper });
    await waitFor(() => expect(webviewNodes(pip.container)).toHaveLength(1));

    // Card B is presented in the detached shell — an entirely separate McpAppView
    // mount (mirroring DetachedView's own instance), never touching the pip slot.
    const detached = render(
      <McpAppView payload={payload("gitlab")} displayMode="fullscreen" />,
      { wrapper: ThemeWrapper },
    );
    await waitFor(() => expect(webviewNodes(detached.container)).toHaveLength(1));

    // Both remain live simultaneously — nothing about the pip surface's single-slot
    // discipline touches an unrelated card's detached presentation.
    expect(webviewNodes(pip.container)).toHaveLength(1);
    expect(webviewNodes(detached.container)).toHaveLength(1);
  });
});
