// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LvisApi } from "../../types.js";
import type { ChatPreviewTarget, WorkspaceFileItem } from "../../preview/preview-targets.js";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { LVIS_SIDE_BROWSER_PARTITION } from "../../../../shared/side-browser.js";
import { ChatSidePanel } from "../ChatSidePanel.js";
import { useWorkspaceTabs } from "../../preview/workspace-tabs.js";

function api(): LvisApi {
  return {
    openExternalUrl: vi.fn(async () => ({ ok: true })),
    chatGetVerbatimToolResult: vi.fn(async () => null),
  } as unknown as LvisApi;
}

function renderPanel(ui: ReactElement) {
  return render(
    <TooltipProvider>
      {ui}
    </TooltipProvider>,
  );
}

/**
 * Open the tab-bar "+" dropdown and pick a kind (mirrors the launcher menu).
 * Radix DropdownMenu opens on pointerdown, so fire that before the click.
 */
function openLauncherMenu() {
  const trigger = screen.getByTestId("chat-side-panel-add-tab");
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
}
function addTabViaMenu(kind: "preview" | "file-browser" | "browser" | "terminal") {
  openLauncherMenu();
  fireEvent.click(screen.getByTestId(`chat-side-panel-launcher-menu-${kind}`));
}

/**
 * Panel harness that owns the workspace-tab store the same way the real
 * ChatView does (via `useWorkspaceTabs`), plus the selected-preview state. The
 * store lives ABOVE the ChatSidePanel mount so tab state survives the panel
 * unmounting — the whole point of lifting it out of the component.
 */
function HarnessPanel({
  api,
  sessionId,
  targets,
  files,
  initialSelectedId,
  panelMounted = true,
}: {
  api: LvisApi;
  sessionId?: string;
  targets: ChatPreviewTarget[];
  files: WorkspaceFileItem[];
  initialSelectedId: string | null;
  panelMounted?: boolean;
}) {
  const [selectedId, setSelectedId] = useState(initialSelectedId);
  const workspaceTabs = useWorkspaceTabs();
  if (!panelMounted) return null;
  return (
    <ChatSidePanel
      api={api}
      sessionId={sessionId}
      targets={targets}
      files={files}
      selectedId={selectedId}
      onSelect={setSelectedId}
      workspaceTabs={workspaceTabs}
      onClose={vi.fn()}
    />
  );
}

