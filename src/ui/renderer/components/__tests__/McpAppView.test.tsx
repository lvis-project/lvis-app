// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpAppView } from "../McpAppView.js";
import { McpAppPipPanel } from "../McpAppPipPanel.js";
import { ThemeProvider, useTheme } from "../../theme/index.js";
import { DEFAULT_BUNDLE_ID } from "../../theme/index.js";
import { mcpAppPartitionName } from "../../../../shared/mcp-app-partition.js";
import { MCP_APP_CARD_MAX_HEIGHT_PX } from "../../../../shared/mcp-app-card-size.js";
import { __resetMcpAppCardLocationStoreForTests } from "../../state/mcp-app-card-location-store.js";
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
let detachedClosedHandler: ((viewKey: string) => void) | null = null;
// Main now returns a BUNDLE: the sandbox-proxy URL the <webview> navigates to,
// plus the app HTML that is handed to the proxy over the bridge (never in the URL).
const readUiResource = vi.fn(async (serverId: string) => ({
  proxyUrl: `lvis-mcp-app://${Buffer.from(serverId, "utf8").toString("hex")}/proxy.html?t=tok-${serverId}`,
  html: "<html><body>card</body></html>",
}));
const disposeUiSession = vi.fn();
/**
 * The EXISTING detach seam — the `onrequestdisplaymode` "fullscreen" arm reuses it.
 * Returns the host-minted `viewKey`: the identity of the detached instance the card
 * moved into, which the inline mount keeps so it can recognize its own close event.
 */
const DETACHED_VIEW_KEY = "mcp-app:676974687562:card-1";
const openDetached = vi.fn(async () => ({
  ok: true as const,
  windowId: 7,
  viewKey: DETACHED_VIEW_KEY,
}));
/** The SCOPED close — the `onrequestdisplaymode` "inline" arm (never closeAllDetached). */
const closeDetached = vi.fn(async () => ({ ok: true as const }));
/** The gated save path behind `ondownloadfile`. */
const downloadFile = vi.fn(async () => ({ ok: true as const, disposition: "saved" as const }));
/**
 * The gated per-card context slot behind `onupdatemodelcontext`. Declared with its real
 * arity so the assertions below can read the THREE renderer-supplied bindings positionally.
 */
const postUiModelContext = vi.fn(
  async (_serverId: string, _sessionId: string, _cardId: string, _params: unknown) => ({
    ok: true as const,
    disposition: "stored" as const,
  }),
);

function stubLvis() {
  disconnectHandler = null;
  detachedClosedHandler = null;
  vi.stubGlobal("lvis", {
    mcp: {
      readUiResource,
      disposeUiSession,
      openDetached,
      closeDetached,
      downloadFile,
      postUiModelContext,
      onServerDisconnected: (handler: (serverId: string) => void) => {
        disconnectHandler = handler;
        return () => {
          disconnectHandler = null;
        };
      },
      onDetachedClosed: (handler: (viewKey: string) => void) => {
        detachedClosedHandler = handler;
        return () => {
          detachedClosedHandler = null;
        };
      },
    },
  });
  (window as unknown as { lvis: unknown }).lvis = (globalThis as unknown as { lvis: unknown }).lvis;
}

const payload = (serverId: string): McpUiPayload => ({ serverId, resourceUri: "ui://card/1" });

