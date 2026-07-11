// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpAppView } from "../McpAppView.js";
import { ThemeProvider, useTheme } from "../../theme/index.js";
import { DEFAULT_BUNDLE_ID } from "../../theme/index.js";
import { mcpAppPartitionName } from "../../../../shared/mcp-app-partition.js";
import type { McpUiPayload } from "../../../../mcp/types.js";

// The host-context WIRING test (below) needs to observe both the args
// `createMcpAppBridge` is called with and the `bridge.setHostContext` calls that
// follow a theme change — neither is visible from the mounted <webview> DOM node
// the other describe blocks assert against. Mock the whole module so every test
// in this file gets a lightweight fake bridge instead of standing up a real
// AppBridge + WebviewIpcTransport (which the other tests never inspected anyway).
// `vi.hoisted` is required because `vi.mock` factories run before local `const`
// declarations are initialized.
const { createMcpAppBridgeMock } = vi.hoisted(() => ({ createMcpAppBridgeMock: vi.fn() }));
vi.mock("../mcp-app-bridge.js", () => ({
  createMcpAppBridge: createMcpAppBridgeMock,
}));

// McpAppView reads `useTheme()`, so every render is wrapped in a ThemeProvider.
// No `api` prop → no async settings hydrate; the default bundle is already cached
// so the shell resolves synchronously.
function ThemeWrapper({ children }: { children: ReactNode }) {
  return <ThemeProvider initialBundleId={DEFAULT_BUNDLE_ID}>{children}</ThemeProvider>;
}

const renderCard = (payload: McpUiPayload) =>
  render(<McpAppView payload={payload} />, { wrapper: ThemeWrapper });

/** Renders a button that drives a live theme change via the real ThemeProvider context. */
function ThemeToggleButton({ toBundleId }: { toBundleId: string }) {
  const { setBundle } = useTheme();
  return (
    <button type="button" data-testid="theme-toggle" onClick={() => setBundle(toBundleId)}>
      toggle
    </button>
  );
}

let disconnectHandler: ((serverId: string) => void) | null = null;
// Main now returns a BUNDLE: the sandbox-proxy URL the <webview> navigates to,
// plus the app HTML that is handed to the proxy over the bridge (never in the URL).
const readUiResource = vi.fn(async (serverId: string) => ({
  proxyUrl: `lvis-mcp-app://${Buffer.from(serverId, "utf8").toString("hex")}/proxy.html?t=tok-${serverId}`,
  html: "<html><body>card</body></html>",
}));
const disposeUiSession = vi.fn();
/** The EXISTING detach seam — the `onrequestdisplaymode` "fullscreen" arm reuses it. */
const openDetached = vi.fn(async () => ({ ok: true as const, windowId: 7 }));

function stubLvis() {
  disconnectHandler = null;
  vi.stubGlobal("lvis", {
    mcp: {
      readUiResource,
      disposeUiSession,
      openDetached,
      onServerDisconnected: (handler: (serverId: string) => void) => {
        disconnectHandler = handler;
        return () => {
          disconnectHandler = null;
        };
      },
    },
  });
  (window as unknown as { lvis: unknown }).lvis = (globalThis as unknown as { lvis: unknown }).lvis;
}

const payload = (serverId: string): McpUiPayload => ({ serverId, resourceUri: "ui://card/1" });

