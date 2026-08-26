/**
 * Plugin UI Host — webview registration flow (#447 register-before-attach)
 *
 * Verifies that PluginUiHostView:
 *   1. Mounts <webview> with the shell URL initially so preload runs in the
 *      right renderer world.
 *   2. Registers the webview as soon as its webContentsId is available,
 *      including the cold-boot path where did-attach is missed by the host.
 *   3. Falls back to error text when asset URLs are missing.
 *   4. Shows error text when registration fails.
 *   5. Ignores failed child-frame navigations without retiring the guest.
 *
 * JSDOM has no real Electron webview — tests assert JSX shape and event
 * handling only, not actual Electron IPC or preload execution.
 */
import "./setup.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { PluginUiHostView, type PluginUiExtensionView } from "../../src/plugin-ui-host.js";

const SHELL_URL = "file:///c:/dist/src/plugin-ui-shell.html";
const PRELOAD_URL = "file:///c:/dist/src/plugin-preload.js";

const VIEW: PluginUiExtensionView = {
  pluginId: "com.example.test-plugin",
  extension: {
    id: "test-view",
    slot: "sidebar",
    kind: "embedded-module",
    title: "Test",
    entry: "ui/index.js",
    exportName: "mount",
  },
  entryUrl: "file:///c:/plugins/example/dist/ui/index.js",
};

let activeRoot: Root | null = null;

function mountHost(view: PluginUiExtensionView | null): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  activeRoot = root;
  act(() => {
    root.render(<PluginUiHostView view={view} />);
  });
  return container;
}

/**
 * Fire a synthetic did-attach event. The host reads the webContentsId via
 * the canonical `node.getWebContentsId()` accessor (#498), not via an
 * `e.webContentsId` payload (which the real Electron event doesn't carry),
 * so the helper stubs the method on the webview element.
 */
function fireDidAttach(webview: Element, webContentsId: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (webview as any).getWebContentsId = () => webContentsId;
  webview.dispatchEvent(new Event("did-attach"));
}

function fireDidFailLoad(webview: Element, isMainFrame: boolean) {
  const event = new Event("did-fail-load");
  Object.defineProperty(event, "isMainFrame", { value: isMainFrame });
  webview.dispatchEvent(event);
}