beforeEach(() => {
  // The pip / location-store describe blocks below write the MODULE-SINGLETON card
  // location store (moveCard / reviveCardIfAt via applyDisplayMode). Reset it per test
  // so order-coupled shared state never leaks between cases (the store test and
  // McpAppPipPanel.test.tsx already do this).
  __resetMcpAppCardLocationStoreForTests();
  readUiResource.mockClear();
  openDetached.mockClear();
  openDetached.mockResolvedValue({ ok: true as const, windowId: 7, viewKey: DETACHED_VIEW_KEY });
  closeDetached.mockClear();
  closeDetached.mockResolvedValue({ ok: true as const });
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
  __resetMcpAppCardLocationStoreForTests();
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

  it("CLAMPS an absurd height — the only real bound (CSS max-height:100% caps nothing here)", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    act(() => {
      seededDeps().onResize({ height: 10_000_000 });
    });

    await waitFor(() =>
      expect((webviewNode(container) as HTMLElement).style.height).toBe(`${MCP_APP_CARD_MAX_HEIGHT_PX}px`),
    );
    // And the misleading percentage cap is gone: the px value IS the bound.
    expect((webviewNode(container) as HTMLElement).style.maxHeight).toBe("");
  });

  it("REFUSES a non-finite / non-positive size — the card keeps the height it had", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    act(() => {
      seededDeps().onResize({ height: 512 });
    });
    await waitFor(() => expect((webviewNode(container) as HTMLElement).style.height).toBe("512px"));

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -900]) {
      act(() => {
        seededDeps().onResize({ height: bad });
      });
      expect((webviewNode(container) as HTMLElement).style.height, `height=${String(bad)}`).toBe("512px");
    }
  });

  it("bounds the SERVER-declared height seed too (the payload is untrusted as well)", async () => {
    const { container } = renderCard({ serverId: "github", resourceUri: "ui://card/1", height: 10_000_000 });
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    expect((webviewNode(container) as HTMLElement).style.height).toBe(`${MCP_APP_CARD_MAX_HEIGHT_PX}px`);
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
    expect(seededContext().availableDisplayModes).toEqual(["inline", "fullscreen", "pip"]);
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

  it("fullscreen REPLACES the card: the detach seam is called with the session binding, and THIS mount stops being a live app", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());
    const transport = createMcpAppBridgeMock.mock.results[0]!.value.transport as {
      close: ReturnType<typeof vi.fn>;
    };

    const applied = await act(() => seededDisplayDeps().applyDisplayMode("fullscreen"));

    // No new window stack: the SAME `mcp.openDetached` the detach button uses, with the
    // maximize flag that makes it the fullscreen presentation — and the card's ORIGIN
    // SESSION, so the detached instance keeps a real binding (the app names neither).
    expect(openDetached).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "github" }),
      { maximize: true, sessionId: "" },
    );
    expect(applied).toBe("fullscreen");

    // THE FIX: replace, don't clone. The inline instance is gone — no <webview>, and its
    // bridge/transport were torn down. Exactly one live bridge exists for this card, and
    // it is the one in the detached window.
    await waitFor(() => expect(screen.getByTestId("mcp-app-detached")).toBeInTheDocument());
    expect(webviewNode(container)).toBeNull();
    expect(transport.close).toHaveBeenCalledTimes(1);
    // No second bridge was created in this mount.
    expect(createMcpAppBridgeMock).toHaveBeenCalledTimes(1);
  });

  it("NEVER reports a mode it is not in: the dormant inline mount stays `inline`, never `fullscreen`", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());
    const bridge = createMcpAppBridgeMock.mock.results[0]!.value.bridge as {
      setHostContext: ReturnType<typeof vi.fn>;
    };

    await act(() => seededDisplayDeps().applyDisplayMode("fullscreen"));

    // The old bug: this mount set `displayMode = "fullscreen"` and pushed it into its own
    // (still live) host context, so a spec-conformant app swapped to its fullscreen layout
    // inside a 300px transcript box. It must never publish that.
    expect(seededDisplayDeps().getDisplayMode()).toBe("inline");
    for (const call of bridge.setHostContext.mock.calls) {
      expect((call[0] as { displayMode?: string }).displayMode).not.toBe("fullscreen");
    }
  });

  it("revives the inline card when the host says the detached instance is gone (the round trip)", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    await act(() => seededDisplayDeps().applyDisplayMode("fullscreen"));
    await waitFor(() => expect(screen.getByTestId("mcp-app-detached")).toBeInTheDocument());

    // A close event for SOMEONE ELSE's detached window changes nothing.
    act(() => {
      detachedClosedHandler?.("mcp-app:ffff:other-card");
    });
    expect(screen.getByTestId("mcp-app-detached")).toBeInTheDocument();
    expect(webviewNode(container)).toBeNull();

    // The card's OWN detached instance closing (user X, the `inline` arm, or a shell
    // navigation — one event for all three) brings the inline card back to life: a fresh
    // <webview> and a second bridge, which is now again the ONLY live one.
    act(() => {
      detachedClosedHandler?.(DETACHED_VIEW_KEY);
    });
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());
    expect(screen.queryByTestId("mcp-app-detached")).toBeNull();
    expect(createMcpAppBridgeMock).toHaveBeenCalledTimes(2);
    // Still truthfully inline at every step.
    expect(seededDisplayDeps().getDisplayMode()).toBe("inline");
  });

  it("keeps the card where it is when the host DECLINES the detach", async () => {
    openDetached.mockResolvedValue({ ok: false, error: "invalid-payload" } as never);
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    const applied = await act(() => seededDisplayDeps().applyDisplayMode("fullscreen"));

    expect(applied).toBe("inline");
    expect(seededDisplayDeps().getDisplayMode()).toBe("inline");
    // The card never went dormant — the live bridge is still this one.
    expect(webviewNode(container)).toBeTruthy();
    expect(screen.queryByTestId("mcp-app-detached")).toBeNull();
  });

  it("inline (from fullscreen) closes ONLY this card's server's detached window — never every detached window", async () => {
    const closeAllDetached = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("lvisApi", { window: { closeAllDetached } });

    const { container } = render(<McpAppView payload={payload("github")} displayMode="fullscreen" />, {
      wrapper: ThemeWrapper,
    });
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    const applied = await act(() => seededDisplayDeps().applyDisplayMode("inline"));

    expect(closeDetached).toHaveBeenCalledWith("github");
    // The old bug: an untrusted card could sweep shut the user's unrelated detached views.
    expect(closeAllDetached).not.toHaveBeenCalled();
    expect(applied).toBe("inline");
    // This mount is the DETACHED presentation and says so until its window goes away.
    expect(seededDisplayDeps().getDisplayMode()).toBe("fullscreen");
  });

  it("leaves the detached card where it is when the scoped close fails", async () => {
    closeDetached.mockResolvedValue({ ok: false, error: "invalid-server-id" } as never);
    const { container } = render(<McpAppView payload={payload("github")} displayMode="fullscreen" />, {
      wrapper: ThemeWrapper,
    });
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    await expect(act(() => seededDisplayDeps().applyDisplayMode("inline"))).resolves.toBe("fullscreen");
  });

  it("is a no-op when the app asks for the mode it is already in", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    await expect(act(() => seededDisplayDeps().applyDisplayMode("inline"))).resolves.toBe("inline");
    expect(openDetached).not.toHaveBeenCalled();
    expect(closeDetached).not.toHaveBeenCalled();
  });
});