describe("ChatSidePanel", () => {
  beforeEach(() => {
    // File-browser tabs mount ProjectRootsBrowser (workspace.*) and
    // FilePreviewBody (preview.readFile); provide sane default stubs so the
    // panel renders without a real preload bridge.
    vi.stubGlobal("lvis", {
      attach: { openExternal: vi.fn(async () => ({ ok: true })) },
      preview: {
        readFile: vi.fn(async () => ({ ok: true, content: "# preview", path: "/tmp/x.md", truncated: false })),
      },
      workspace: {
        listRoots: vi.fn(async () => ({ ok: true, defaultRoot: "/ws", roots: [{ path: "/ws", isDefault: true }] })),
        pickRoot: vi.fn(async () => ({ ok: true, canceled: true, roots: [{ path: "/ws", isDefault: true }] })),
        listDir: vi.fn(async () => ({ ok: true, path: "/ws", entries: [], truncated: false })),
        removeRoot: vi.fn(async () => ({ ok: true, removed: "", roots: [{ path: "/ws", isDefault: true }] })),
        reveal: vi.fn(async () => ({ ok: true })),
        addRootByPath: vi.fn(async () => ({ ok: true, roots: [{ path: "/ws", isDefault: true }] })),
      },
    });
    (window as unknown as { lvis: unknown }).lvis = (globalThis as unknown as { lvis: unknown }).lvis;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens empty: shows the launcher with four items and shortcut hints, no tabs, no counts", () => {
    renderPanel(
      <HarnessPanel
        api={api()}
        sessionId="session-1"
        targets={[]}
        files={[]}
        initialSelectedId={null}
      />,
    );

    // Empty workspace -> launcher, no tab bar.
    expect(screen.getByTestId("chat-side-panel-launcher")).toBeTruthy();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByTestId("chat-side-panel-tab-actions")).toBeNull();

    // Four launcher items.
    expect(screen.getByTestId("chat-side-panel-launcher-preview")).toBeTruthy();
    expect(screen.getByTestId("chat-side-panel-launcher-terminal")).toBeTruthy();
    expect(screen.getByTestId("chat-side-panel-launcher-browser")).toBeTruthy();
    expect(screen.getByTestId("chat-side-panel-launcher-file-browser")).toBeTruthy();

    // Shortcut hints are displayed for the bound items.
    expect(screen.getByText("⌃⇧G")).toBeTruthy();
    expect(screen.getByText("⌘T")).toBeTruthy();
    expect(screen.getByText("⌘P")).toBeTruthy();
  });

  it("launcher click opens the correct-kind tab", () => {
    renderPanel(
      <HarnessPanel
        api={api()}
        sessionId="session-1"
        targets={[]}
        files={[]}
        initialSelectedId={null}
      />,
    );

    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-browser"));
    // Launcher gone, a browser tab is active.
    expect(screen.queryByTestId("chat-side-panel-launcher")).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByTestId("chat-side-panel-tab-browser")).toBeTruthy();
    expect(screen.getByTestId("chat-side-panel-browser-workspace")).toBeTruthy();
  });

  it("launcher keyboard shortcut opens the mapped tab (⌘T -> browser)", () => {
    renderPanel(
      <HarnessPanel
        api={api()}
        sessionId="session-1"
        targets={[]}
        files={[]}
        initialSelectedId={null}
      />,
    );

    fireEvent.keyDown(window, { key: "t", metaKey: true });
    expect(screen.queryByTestId("chat-side-panel-launcher")).toBeNull();
    expect(screen.getByTestId("chat-side-panel-tab-browser")).toBeTruthy();
  });

  it("tab-bar exposes a single '+' launcher dropdown, not scattered add buttons", () => {
    renderPanel(
      <HarnessPanel
        api={api()}
        sessionId="session-1"
        targets={[]}
        files={[]}
        initialSelectedId={null}
      />,
    );

    // Open one tab so the tab bar (and its actions) render.
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    // Single "+" button; the old per-kind add buttons are gone.
    expect(screen.getByTestId("chat-side-panel-add-tab")).toBeTruthy();
    expect(screen.queryByTestId("chat-side-panel-add-browser-tab")).toBeNull();
    expect(screen.queryByTestId("chat-side-panel-add-preview-tab")).toBeNull();
    expect(screen.queryByTestId("chat-side-panel-add-terminal-tab")).toBeNull();
    expect(screen.queryByTestId("chat-side-panel-add-file-browser-tab")).toBeNull();

    // The "+" dropdown opens the same launcher items and creates a tab.
    openLauncherMenu();
    expect(screen.getByTestId("chat-side-panel-launcher-menu-browser")).toBeTruthy();
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-menu-browser"));
    expect(screen.getByTestId("chat-side-panel-tab-browser")).toBeTruthy();
    expect(screen.getAllByRole("tab").length).toBe(2);
  });

  it("closing the last tab returns to the launcher", () => {
    renderPanel(
      <HarnessPanel
        api={api()}
        sessionId="session-1"
        targets={[]}
        files={[]}
        initialSelectedId={null}
      />,
    );

    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-terminal"));
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    // Every tab is closeable — click the close affordance.
    fireEvent.click(screen.getByLabelText(/Close tab|탭 닫기/i));
    expect(screen.getByTestId("chat-side-panel-launcher")).toBeTruthy();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("tab bar shows no count badge", () => {
    const targets: ChatPreviewTarget[] = [
      {
        id: "json-1",
        kind: "json",
        title: "metrics.json",
        sourceLabel: "builtin",
        createdOrder: 0,
        value: { ok: true },
        raw: "{\"ok\":true}",
      },
      {
        id: "json-2",
        kind: "json",
        title: "other.json",
        sourceLabel: "builtin",
        createdOrder: 1,
        value: { ok: false },
        raw: "{\"ok\":false}",
      },
    ];
    renderPanel(
      <HarnessPanel
        api={api()}
        sessionId="session-1"
        targets={targets}
        files={[]}
        initialSelectedId={null}
      />,
    );

    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-preview"));
    const tab = screen.getByTestId("chat-side-panel-tab-preview");
    // Label shows content name + ordinal only — no "2" count of preview targets.
    expect(tab.textContent).not.toMatch(/2/);
  });

  it("renders preview targets and separates browser artifacts and files across tabs", () => {
    const targets: ChatPreviewTarget[] = [
      {
        id: "file-1",
        kind: "file",
        title: "report.md",
        subtitle: "read_file",
        sourceLabel: "builtin",
        createdOrder: 0,
        path: "C:\\workspace\\report.md",
        canOpenExternal: false,
      },
      {
        id: "html-1",
        kind: "html",
        title: "Artifact dashboard",
        subtitle: "render_html",
        sourceLabel: "builtin",
        createdOrder: 1,
        payload: { html: "<main>Preview OK</main>", title: "Artifact dashboard", height: 200 },
      },
      {
        id: "url-1",
        kind: "url",
        title: "example.com/docs",
        subtitle: "web_fetch",
        sourceLabel: "builtin",
        createdOrder: 2,
        url: "https://example.com/docs",
      },
      {
        id: "json-1",
        kind: "json",
        title: "metrics.json",
        sourceLabel: "builtin",
        createdOrder: 3,
        value: { ok: true },
        raw: "{\"ok\":true}",
      },
    ];
    const files: WorkspaceFileItem[] = [
      {
        id: "tool:C:\\workspace\\report.md",
        path: "C:\\workspace\\report.md",
        label: "report.md",
        detail: "C:/workspace/report.md",
        sourceLabel: "read_file",
        operation: "read",
        previewTargetId: "file-1",
        canOpenExternal: false,
      },
    ];

    const { container } = renderPanel(
      <HarnessPanel
        api={api()}
        sessionId="session-1"
        targets={targets}
        files={files}
        initialSelectedId="file-1"
      />,
    );

    // Open a file-browser tab from the launcher and confirm the file shows.
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    expect(screen.getByTestId("chat-side-panel-file-tree")).toHaveTextContent("report.md");
    const splitLayout = screen.getByTestId("chat-side-panel-file-split-layout") as HTMLElement;
    const splitter = screen.getByTestId("chat-side-panel-file-splitter");
    expect(splitLayout.style.gridTemplateRows).toContain("45%");
    fireEvent.keyDown(splitter, { key: "ArrowDown" });
    expect(splitLayout.style.gridTemplateRows).toContain("50%");

    // Open a browser tab via the "+" dropdown (replaces scattered add buttons).
    addTabViaMenu("browser");
    expect(screen.getAllByText("Artifact dashboard").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("example.com/docs").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId("chat-side-panel-browser-viewer")).toBeTruthy();

    const addressInput = screen.getByTestId("chat-side-panel-browser-address") as HTMLInputElement;
    fireEvent.change(addressInput, { target: { value: "google.com" } });
    fireEvent.click(screen.getByTestId("chat-side-panel-browser-go"));
    const manualWebview = container.querySelector('[data-testid="chat-side-panel-browser-webview"]');
    expect(manualWebview).not.toBeNull();
    expect(manualWebview?.getAttribute("src")).toBe("https://google.com/");

    fireEvent.click(screen.getAllByTestId("chat-side-panel-browser-row")[1]!);
    const webview = container.querySelector('[data-testid="chat-side-panel-browser-webview"]');
    expect(webview?.getAttribute("src")).toBe("https://example.com/docs");
    expect(webview?.getAttribute("partition")).toBe(LVIS_SIDE_BROWSER_PARTITION);
    expect(webview?.getAttribute("webpreferences")).toContain("javascript=yes");

    // Open a preview (review) tab via the "+" dropdown.
    addTabViaMenu("preview");
    expect(screen.queryByText("Artifact dashboard")).toBeNull();
    expect(screen.getAllByText("metrics.json").length).toBeGreaterThanOrEqual(1);
  });

  it("preserves added workspace tabs across a ChatSidePanel unmount (session switch)", () => {
    // The store lives above the panel (in the harness, mirroring ChatView), so
    // unmounting the panel — as happens on a session switch, leaving home, or
    // closing the rail — must NOT lose tab state.
    const targets: ChatPreviewTarget[] = [];
    const files: WorkspaceFileItem[] = [];

    const { rerender } = renderPanel(
      <HarnessPanel
        api={api()}
        sessionId="session-1"
        targets={targets}
        files={files}
        initialSelectedId={null}
      />,
    );

    // Empty at mount (launcher, no tabs).
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    // Add a browser tab via the launcher.
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-browser"));
    expect(screen.getAllByRole("tab")).toHaveLength(1);

    // Unmount the panel (session switch / rail close) — the harness (store)
    // stays mounted, exactly like ChatView across the conditional render.
    rerender(
      <TooltipProvider>
        <HarnessPanel
          api={api()}
          sessionId="session-2"
          targets={targets}
          files={files}
          initialSelectedId={null}
          panelMounted={false}
        />
      </TooltipProvider>,
    );
    expect(screen.queryByTestId("chat-side-panel")).toBeNull();

    // Remount the panel — the added tab is still present (state survived).
    rerender(
      <TooltipProvider>
        <HarnessPanel
          api={api()}
          sessionId="session-2"
          targets={targets}
          files={files}
          initialSelectedId={null}
        />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("chat-side-panel")).toBeTruthy();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("renders MCP app payloads through McpAppView in a preview tab", async () => {
    const readUiResource = vi.fn(async () => "<main>MCP preview card</main>");
    vi.stubGlobal("lvis", {
      mcp: { readUiResource },
    });
    (window as unknown as { lvis: unknown }).lvis = {
      mcp: { readUiResource },
    };
    const targets: ChatPreviewTarget[] = [
      {
        id: "plugin-1",
        kind: "plugin",
        title: "MCP card",
        subtitle: "ui://server-a/card",
        sourceLabel: "mcp:server-a",
        createdOrder: 0,
        serverId: "server-a",
        resourceUri: "ui://server-a/card",
        slot: "sidebar",
        height: 180,
        payload: {
          serverId: "server-a",
          resourceUri: "ui://server-a/card",
          slot: "sidebar",
          height: 180,
          title: "MCP card",
        },
      },
    ];

    const { container } = renderPanel(
      <HarnessPanel
        api={api()}
        sessionId="session-1"
        targets={targets}
        files={[]}
        initialSelectedId="plugin-1"
      />,
    );

    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-preview"));
    await waitFor(() => {
      expect(readUiResource).toHaveBeenCalledWith("server-a", "ui://server-a/card");
    });
    const webview = await waitFor(() => {
      const el = container.querySelector("webview");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(webview.getAttribute("src")).toContain("MCP%20preview%20card");
  });

  it("file-browser tab renders the project-roots browser and a scrollable tab strip (diagnosis ②③)", () => {
    renderPanel(
      <HarnessPanel api={api()} sessionId="session-1" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    expect(screen.getByTestId("chat-side-panel-project-roots")).toBeTruthy();
    // The tab strip is the drag/scroll container (role=tablist with the ref).
    expect(screen.getByTestId("chat-side-panel-tab-scroll")).toBeTruthy();
  });

  it("adding a project folder calls workspace.pickRoot (diagnosis ③)", async () => {
    const pickRoot = vi.fn(async () => ({
      ok: true as const,
      added: "/ws/proj",
      roots: [
        { path: "/ws", isDefault: true },
        { path: "/ws/proj", isDefault: false },
      ],
    }));
    vi.stubGlobal("lvis", {
      attach: { openExternal: vi.fn(async () => ({ ok: true })) },
      preview: { readFile: vi.fn(async () => ({ ok: true, content: "# x", path: "/ws/a.md", truncated: false })) },
      workspace: {
        listRoots: vi.fn(async () => ({ ok: true, defaultRoot: "/ws", roots: [{ path: "/ws", isDefault: true }] })),
        pickRoot,
        listDir: vi.fn(async () => ({ ok: true, path: "/ws", entries: [], truncated: false })),
      },
    });
    (window as unknown as { lvis: unknown }).lvis = (globalThis as unknown as { lvis: unknown }).lvis;

    renderPanel(
      <HarnessPanel api={api()} sessionId="session-1" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    fireEvent.click(screen.getByTestId("chat-side-panel-add-root"));
    await waitFor(() => expect(pickRoot).toHaveBeenCalledTimes(1));
  });

  it("opens a filesystem file's content through the traversal-guarded preview IPC (diagnosis ①)", async () => {
    const readFile = vi.fn(async () => ({
      ok: true as const,
      content: "# Architecture\n\nreal content",
      path: "/ws/docs/architecture.md",
      truncated: false,
    }));
    vi.stubGlobal("lvis", {
      attach: { openExternal: vi.fn(async () => ({ ok: true })) },
      preview: { readFile },
      workspace: {
        listRoots: vi.fn(async () => ({ ok: true, defaultRoot: "/ws", roots: [{ path: "/ws", isDefault: true }] })),
        pickRoot: vi.fn(async () => ({ ok: true, canceled: true, roots: [{ path: "/ws", isDefault: true }] })),
        listDir: vi.fn(async (p: string) =>
          p === "/ws"
            ? { ok: true, path: "/ws", entries: [{ name: "architecture.md", path: "/ws/docs/architecture.md", type: "file" }], truncated: false }
            : { ok: true, path: p, entries: [], truncated: false },
        ),
      },
    });
    (window as unknown as { lvis: unknown }).lvis = (globalThis as unknown as { lvis: unknown }).lvis;

    renderPanel(
      <HarnessPanel api={api()} sessionId="session-1" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    const fileRow = await screen.findByTestId("chat-side-panel-fs-file");
    fireEvent.click(fileRow);
    await waitFor(() => expect(readFile).toHaveBeenCalledWith("/ws/docs/architecture.md"));
    // The real content (not a path-only placeholder) renders in the detail pane.
    await screen.findByTestId("chat-side-panel-file-preview");
    await waitFor(() => expect(screen.getByText(/real content/)).toBeTruthy());
  });

  it("does not loop listDir when the active root fails to list", async () => {
    const listDir = vi.fn(async () => ({ ok: false as const, error: "read-failed" as const }));
    vi.stubGlobal("lvis", {
      attach: { openExternal: vi.fn(async () => ({ ok: true })) },
      preview: { readFile: vi.fn(async () => ({ ok: true, content: "", path: "/ws/x", truncated: false })) },
      workspace: {
        listRoots: vi.fn(async () => ({ ok: true, defaultRoot: "/ws", roots: [{ path: "/ws", isDefault: true }] })),
        pickRoot: vi.fn(async () => ({ ok: true, canceled: true, roots: [{ path: "/ws", isDefault: true }] })),
        listDir,
      },
    });
    (window as unknown as { lvis: unknown }).lvis = (globalThis as unknown as { lvis: unknown }).lvis;

    renderPanel(
      <HarnessPanel api={api()} sessionId="session-1" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));

    // The failing active-root load surfaces an error and is NOT retried forever.
    await screen.findByTestId("chat-side-panel-fs-error");
    const callsAfterError = listDir.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    // No additional IPC after the failure settled — the render→IPC loop is broken.
    expect(listDir.mock.calls.length).toBe(callsAfterError);
    expect(callsAfterError).toBeLessThanOrEqual(2);
  });

  it("requires acknowledgement before persisting a folder with adjacency warnings", async () => {
    const pickRoot = vi.fn(async (opts?: { ackToken?: string }) => {
      if (opts?.ackToken) {
        // Main resolves the token to its bound path — the renderer never names it.
        return {
          ok: true as const,
          added: "/ws/.git",
          roots: [
            { path: "/ws", isDefault: true },
            { path: "/ws/.git", isDefault: false },
          ],
        };
      }
      return {
        ok: true as const,
        requiresAcknowledgement: true as const,
        pendingPath: "/ws/.git",
        ackToken: "tok-abc",
        warnings: ["path contains '.git' segment — secrets may be exposed if added"],
        roots: [{ path: "/ws", isDefault: true }],
      };
    });
    vi.stubGlobal("lvis", {
      attach: { openExternal: vi.fn(async () => ({ ok: true })) },
      preview: { readFile: vi.fn(async () => ({ ok: true, content: "", path: "/ws/x", truncated: false })) },
      workspace: {
        listRoots: vi.fn(async () => ({ ok: true, defaultRoot: "/ws", roots: [{ path: "/ws", isDefault: true }] })),
        pickRoot,
        listDir: vi.fn(async () => ({ ok: true, path: "/ws", entries: [], truncated: false })),
      },
    });
    (window as unknown as { lvis: unknown }).lvis = (globalThis as unknown as { lvis: unknown }).lvis;

    renderPanel(
      <HarnessPanel api={api()} sessionId="session-1" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    fireEvent.click(screen.getByTestId("chat-side-panel-add-root"));

    // Warning banner appears; the pick was NOT persisted (no ack yet).
    await screen.findByTestId("chat-side-panel-root-warning");
    expect(pickRoot).toHaveBeenCalledTimes(1);
    expect(pickRoot).toHaveBeenLastCalledWith();

    // Confirm → pickRoot re-invoked with the one-time TOKEN (never a path).
    fireEvent.click(screen.getByTestId("chat-side-panel-root-warning-confirm"));
    await waitFor(() => expect(pickRoot).toHaveBeenCalledTimes(2));
    expect(pickRoot).toHaveBeenLastCalledWith({ ackToken: "tok-abc" });
    await waitFor(() => expect(screen.queryByTestId("chat-side-panel-root-warning")).toBeNull());
  });

  // ── ProjectRootsBrowser: keyboard nav + a11y + context menu + remove root ──

  /** Stub whose /ws lists two folders and one file; /ws/alpha lists one child. */
  function stubRichWorkspace(overrides?: Record<string, unknown>) {
    const listDir = vi.fn(async (p: string) => {
      if (p === "/ws") {
        return {
          ok: true as const,
          path: "/ws",
          entries: [
            { name: "alpha", path: "/ws/alpha", type: "directory" as const },
            { name: "beta", path: "/ws/beta", type: "directory" as const },
            { name: "readme.md", path: "/ws/readme.md", type: "file" as const },
          ],
          truncated: false,
        };
      }
      if (p === "/ws/alpha") {
        return {
          ok: true as const,
          path: "/ws/alpha",
          entries: [{ name: "a1.md", path: "/ws/alpha/a1.md", type: "file" as const }],
          truncated: false,
        };
      }
      return { ok: true as const, path: p, entries: [], truncated: false };
    });
    const reveal = vi.fn(async () => ({ ok: true as const }));
    const removeRoot = vi.fn(async () => ({
      ok: true as const,
      removed: "/ws/proj",
      roots: [{ path: "/ws", isDefault: true }],
    }));
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText }, platform: "MacIntel" });
    vi.stubGlobal("lvis", {
      attach: { openExternal: vi.fn(async () => ({ ok: true })) },
      preview: { readFile: vi.fn(async () => ({ ok: true, content: "# x", path: "/ws/readme.md", truncated: false })) },
      workspace: {
        listRoots: vi.fn(async () => ({
          ok: true,
          defaultRoot: "/ws",
          roots: [
            { path: "/ws", isDefault: true },
            { path: "/ws/proj", isDefault: false },
          ],
        })),
        pickRoot: vi.fn(async () => ({ ok: true, canceled: true })),
        listDir,
        removeRoot,
        reveal,
        addRootByPath: vi.fn(async () => ({ ok: true })),
        ...overrides,
      },
    });
    (window as unknown as { lvis: unknown }).lvis = (globalThis as unknown as { lvis: unknown }).lvis;
    return { listDir, reveal, removeRoot, writeText };
  }

  it("renders rows as ARIA treeitems with level/setsize/posinset and a single roving tabindex", async () => {
    stubRichWorkspace();
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    const tree = await screen.findByRole("tree");
    const items = within(tree).getAllByRole("treeitem");
    expect(items.length).toBe(3);
    expect(items[0].getAttribute("aria-level")).toBe("1");
    expect(items[0].getAttribute("aria-setsize")).toBe("3");
    expect(items[0].getAttribute("aria-posinset")).toBe("1");
    // Exactly one row is in the tab order (roving tabindex).
    const tabbable = items.filter((el) => el.getAttribute("tabindex") === "0");
    expect(tabbable.length).toBe(1);
  });

  it("ArrowDown moves the roving focus to the next row", async () => {
    stubRichWorkspace();
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    const tree = await screen.findByRole("tree");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    const items = within(tree).getAllByRole("treeitem");
    // Second row (beta) becomes the tabbable/selected one.
    expect(items[1].getAttribute("tabindex")).toBe("0");
    expect(items[1].getAttribute("aria-selected")).toBe("true");
  });

  it("Enter on a folder expands it (lazy-loads children into a role=group)", async () => {
    stubRichWorkspace();
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    const tree = await screen.findByRole("tree");
    // First row is "alpha" (a directory) and is the active item.
    fireEvent.keyDown(tree, { key: "Enter" });
    await screen.findByText("a1.md");
    expect(within(tree).getByRole("group")).toBeTruthy();
  });

  it("type-ahead focuses the row whose name starts with the typed character", async () => {
    stubRichWorkspace();
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    const tree = await screen.findByRole("tree");
    fireEvent.keyDown(tree, { key: "r" }); // -> readme.md
    const items = within(tree).getAllByRole("treeitem");
    expect(items[2].getAttribute("tabindex")).toBe("0");
  });

  it("right-click Reveal calls workspace.reveal with the row path (never opens the file)", async () => {
    const { reveal } = stubRichWorkspace();
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    const fileRow = await screen.findByText("readme.md");
    fireEvent.contextMenu(fileRow);
    const revealItem = await screen.findByTestId("chat-side-panel-fs-ctx-reveal");
    fireEvent.click(revealItem);
    await waitFor(() => expect(reveal).toHaveBeenCalledWith("/ws/readme.md"));
  });

  it("right-click Copy path writes the absolute path to the clipboard", async () => {
    const { writeText } = stubRichWorkspace();
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    const fileRow = await screen.findByText("readme.md");
    fireEvent.contextMenu(fileRow);
    fireEvent.click(await screen.findByTestId("chat-side-panel-fs-ctx-copy-path"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/ws/readme.md"));
  });

  it("remove-root button (non-default root) calls workspace.removeRoot; default root has no button", async () => {
    const { removeRoot } = stubRichWorkspace();
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    // Default root active -> no remove button.
    await screen.findByTestId("chat-side-panel-add-root");
    expect(screen.queryByTestId("chat-side-panel-remove-root")).toBeNull();
    // Switch the active root to the non-default addition.
    const select = (await screen.findByTestId("chat-side-panel-root-select")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "/ws/proj" } });
    const removeBtn = await screen.findByTestId("chat-side-panel-remove-root");
    fireEvent.click(removeBtn);
    await waitFor(() => expect(removeRoot).toHaveBeenCalledWith("/ws/proj"));
  });
});