beforeEach(() => {
  readUiResource.mockClear();
  openDetached.mockClear();
  openDetached.mockResolvedValue({ ok: true as const, windowId: 7 });
  stubLvis();
  createMcpAppBridgeMock.mockClear();
  // Default fake bridge for every test in this file: a `setHostContext` spy plus
  // a no-op `transport.close()` (invoked on unmount / re-attach). Individual tests
  // read `createMcpAppBridgeMock.mock.calls` / `.mock.results` to inspect the
  // hostContext argument and the returned bridge's `setHostContext` calls.
  createMcpAppBridgeMock.mockImplementation(() => ({
    bridge: { setHostContext: vi.fn() },
    transport: { close: vi.fn() },
    connected: Promise.resolve(),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Query the MOUNTED <webview> node (asserts the node attribute, not a setter). */
function webviewNode(container: HTMLElement): Element | null {
  return container.querySelector("webview");
}

describe("McpAppView — MAJOR-1 per-server partition as a createElement PROP", () => {
  it("sets partition=lvis-mcp-app:<enc(serverId)> on the MOUNTED webview node", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());
    const node = webviewNode(container)!;
    // The whole point of the fix: the attribute must be present on the mounted
    // node (Electron binds partition only before src loads), NOT set post-mount.
    expect(node.getAttribute("partition")).toBe(mcpAppPartitionName("github"));
    // Sandbox posture also declared as creation-time props.
    expect(node.getAttribute("webpreferences")).toContain("contextIsolation=yes");
    expect(node.getAttribute("webpreferences")).toContain("sandbox=yes");
    // The webview now navigates to the host-owned sandbox-proxy document on the
    // privileged scheme — NOT a `data:` URL carrying the app HTML. The app HTML
    // travels over the bridge instead, so it never hits the ~2MB data:-URL cap and
    // the document gets a real origin + a real CSP response header.
    expect(node.getAttribute("src")?.startsWith("lvis-mcp-app://")).toBe(true);
    expect(node.getAttribute("src")).not.toContain("data:text/html");
    // No preload ATTRIBUTE: it is silently ignored under sandbox=yes and stripped
    // by the will-attach guards. The relay preload rides session.setPreloads().
    expect(node.getAttribute("preload")).toBeNull();
  });

  it("distinct serverIds yield distinct partition attributes", async () => {
    const a = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(a.container)).toBeTruthy());
    const b = renderCard(payload("gitlab"));
    await waitFor(() => expect(webviewNode(b.container)).toBeTruthy());

    const pa = webviewNode(a.container)!.getAttribute("partition");
    const pb = webviewNode(b.container)!.getAttribute("partition");
    expect(pa).toBe(mcpAppPartitionName("github"));
    expect(pb).toBe(mcpAppPartitionName("gitlab"));
    expect(pa).not.toBe(pb);
  });
});

describe("McpAppView — b3 disable-in-place on disconnect", () => {
  it("swaps the webview for a placeholder when its own server disconnects", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    act(() => {
      disconnectHandler?.("github");
    });

    // The live webview is torn down; the placeholder takes the same card frame.
    expect(webviewNode(container)).toBeNull();
    expect(screen.getByTestId("mcp-app-disconnected")).toBeInTheDocument();
  });

  it("ignores a disconnect for a DIFFERENT server", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    act(() => {
      disconnectHandler?.("some-other-server");
    });

    expect(webviewNode(container)).toBeTruthy();
    expect(screen.queryByTestId("mcp-app-disconnected")).toBeNull();
  });
});

describe("McpAppView — standard McpUiHostContext wiring (P0)", () => {
  it("seeds createMcpAppBridge with a populated, leak-free hostContext, then pushes updates via bridge.setHostContext on a theme change", async () => {
    const { container, getByTestId } = render(<McpAppView payload={payload("github")} />, {
      // `initialBundleId={DEFAULT_BUNDLE_ID}` ("moonstone", shell "light") gives a
      // known starting theme. The toggle button (real ThemeProvider context) later
      // drives a switch to "midnight" (shell "dark") to exercise the update path.
      wrapper: ({ children }) => (
        <ThemeProvider initialBundleId={DEFAULT_BUNDLE_ID}>
          <ThemeToggleButton toBundleId="midnight" />
          {children}
        </ThemeProvider>
      ),
    });
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    // (a) The INITIAL seed: createMcpAppBridge's 4th arg is a populated, standard
    // hostContext — theme present, at least one standard `--color-*` style
    // variable, and NEVER a proprietary `--lvis-*` key (the portability guarantee).
    expect(createMcpAppBridgeMock).toHaveBeenCalledTimes(1);
    const seededContext = createMcpAppBridgeMock.mock.calls[0]![3] as {
      theme?: string;
      styles?: { variables?: Record<string, string> };
    };
    expect(seededContext.theme).toBe("light");
    const seededKeys = Object.keys(seededContext.styles?.variables ?? {});
    expect(seededKeys.some((k) => k.startsWith("--color-"))).toBe(true);
    expect(seededKeys.some((k) => k.startsWith("--lvis-"))).toBe(false);

    const fakeBridge = createMcpAppBridgeMock.mock.results[0]!.value.bridge as {
      setHostContext: ReturnType<typeof vi.fn>;
    };
    expect(fakeBridge.setHostContext).not.toHaveBeenCalled();

    // (b) THE UPDATE PATH — the flagship guard: switching the active theme via the
    // real ThemeProvider must reach the mounted bridge through `setHostContext`,
    // NOT re-create the bridge (attachWebview stays keyed on [payload, bundle]).
    act(() => {
      fireEvent.click(getByTestId("theme-toggle"));
    });

    // "midnight" is lazy-loaded (dynamic import), so `effectiveBundleId` flips to
    // "midnight" a render before the bundle itself resolves — McpAppView's
    // host-context effect may push an interim call before `resolved` catches up.
    // Poll on the LAST call converging to "dark" rather than "called once" so the
    // assertion is robust to that intermediate render.
    await waitFor(() => {
      const calls = fakeBridge.setHostContext.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      expect((calls[calls.length - 1]![0] as { theme?: string }).theme).toBe("dark");
    });
    // The bridge was never re-created for a theme-only change.
    expect(createMcpAppBridgeMock).toHaveBeenCalledTimes(1);
  });
});