describe("McpAppView — pip (the shared location store, not a second window stack)", () => {
  function seededDisplayDeps() {
    return createMcpAppBridgeMock.mock.calls[0]![4] as {
      getDisplayMode: () => string;
      applyDisplayMode: (mode: string) => Promise<string>;
    };
  }

  function seededContext() {
    return createMcpAppBridgeMock.mock.calls[0]![3] as {
      displayMode?: string;
      availableDisplayModes?: string[];
    };
  }

  it("seeds a PIP mount with displayMode=pip", async () => {
    const { container } = render(<McpAppView payload={payload("github")} displayMode="pip" />, {
      wrapper: ThemeWrapper,
    });
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    expect(seededContext().displayMode).toBe("pip");
    expect(seededDisplayDeps().getDisplayMode()).toBe("pip");
  });

  it("inline -> pip: REPLACES the card — no IPC, no window, this mount stops being live", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());
    const transport = createMcpAppBridgeMock.mock.results[0]!.value.transport as {
      close: ReturnType<typeof vi.fn>;
    };

    const applied = await act(() => seededDisplayDeps().applyDisplayMode("pip"));

    expect(applied).toBe("pip");
    // Purely in-process: no detach IPC at all.
    expect(openDetached).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("mcp-app-pip")).toBeInTheDocument());
    expect(webviewNode(container)).toBeNull();
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(createMcpAppBridgeMock).toHaveBeenCalledTimes(1);
  });

  it("NEVER reports a mode it is not in: the dormant inline mount stays `inline`, never `pip`", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());
    const bridge = createMcpAppBridgeMock.mock.results[0]!.value.bridge as {
      setHostContext: ReturnType<typeof vi.fn>;
    };

    await act(() => seededDisplayDeps().applyDisplayMode("pip"));

    expect(seededDisplayDeps().getDisplayMode()).toBe("inline");
    for (const call of bridge.setHostContext.mock.calls) {
      expect((call[0] as { displayMode?: string }).displayMode).not.toBe("pip");
    }
  });

  it("pip -> inline: a SECOND mount (the pip surface) revives the home mount directly through the store — no IPC", async () => {
    const locationId = "shared-loc-pip-inline";

    // The HOME mount — explicit shared `locationId` so a second, independently
    // rendered McpAppView (below) can address the SAME store entry, exactly like
    // McpAppPipPanel does with the home's real (randomUUID) id.
    const home = render(<McpAppView payload={payload("github")} locationId={locationId} />, {
      wrapper: ThemeWrapper,
    });
    await waitFor(() => expect(webviewNode(home.container)).toBeTruthy());
    const homeDeps = () =>
      createMcpAppBridgeMock.mock.calls[0]![4] as { applyDisplayMode: (mode: string) => Promise<string> };

    await act(() => homeDeps().applyDisplayMode("pip"));
    await waitFor(() => expect(home.container.querySelector('[data-testid="mcp-app-pip"]')).toBeTruthy());
    expect(webviewNode(home.container)).toBeNull();

    // The PIP mount (McpAppPipPanel's own McpAppView instance) — SAME locationId, a
    // SEPARATE React tree, coexisting with the (now dormant) home mount.
    const pip = render(
      <McpAppView payload={payload("github")} displayMode="pip" locationId={locationId} />,
      { wrapper: ThemeWrapper },
    );
    await waitFor(() => expect(webviewNode(pip.container)).toBeTruthy());
    expect(createMcpAppBridgeMock).toHaveBeenCalledTimes(2); // home's (torn down) + pip's live one
    const pipDeps = () =>
      createMcpAppBridgeMock.mock.calls[1]![4] as { applyDisplayMode: (mode: string) => Promise<string> };

    // The app inside the PIP mount requests "inline".
    const applied = await act(() => pipDeps().applyDisplayMode("inline"));
    expect(applied).toBe("inline");

    // The home mount comes back to life — a fresh, THIRD bridge for it.
    await waitFor(() => expect(webviewNode(home.container)).toBeTruthy());
    expect(home.container.querySelector('[data-testid="mcp-app-pip"]')).toBeNull();
    expect(createMcpAppBridgeMock).toHaveBeenCalledTimes(3);
  });

  it("round trip inline -> pip -> inline keeps exactly ONE live bridge at every step (coexisting home + pip mounts)", async () => {
    const locationId = "shared-loc-round-trip";
    const home = render(<McpAppView payload={payload("github")} locationId={locationId} />, {
      wrapper: ThemeWrapper,
    });
    await waitFor(() => expect(webviewNode(home.container)).toBeTruthy());
    const homeDeps = () =>
      createMcpAppBridgeMock.mock.calls[0]![4] as { applyDisplayMode: (mode: string) => Promise<string> };

    // inline -> pip
    await act(() => homeDeps().applyDisplayMode("pip"));
    expect(webviewNode(home.container)).toBeNull(); // home: dormant

    const pip = render(
      <McpAppView payload={payload("github")} displayMode="pip" locationId={locationId} />,
      { wrapper: ThemeWrapper },
    );
    await waitFor(() => expect(webviewNode(pip.container)).toBeTruthy()); // pip: live
    // Exactly one <webview> across BOTH trees at this step.
    expect([webviewNode(home.container), webviewNode(pip.container)].filter(Boolean)).toHaveLength(1);
    const pipDeps = () =>
      createMcpAppBridgeMock.mock.calls[1]![4] as { applyDisplayMode: (mode: string) => Promise<string> };

    // pip -> inline
    await act(() => pipDeps().applyDisplayMode("inline"));
    await waitFor(() => expect(webviewNode(home.container)).toBeTruthy()); // home: live again
    // Still exactly one <webview> across both trees — the pip mount does not also
    // stay live (production McpAppPipPanel unmounts it via the occupant-null branch;
    // here we assert the STORE side, which is what makes that unmount correct: this
    // card's location is no longer "pip").
    const { getCardLocation } = await import("../../state/mcp-app-card-location-store.js");
    expect(getCardLocation(locationId)).toEqual({ kind: "inline" });
  });

  it("pip -> fullscreen: opens the detached window and moves the STORE location to detached", async () => {
    const locationId = "loc-shared-pip-fullscreen";
    const { container } = render(
      <McpAppView payload={payload("github")} displayMode="pip" locationId={locationId} />,
      { wrapper: ThemeWrapper },
    );
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    const applied = await act(() => seededDisplayDeps().applyDisplayMode("fullscreen"));

    expect(openDetached).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "github" }),
      { maximize: true, sessionId: "" },
    );
    expect(applied).toBe("fullscreen");
    // The STORE now says this card is detached — this is what `McpAppPipPanel` (the
    // pip mount's actual PARENT in production) reacts to by unmounting its child. An
    // away mount does NOT self-police via its own `location` read (only the home mount
    // does — see the `mountDisplayMode === "inline"` gate on the render branch), so THIS
    // isolated mount keeps rendering until something ELSE unmounts it; that is exactly
    // right, and is exercised at the panel level (McpAppPipPanel.test.tsx).
    const { getCardLocation } = await import("../../state/mcp-app-card-location-store.js");
    expect(getCardLocation(locationId)).toEqual({
      kind: "detached",
      viewKey: DETACHED_VIEW_KEY,
    });
  });

  it("fullscreen DECLINES a pip request — cross-window pip is out of scope (separate renderer process)", async () => {
    const { container } = render(<McpAppView payload={payload("github")} displayMode="fullscreen" />, {
      wrapper: ThemeWrapper,
    });
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    const applied = await act(() => seededDisplayDeps().applyDisplayMode("pip"));

    expect(applied).toBe("fullscreen");
    // Nothing was touched: no detach-close IPC, and the detached mount is still live.
    expect(closeDetached).not.toHaveBeenCalled();
    expect(webviewNode(container)).toBeTruthy();
  });

});