afterEach(() => {
  if (activeRoot) {
    act(() => activeRoot!.unmount());
    activeRoot = null;
  }
  for (const el of Array.from(document.body.children)) {
    el.remove();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (HTMLElement.prototype as any).getWebContentsId;
  vi.unstubAllGlobals();
});

describe("PluginUiHostView — webview attach flow", () => {
  it("mounts webview with src=shellUrl from the start (preload only runs at first attach)", async () => {
    // #498: `<webview preload>` runs ONLY at first guest attach — subsequent
    // navigations do NOT re-execute preload, so the shell src must already
    // be the real shell URL on initial mount or `lvisPlugin` will be missing
    // in the new main world. The race vs registerPluginWebview is absorbed
    // by the host's `pendingEntryUrlResolvers` queue + the shell's 6s retry
    // budget.
    const registerPluginWebview = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("lvisApi", {
      pluginShellUrl: SHELL_URL,
      pluginPreloadUrl: PRELOAD_URL,
      registerPluginWebview,
    });

    const container = mountHost(VIEW);
    const webview = container.querySelector("webview");

    expect(webview).not.toBeNull();
    expect(webview?.getAttribute("src")).toBe(SHELL_URL);
    expect(webview?.getAttribute("preload")).toBe(PRELOAD_URL);

    // did-attach still fires registerPluginWebview so the host can resolve
    // the shell's getEntryUrl request once the binding lands.
    await act(async () => {
      fireDidAttach(webview!, 42);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(registerPluginWebview).toHaveBeenCalledWith({
      webContentsId: 42,
      pluginId: VIEW.pluginId,
      entryUrl: VIEW.entryUrl,
    });
    expect(webview?.getAttribute("src")).toBe(SHELL_URL);
  });

  it("registers from the ref lifecycle when did-attach is missed on cold boot", async () => {
    const registerPluginWebview = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("lvisApi", {
      pluginShellUrl: SHELL_URL,
      pluginPreloadUrl: PRELOAD_URL,
      registerPluginWebview,
    });
    // Model the real accessor: Electron THROWS on a guest that is not attached
    // yet. The previous stub returned an id unconditionally, so it certified a
    // path production never takes — the host called it from `did-start-loading`
    // and from a microtask queued in the ref callback, and both threw on every
    // mount (measured: 90 uncaught exceptions over 27s on a cold boot).
    let attached = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (HTMLElement.prototype as any).getWebContentsId = () => {
      if (!attached) {
        throw new Error(
          "The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.",
        );
      }
      return 84;
    };

    const container = mountHost(VIEW);
    const webview = container.querySelector("webview");
    expect(webview).not.toBeNull();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // Nothing has attached yet, so nothing may have been read or registered.
    expect(registerPluginWebview).toHaveBeenCalledTimes(0);

    // did-attach missed; the guest lifecycle events still carry the handshake.
    attached = true;
    await act(async () => {
      webview!.dispatchEvent(new Event("dom-ready"));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(registerPluginWebview).toHaveBeenCalledTimes(1);
    expect(registerPluginWebview).toHaveBeenCalledWith({
      webContentsId: 84,
      pluginId: VIEW.pluginId,
      entryUrl: VIEW.entryUrl,
    });

    // Later guest events must not re-register.
    await act(async () => {
      webview!.dispatchEvent(new Event("did-finish-load"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(registerPluginWebview).toHaveBeenCalledTimes(1);
  });

  it("keeps the live webview when an equal-valued view object arrives", async () => {
    const registerPluginWebview = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("lvisApi", {
      pluginShellUrl: SHELL_URL,
      pluginPreloadUrl: PRELOAD_URL,
      registerPluginWebview,
      ensurePluginPartition: vi.fn().mockResolvedValue({ ok: true }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (HTMLElement.prototype as any).getWebContentsId = () => 84;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    activeRoot = root;
    act(() => { root.render(<PluginUiHostView view={VIEW} />); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const first = container.querySelector("webview");
    expect(first).not.toBeNull();

    // `activePluginView` is `pluginViews.find(...)`, so any upstream refresh
    // hands down a fresh object with identical contents. That must not tear
    // the guest down: doing so re-runs ensurePluginPartition and remounts,
    // and on repeated churn becomes the ~0.7s mount/unmount flicker loop.
    await act(async () => {
      root.render(<PluginUiHostView view={{ ...VIEW, extension: { ...VIEW.extension } }} />);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.querySelector("webview")).toBe(first);
  });

  it("remounts the webview when the plugin runtime revision changes", () => {
    const registerPluginWebview = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("lvisApi", {
      pluginShellUrl: SHELL_URL,
      pluginPreloadUrl: PRELOAD_URL,
      registerPluginWebview,
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    activeRoot = root;

    act(() => {
      root.render(<PluginUiHostView view={{ ...VIEW, runtimeRevision: 1 }} />);
    });
    const firstWebview = container.querySelector("webview");
    expect(firstWebview).not.toBeNull();

    act(() => {
      root.render(<PluginUiHostView view={{ ...VIEW, runtimeRevision: 2 }} />);
    });
    const secondWebview = container.querySelector("webview");

    expect(secondWebview).not.toBeNull();
    expect(secondWebview).not.toBe(firstWebview);
  });

  it("shows error text and removes webview when registration returns ok=false", async () => {
    const registerPluginWebview = vi.fn().mockResolvedValue({ ok: false, error: "unknown-plugin-id" });
    vi.stubGlobal("lvisApi", {
      pluginShellUrl: SHELL_URL,
      pluginPreloadUrl: PRELOAD_URL,
      registerPluginWebview,
    });

    const container = mountHost(VIEW);
    const webview = container.querySelector("webview");
    expect(webview).not.toBeNull();

    await act(async () => {
      fireDidAttach(webview!, 7);
      await new Promise((r) => setTimeout(r, 0));
    });

    // After failed registration: error text replaces the webview.
    expect(container.querySelector("webview")).toBeNull();
    expect(container.textContent).toMatch(/unknown-plugin-id/);
  });

  it("keeps the guest alive when only a child-frame navigation fails", () => {
    vi.stubGlobal("lvisApi", {
      pluginShellUrl: SHELL_URL,
      pluginPreloadUrl: PRELOAD_URL,
      registerPluginWebview: vi.fn().mockResolvedValue({ ok: true }),
    });

    const container = mountHost(VIEW);
    const webview = container.querySelector("webview");
    expect(webview).not.toBeNull();

    act(() => {
      fireDidFailLoad(webview!, false);
    });

    expect(container.querySelector("webview")).toBe(webview);
  });

  it("shows an error and retires the guest when its main frame fails", () => {
    vi.stubGlobal("lvisApi", {
      pluginShellUrl: SHELL_URL,
      pluginPreloadUrl: PRELOAD_URL,
      registerPluginWebview: vi.fn().mockResolvedValue({ ok: true }),
    });

    const container = mountHost(VIEW);
    const webview = container.querySelector("webview");
    expect(webview).not.toBeNull();

    act(() => {
      fireDidFailLoad(webview!, true);
    });

    expect(container.querySelector("webview")).toBeNull();
    expect(container.textContent ?? "").not.toBe("");
  });

  it("falls back to error text when lvisApi.pluginShellUrl is missing", () => {
    vi.stubGlobal("lvisApi", { pluginPreloadUrl: PRELOAD_URL });

    const container = mountHost(VIEW);

    const webview = container.querySelector("webview");
    expect(webview).toBeNull();
    expect(container.textContent ?? "").toMatch(/lvisApi/);
  });

  it("falls back to error text when lvisApi.pluginPreloadUrl is missing", () => {
    vi.stubGlobal("lvisApi", { pluginShellUrl: SHELL_URL });

    const container = mountHost(VIEW);

    const webview = container.querySelector("webview");
    expect(webview).toBeNull();
    expect(container.textContent ?? "").toMatch(/lvisApi/);
  });
});

describe("PluginUiHostView — webview security attributes", () => {
  /**
   * These are the RENDERER's request. Main enforces the same three values at
   * `will-attach-webview` (`src/main/plugin-webview-attach.ts`), which is what
   * actually holds — a `webpreferences` string is ignored key-by-key when
   * mistyped, and it is a DOM attribute in a renderer that may itself be the
   * thing compromised.
   *
   * Pinned anyway so the two sides cannot silently disagree. A request that
   * drifts from what main enforces is how a future reader concludes the wrong
   * one is authoritative.
   */
  it("requests the isolated, unprivileged configuration", () => {
    vi.stubGlobal("lvisApi", {
      pluginShellUrl: SHELL_URL,
      pluginPreloadUrl: PRELOAD_URL,
      registerPluginWebview: vi.fn().mockResolvedValue({ ok: true }),
    });

    const prefs = mountHost(VIEW).querySelector("webview")?.getAttribute("webpreferences") ?? "";

    expect(prefs).toContain("contextIsolation=yes");
    expect(prefs).toContain("nodeIntegration=no");
    expect(prefs).toContain("sandbox=yes");
  });

  it("runs the plugin in its own session partition", () => {
    // Storage siloing, and the key main's attach guard matches on to decide
    // that this frame is a plugin frame at all.
    vi.stubGlobal("lvisApi", {
      pluginShellUrl: SHELL_URL,
      pluginPreloadUrl: PRELOAD_URL,
      registerPluginWebview: vi.fn().mockResolvedValue({ ok: true }),
    });

    const partition = mountHost(VIEW).querySelector("webview")?.getAttribute("partition") ?? "";
    expect(partition).toMatch(/^persist:plugin:[0-9a-f]{8}$/);
  });
});

describe("PluginUiHostView — panel width", () => {
  /**
   * The panel used to be clamped to the chat reading column (max-w-[58rem]).
   * That clamp was compensation: the plugin UIs were authored for a ~800px
   * detached window, so the host pinned the panel narrow rather than let their
   * non-adapting layouts show. Measured consequence — at a 2200px window the
   * shell had 1960px available and the webview still rendered at 912px.
   *
   * The plugins now cap their own content column, so the clamp only wasted
   * width. Pinned here because nothing else can see it: typecheck, build and
   * every other test pass either way, and the regression is invisible until
   * someone opens a plugin panel on a wide screen.
   */
  it("hands the plugin the full pane instead of the reading column", () => {
    vi.stubGlobal("lvisApi", {
      pluginShellUrl: SHELL_URL,
      pluginPreloadUrl: PRELOAD_URL,
      registerPluginWebview: vi.fn().mockResolvedValue({ ok: true }),
    });

    const container = mountHost(VIEW);

    // Assert the shell rendered first. Without this, a shell that failed to
    // render at all would satisfy the "no clamp" check and read as a pass.
    expect(container.querySelector('[data-testid="plugin-page-shell"]')).not.toBeNull();

    // The clamp lives on the shell's inner column, not on the testid node.
    expect(container.querySelector('[class*="max-w-[58rem]"]')).toBeNull();
  });
});