describe("McpAppView — app-driven resize + open-link adapters (P1a)", () => {
  /** The `deps` (5th) arg createMcpAppBridge was seeded with on the first mount. */
  function seededDeps() {
    return createMcpAppBridgeMock.mock.calls[0]![4] as {
      onResize: (next: { width?: number; height?: number }) => void;
      openLink: (url: string) => Promise<{ ok: boolean }>;
    };
  }

  it("seeds the webview at payload height, then grows it when the app reports a size change", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());
    const node = () => webviewNode(container) as HTMLElement;

    // Initial seed = payload.height ?? 300.
    expect(node().style.height).toBe("300px");
    expect(node().style.width).toBe("100%");

    // Driving the injected onsizechange sink updates the live <webview> height…
    act(() => {
      seededDeps().onResize({ height: 512 });
    });
    await waitFor(() => expect((webviewNode(container) as HTMLElement).style.height).toBe("512px"));
    // …without re-creating the bridge (resize is a state update, not a re-mount)…
    expect(createMcpAppBridgeMock).toHaveBeenCalledTimes(1);
    // …and a height-only notification leaves width responsive.
    expect(node().style.width).toBe("100%");
  });

  it("routes onopenlink through window.lvisApi.openExternalUrl (the gated egress), returning ok", async () => {
    const openExternalUrl = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("lvisApi", { openExternalUrl });

    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    const result = await seededDeps().openLink("https://example.com");

    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com");
    expect(result).toEqual({ ok: true });
  });
});

describe("McpAppView — display-mode applier (the EXISTING window seams, reused)", () => {
  /** The display-mode halves of the `deps` arg createMcpAppBridge was seeded with. */
  function seededDisplayDeps() {
    return createMcpAppBridgeMock.mock.calls[0]![4] as {
      getDisplayMode: () => string;
      applyDisplayMode: (mode: string) => Promise<string>;
    };
  }

  /** The hostContext (4th arg) of the Nth createMcpAppBridge call. */
  function seededContext() {
    return createMcpAppBridgeMock.mock.calls[0]![3] as {
      displayMode?: string;
      availableDisplayModes?: string[];
    };
  }

  it("seeds an inline card's host context with displayMode=inline + the advertised set", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    expect(seededContext().displayMode).toBe("inline");
    expect(seededContext().availableDisplayModes).toEqual(["inline", "fullscreen"]);
    expect(seededDisplayDeps().getDisplayMode()).toBe("inline");
  });

  it("seeds a DETACHED mount as fullscreen — the detached shell IS that presentation", async () => {
    const { container } = render(<McpAppView payload={payload("github")} displayMode="fullscreen" />, {
      wrapper: ThemeWrapper,
    });
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    expect(seededContext().displayMode).toBe("fullscreen");
    expect(seededDisplayDeps().getDisplayMode()).toBe("fullscreen");
  });

  it("fullscreen → the existing detach seam, MAXIMIZED; the applied mode is returned and pushed to the app", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());
    const bridge = createMcpAppBridgeMock.mock.results[0]!.value.bridge as {
      setHostContext: ReturnType<typeof vi.fn>;
    };

    const applied = await act(() => seededDisplayDeps().applyDisplayMode("fullscreen"));

    // No new window stack: the SAME `mcp.openDetached` the detach button uses, with
    // the maximize flag that makes it the fullscreen presentation.
    expect(openDetached).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "github" }),
      { maximize: true },
    );
    expect(applied).toBe("fullscreen");
    expect(seededDisplayDeps().getDisplayMode()).toBe("fullscreen");
    // And the app is told: the mode change rides the existing setHostContext push.
    await waitFor(() => {
      const calls = bridge.setHostContext.mock.calls;
      expect((calls[calls.length - 1]?.[0] as { displayMode?: string })?.displayMode).toBe("fullscreen");
    });
    // A mode change is state, not a re-mount.
    expect(createMcpAppBridgeMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the card where it is when the host DECLINES the detach", async () => {
    openDetached.mockResolvedValue({ ok: false, error: "invalid-payload" } as never);
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    const applied = await act(() => seededDisplayDeps().applyDisplayMode("fullscreen"));

    expect(applied).toBe("inline");
    expect(seededDisplayDeps().getDisplayMode()).toBe("inline");
  });

  it("inline (from fullscreen) closes the detached shell — the exact inverse, no new IPC", async () => {
    const closeAllDetached = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("lvisApi", { window: { closeAllDetached } });

    const { container } = render(<McpAppView payload={payload("github")} displayMode="fullscreen" />, {
      wrapper: ThemeWrapper,
    });
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    const applied = await act(() => seededDisplayDeps().applyDisplayMode("inline"));

    expect(closeAllDetached).toHaveBeenCalledTimes(1);
    expect(applied).toBe("inline");
    expect(seededDisplayDeps().getDisplayMode()).toBe("inline");
  });

  it("is a no-op when the app asks for the mode it is already in", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    await expect(act(() => seededDisplayDeps().applyDisplayMode("inline"))).resolves.toBe("inline");
    expect(openDetached).not.toHaveBeenCalled();
  });
});