describe("McpAppView — home-mount unmount reclaims a leaked away entry (MAJOR-2)", () => {
  function homeDeps() {
    return createMcpAppBridgeMock.mock.calls[0]![4] as {
      applyDisplayMode: (mode: string) => Promise<string>;
    };
  }

  it("home-mount unmount while the card is in pip reclaims the entry and tears the bridge down", async () => {
    const { getCardLocation, getPipOccupant } = await import("../../state/mcp-app-card-location-store.js");
    const locationId = "loc-unmount-reclaim";

    // Production topology: a transcript HOME mount + the session-independent pip panel.
    const home = render(<McpAppView payload={payload("github")} locationId={locationId} />, {
      wrapper: ThemeWrapper,
    });
    await waitFor(() => expect(webviewNode(home.container)).toBeTruthy());
    const pip = render(<McpAppPipPanel />, { wrapper: ThemeWrapper });

    // The app moves the card to pip: the home goes dormant, the panel mounts a live away card.
    await act(() => homeDeps().applyDisplayMode("pip"));
    await waitFor(() => expect(pip.container.querySelector("webview")).toBeTruthy());
    expect(getCardLocation(locationId)).toEqual({ kind: "pip" });
    expect(webviewNode(home.container)).toBeNull(); // home dormant

    // The user leaves the conversation → the transcript child (the HOME mount) unmounts.
    home.unmount();

    // The leaked entry is reclaimed and the pip bridge torn down: store back to inline,
    // nobody occupies pip, and the panel renders nothing (its away McpAppView unmounted).
    await waitFor(() => expect(getPipOccupant()).toBeNull());
    expect(getCardLocation(locationId)).toEqual({ kind: "inline" });
    expect(pip.container.querySelector('[data-testid="mcp-app-pip-panel"]')).toBeNull();
  });

  it("a card in pip within a live conversation is NOT killed by an unrelated home re-render", async () => {
    const { getCardLocation, getPipOccupant } = await import("../../state/mcp-app-card-location-store.js");
    const locationId = "loc-rerender-safe";
    // Stable payload identity so a re-render does NOT re-run the payload effect (which
    // has its own fresh-card reclaim) — this isolates the unmount effect under test.
    const p = payload("github");

    const home = render(<McpAppView payload={p} locationId={locationId} />, { wrapper: ThemeWrapper });
    await waitFor(() => expect(webviewNode(home.container)).toBeTruthy());

    await act(() => homeDeps().applyDisplayMode("pip"));
    expect(getCardLocation(locationId)).toEqual({ kind: "pip" });

    // A benign re-render of the still-MOUNTED home (e.g. a parent state change) — no
    // unmount. The unmount cleanup must not fire, so the pip card survives.
    home.rerender(<McpAppView payload={p} locationId={locationId} />);

    expect(getCardLocation(locationId)).toEqual({ kind: "pip" });
    expect(getPipOccupant()?.cardId).toBe(locationId);
    // The home stayed mounted throughout, showing its own dormant pip placeholder.
    expect(home.container.querySelector('[data-testid="mcp-app-pip"]')).toBeTruthy();
  });
});

describe("McpAppView — download sink is BOUND to the card's server", () => {
  it("passes the card's serverId (the app names none) plus the spec params, untouched", async () => {
    downloadFile.mockClear();
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());
    const deps = createMcpAppBridgeMock.mock.calls[0]![4] as {
      downloadFile: (params: unknown) => Promise<{ ok: boolean }>;
    };

    const params = { contents: [{ type: "resource", resource: { uri: "ui://card/a.csv", text: "a,b" } }] };
    await deps.downloadFile(params);

    expect(downloadFile).toHaveBeenCalledWith("github", params);
  });
});

describe("McpAppView — model-context sink is BOUND to server + session + card", () => {
  it("supplies all three bindings the app cannot name, plus the spec params", async () => {
    postUiModelContext.mockClear();
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());
    const deps = createMcpAppBridgeMock.mock.calls[0]![4] as {
      updateModelContext: (params: unknown) => Promise<{ ok: boolean }>;
    };

    const params = { content: [{ type: "text", text: "cart: 3 items" }] };
    await deps.updateModelContext(params);

    expect(postUiModelContext).toHaveBeenCalledTimes(1);
    const [serverId, sessionId, cardId, forwarded] = postUiModelContext.mock.calls[0]!;
    expect(serverId).toBe("github");
    // No ChatContext in this harness → the origin session is empty, which is never the
    // live session id, so main drops the update. Fail-safe, same as `onmessage`.
    expect(sessionId).toBe("");
    // A card id the RENDERER minted: stable, non-empty, and never named by the app.
    expect(cardId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(forwarded).toEqual(params);
  });

  it("a DETACHED mount posts the host-threaded origin session, so its updates actually land", async () => {
    postUiModelContext.mockClear();
    // This is exactly how DetachedView mounts a card: no ChatContext anywhere in the tree
    // (the detached window's React root has no ChatContextProvider), and the origin session
    // threaded in from the host-owned detached record. Without the prop the card would post
    // "" and main would drop every update on the session check — forever, silently, since
    // `ui/update-model-context` has no error channel in the spec.
    const { container } = render(
      <McpAppView payload={payload("github")} displayMode="fullscreen" originSessionId="sess-abc" />,
      { wrapper: ThemeWrapper },
    );
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());
    const deps = createMcpAppBridgeMock.mock.calls[0]![4] as {
      updateModelContext: (params: unknown) => Promise<{ ok: boolean }>;
      postMessage: (params: unknown) => Promise<{ ok: boolean }>;
    };

    await deps.updateModelContext({ content: [{ type: "text", text: "cart: 3 items" }] });

    const [serverId, sessionId] = postUiModelContext.mock.calls[0]!;
    expect(serverId).toBe("github");
    expect(sessionId).toBe("sess-abc");
  });

  it("gives two mounted cards DIFFERENT ids, so one cannot overwrite the other's slot", async () => {
    postUiModelContext.mockClear();
    const first = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(first.container)).toBeTruthy());
    const second = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(second.container)).toBeTruthy());

    const depsOf = (index: number) =>
      createMcpAppBridgeMock.mock.calls[index]![4] as {
        updateModelContext: (params: unknown) => Promise<{ ok: boolean }>;
      };
    await depsOf(0).updateModelContext({ content: [] });
    await depsOf(1).updateModelContext({ content: [] });

    const cardIdA = postUiModelContext.mock.calls[0]![2];
    const cardIdB = postUiModelContext.mock.calls[1]![2];
    expect(cardIdA).not.toBe(cardIdB);
  });
});
