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
import type { SubAgentSpawn } from "../SubAgentCard.js";

function api(): LvisApi {
  return {
    openExternalUrl: vi.fn(async () => ({ ok: true })),
    chatGetVerbatimToolResult: vi.fn(async () => null),
    // useVerticalSplit (file-browser / preview / subagent tabs) seeds + persists
    // the split ratio through the settings round-trip.
    getSettings: vi.fn(async () => ({}) as never),
    updateSettings: vi.fn(async () => ({ ok: true }) as never),
    sideChat: {
      send: vi.fn(async () => ({ ok: true, result: {} })),
      new: vi.fn(async () => ({ ok: true, sessionId: "side-1" })),
      load: vi.fn(async () => ({ ok: true, sessionId: "side-1", messages: [] })),
      list: vi.fn(async () => ({ current: "side-1", sessions: [] })),
      abort: vi.fn(async () => ({ ok: true })),
      onStream: vi.fn(() => () => undefined),
      onFallback: vi.fn(() => () => undefined),
    },
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
function addTabViaMenu(kind: "preview" | "file-browser" | "browser" | "terminal" | "subagent") {
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
  subAgentSpawns = [],
}: {
  api: LvisApi;
  sessionId?: string;
  targets: ChatPreviewTarget[];
  files: WorkspaceFileItem[];
  initialSelectedId: string | null;
  panelMounted?: boolean;
  subAgentSpawns?: SubAgentSpawn[];
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
      subAgentSpawns={subAgentSpawns}
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
        dropPrepare: vi.fn(async () => ({ ok: true, pendingPath: "/ws/dropped", ackToken: "tok" })),
      },
    });
    (window as unknown as { lvis: unknown }).lvis = (globalThis as unknown as { lvis: unknown }).lvis;
    // Drop-path bridge (#1458): resolveDroppedPaths is preload-only; default stub
    // returns no path so tests that don't drop are unaffected.
    vi.stubGlobal("lvisDrop", { resolveDroppedPaths: vi.fn(() => [] as string[]) });
    (window as unknown as { lvisDrop: unknown }).lvisDrop = (globalThis as unknown as { lvisDrop: unknown }).lvisDrop;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens empty: shows the launcher with five items and shortcut hints, no tabs, no counts", () => {
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

    // Six launcher items (side-chat is now a launcher item — its engine ships
    // in this PR).
    expect(screen.getByTestId("chat-side-panel-launcher-preview")).toBeTruthy();
    expect(screen.getByTestId("chat-side-panel-launcher-terminal")).toBeTruthy();
    expect(screen.getByTestId("chat-side-panel-launcher-browser")).toBeTruthy();
    expect(screen.getByTestId("chat-side-panel-launcher-file-browser")).toBeTruthy();
    expect(screen.getByTestId("chat-side-panel-launcher-subagent")).toBeTruthy();
    expect(screen.getByTestId("chat-side-panel-launcher-side-chat")).toBeTruthy();

    // Shortcut hints are displayed for the bound items.
    expect(screen.getByText("⌃⇧G")).toBeTruthy();
    expect(screen.getByText("⌘T")).toBeTruthy();
    expect(screen.getByText("⌘P")).toBeTruthy();
    expect(screen.getByText("⌥⌘S")).toBeTruthy();
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

  it("hides the ordinal on a lone container tab and shows it once a second of the same kind opens", () => {
    renderPanel(
      <HarnessPanel
        api={api()}
        sessionId="session-1"
        targets={[]}
        files={[]}
        initialSelectedId={null}
      />,
    );

    // A single browser tab: the label carries no meaningless "1".
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-browser"));
    let browserTabs = screen.getAllByTestId("chat-side-panel-tab-browser");
    expect(browserTabs).toHaveLength(1);
    expect(browserTabs[0].textContent).not.toMatch(/\d/);

    // Opening a second browser tab makes both show their ordinal to disambiguate.
    addTabViaMenu("browser");
    browserTabs = screen.getAllByTestId("chat-side-panel-tab-browser");
    expect(browserTabs).toHaveLength(2);
    expect(browserTabs[0].textContent).toMatch(/1/);
    expect(browserTabs[1].textContent).toMatch(/2/);
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

    // Open a file-browser tab from the launcher; the top pane defaults to the
    // Directory source, so switch to the Session files segment to see artifacts.
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    fireEvent.click(screen.getByTestId("chat-side-panel-file-source-session"));
    expect(screen.getByTestId("chat-side-panel-file-tree")).toHaveTextContent("report.md");
    const splitLayout = screen.getByTestId("chat-side-panel-file-split-layout") as HTMLElement;
    const splitter = screen.getByTestId("chat-side-panel-file-splitter");
    expect(splitLayout.style.gridTemplateRows).toContain("45%");
    fireEvent.keyDown(splitter, { key: "ArrowDown" });
    expect(splitLayout.style.gridTemplateRows).toContain("50%");

    // Open a browser tab via the "+" dropdown (replaces scattered add buttons).
    // The first web artifact is an html doc, so the html viewer renders directly.
    addTabViaMenu("browser");
    expect(screen.getByTestId("chat-side-panel-browser-viewer")).toBeTruthy();

    // The web-artifact search + list live behind the floating 🔍 Popover now.
    // Before opening it, the always-on strip is gone (no rows in the DOM).
    expect(screen.queryAllByTestId("chat-side-panel-browser-row")).toHaveLength(0);

    const addressInput = screen.getByTestId("chat-side-panel-browser-address") as HTMLInputElement;
    fireEvent.change(addressInput, { target: { value: "google.com" } });
    fireEvent.click(screen.getByTestId("chat-side-panel-browser-go"));
    const manualWebview = container.querySelector('[data-testid="chat-side-panel-browser-webview"]');
    expect(manualWebview).not.toBeNull();
    expect(manualWebview?.getAttribute("src")).toBe("https://google.com/");

    // Open the search Popover and pick the second artifact (example.com/docs).
    fireEvent.click(screen.getByTestId("chat-side-panel-browser-search-trigger"));
    const rows = screen.getAllByTestId("chat-side-panel-browser-row");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(rows[1]!);
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

  it("dropping a folder resolves the path via the preload bridge and routes through dropPrepare → ack panel (#1458)", async () => {
    // Renderer-wiring lock: the drop MUST go through the webUtils bridge and the
    // main-side dropPrepare gate, then surface the acknowledgement panel — it can
    // NEVER persist a renderer-named path directly. (The real-Electron e2e proves
    // getPathForFile actually resolves a dropped File; this proves the wiring.)
    const resolveDroppedPaths = vi.fn(() => ["/ws/dropped-proj"]);
    const dropPrepare = vi.fn(async () => ({
      ok: true as const,
      pendingPath: "/ws/dropped-proj",
      ackToken: "drop-tok-1",
      warnings: [] as string[],
    }));
    vi.stubGlobal("lvisDrop", { resolveDroppedPaths });
    (window as unknown as { lvisDrop: unknown }).lvisDrop = (globalThis as unknown as { lvisDrop: unknown }).lvisDrop;
    vi.stubGlobal("lvis", {
      attach: { openExternal: vi.fn(async () => ({ ok: true })) },
      preview: { readFile: vi.fn(async () => ({ ok: true, content: "# x", path: "/ws/a.md", truncated: false })) },
      workspace: {
        listRoots: vi.fn(async () => ({ ok: true, defaultRoot: "/ws", roots: [{ path: "/ws", isDefault: true }] })),
        pickRoot: vi.fn(async () => ({ ok: true, canceled: true, roots: [{ path: "/ws", isDefault: true }] })),
        listDir: vi.fn(async () => ({ ok: true, path: "/ws", entries: [], truncated: false })),
        dropPrepare,
      },
    });
    (window as unknown as { lvis: unknown }).lvis = (globalThis as unknown as { lvis: unknown }).lvis;

    renderPanel(
      <HarnessPanel api={api()} sessionId="session-1" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    const zone = screen.getByTestId("chat-side-panel-project-roots");
    const dataTransfer = { files: [{ name: "dropped-proj" }] as unknown as FileList, dropEffect: "" };
    fireEvent.drop(zone, { dataTransfer });

    await waitFor(() => expect(resolveDroppedPaths).toHaveBeenCalledTimes(1));
    expect(dropPrepare).toHaveBeenCalledWith("/ws/dropped-proj");
    // The ack panel is shown — the drop does NOT silently widen the read scope.
    await waitFor(() => expect(screen.getByTestId("chat-side-panel-root-warning")).toBeTruthy());
  });

  it("dropping a hard-denied folder surfaces a Korean-mapped error and shows no ack panel (#1458)", async () => {
    // A Layer-0 deny from dropPrepare must not offer an ack path — the renderer
    // surfaces the error and never reaches the confirmation panel. The main
    // process returns the STABLE `sensitive-path` code (never raw English prose),
    // which the renderer maps to the localized "outside allowed folders" copy.
    const resolveDroppedPaths = vi.fn(() => ["/home/me/.ssh"]);
    const dropPrepare = vi.fn(async () => ({ ok: false as const, error: "sensitive-path" }));
    vi.stubGlobal("lvisDrop", { resolveDroppedPaths });
    (window as unknown as { lvisDrop: unknown }).lvisDrop = (globalThis as unknown as { lvisDrop: unknown }).lvisDrop;
    vi.stubGlobal("lvis", {
      attach: { openExternal: vi.fn(async () => ({ ok: true })) },
      preview: { readFile: vi.fn(async () => ({ ok: true, content: "# x", path: "/ws/a.md", truncated: false })) },
      workspace: {
        listRoots: vi.fn(async () => ({ ok: true, defaultRoot: "/ws", roots: [{ path: "/ws", isDefault: true }] })),
        pickRoot: vi.fn(async () => ({ ok: true, canceled: true, roots: [{ path: "/ws", isDefault: true }] })),
        listDir: vi.fn(async () => ({ ok: true, path: "/ws", entries: [], truncated: false })),
        dropPrepare,
      },
    });
    (window as unknown as { lvis: unknown }).lvis = (globalThis as unknown as { lvis: unknown }).lvis;

    renderPanel(
      <HarnessPanel api={api()} sessionId="session-1" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    const zone = screen.getByTestId("chat-side-panel-project-roots");
    fireEvent.drop(zone, { dataTransfer: { files: [{ name: ".ssh" }] as unknown as FileList } });

    const banner = await waitFor(() => screen.getByTestId("chat-side-panel-op-error"));
    // The surfaced text is the localized (Korean, per the test locale) copy — the
    // raw validator prose ("sensitive pattern") must NEVER reach the UI.
    expect(banner.textContent ?? "").toContain("허용된 프로젝트 폴더");
    expect(banner.textContent ?? "").not.toMatch(/sensitive pattern|sensitive-path/);
    expect(screen.queryByTestId("chat-side-panel-root-warning")).toBeNull();
  });

  it("dropping a file (not-a-dir) surfaces the Korean not-a-directory copy, not the raw code (#1459)", async () => {
    // The dropPrepare is-a-dir reject and the ack-pass TOCTOU re-check both return
    // the stable `not-a-dir` code; the renderer maps it to Korean via the shared
    // IPC error map — never surfacing the bare code.
    const resolveDroppedPaths = vi.fn(() => ["/ws/note.txt"]);
    const dropPrepare = vi.fn(async () => ({ ok: false as const, error: "not-a-dir" }));
    vi.stubGlobal("lvisDrop", { resolveDroppedPaths });
    (window as unknown as { lvisDrop: unknown }).lvisDrop = (globalThis as unknown as { lvisDrop: unknown }).lvisDrop;
    vi.stubGlobal("lvis", {
      attach: { openExternal: vi.fn(async () => ({ ok: true })) },
      preview: { readFile: vi.fn(async () => ({ ok: true, content: "# x", path: "/ws/a.md", truncated: false })) },
      workspace: {
        listRoots: vi.fn(async () => ({ ok: true, defaultRoot: "/ws", roots: [{ path: "/ws", isDefault: true }] })),
        pickRoot: vi.fn(async () => ({ ok: true, canceled: true, roots: [{ path: "/ws", isDefault: true }] })),
        listDir: vi.fn(async () => ({ ok: true, path: "/ws", entries: [], truncated: false })),
        dropPrepare,
      },
    });
    (window as unknown as { lvis: unknown }).lvis = (globalThis as unknown as { lvis: unknown }).lvis;

    renderPanel(
      <HarnessPanel api={api()} sessionId="session-1" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    const zone = screen.getByTestId("chat-side-panel-project-roots");
    fireEvent.drop(zone, { dataTransfer: { files: [{ name: "note.txt" }] as unknown as FileList } });

    const banner = await waitFor(() => screen.getByTestId("chat-side-panel-op-error"));
    expect(banner.textContent ?? "").toContain("디렉터리가 아닙니다");
    expect(banner.textContent ?? "").not.toContain("not-a-dir");
    expect(screen.queryByTestId("chat-side-panel-root-warning")).toBeNull();
  });

  it("a non-file drag (no resolved path) is a no-op — dropPrepare is never called (#1458)", async () => {
    const resolveDroppedPaths = vi.fn(() => [] as string[]);
    const dropPrepare = vi.fn();
    vi.stubGlobal("lvisDrop", { resolveDroppedPaths });
    (window as unknown as { lvisDrop: unknown }).lvisDrop = (globalThis as unknown as { lvisDrop: unknown }).lvisDrop;
    vi.stubGlobal("lvis", {
      attach: { openExternal: vi.fn(async () => ({ ok: true })) },
      preview: { readFile: vi.fn(async () => ({ ok: true, content: "# x", path: "/ws/a.md", truncated: false })) },
      workspace: {
        listRoots: vi.fn(async () => ({ ok: true, defaultRoot: "/ws", roots: [{ path: "/ws", isDefault: true }] })),
        pickRoot: vi.fn(async () => ({ ok: true, canceled: true, roots: [{ path: "/ws", isDefault: true }] })),
        listDir: vi.fn(async () => ({ ok: true, path: "/ws", entries: [], truncated: false })),
        dropPrepare,
      },
    });
    (window as unknown as { lvis: unknown }).lvis = (globalThis as unknown as { lvis: unknown }).lvis;

    renderPanel(
      <HarnessPanel api={api()} sessionId="session-1" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    const zone = screen.getByTestId("chat-side-panel-project-roots");
    fireEvent.drop(zone, { dataTransfer: { files: [] as unknown as FileList } });

    await waitFor(() => expect(resolveDroppedPaths).toHaveBeenCalledTimes(1));
    expect(dropPrepare).not.toHaveBeenCalled();
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
    // Second row (beta) becomes the roving-focus row (tabindex=0). Roving focus
    // is DISTINCT from selection: moving the arrow cursor does NOT set
    // aria-selected — that tracks the opened file only (APG tree pattern).
    expect(items[1].getAttribute("tabindex")).toBe("0");
    expect(items[1].getAttribute("aria-selected")).toBeNull();
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

  it("collapse-all folds every open folder and disables itself when nothing is open", async () => {
    stubRichWorkspace();
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    const alpha = await screen.findByText("alpha");
    // Disabled while nothing is expanded.
    expect((screen.getByTestId("chat-side-panel-collapse-all") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(alpha);
    await screen.findByText("a1.md");
    const collapse = screen.getByTestId("chat-side-panel-collapse-all") as HTMLButtonElement;
    expect(collapse.disabled).toBe(false);
    fireEvent.click(collapse);
    await waitFor(() => expect(screen.queryByText("a1.md")).toBeNull());
    expect((screen.getByTestId("chat-side-panel-collapse-all") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows an empty-folder placeholder when an expanded child dir has no entries", async () => {
    stubRichWorkspace();
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    const beta = await screen.findByText("beta"); // /ws/beta lists []
    fireEvent.click(beta);
    await screen.findByTestId("chat-side-panel-fs-empty");
  });

  it("flags a truncated directory listing", async () => {
    stubRichWorkspace({
      listDir: vi.fn(async (p: string) =>
        p === "/ws"
          ? {
              ok: true,
              path: "/ws",
              entries: [{ name: "readme.md", path: "/ws/readme.md", type: "file" }],
              truncated: true,
            }
          : { ok: true, path: p, entries: [], truncated: false },
      ),
    });
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    await screen.findByTestId("chat-side-panel-fs-truncated");
  });

  it("marks the OPENED file (selection) with aria-selected, distinct from roving focus", async () => {
    stubRichWorkspace();
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    const tree = await screen.findByRole("tree");
    // Open readme.md — that is the SELECTION (opened file), not merely focus.
    fireEvent.click(await screen.findByText("readme.md"));
    await waitFor(() => {
      const readmeRow = within(tree)
        .getAllByRole("treeitem")
        .find((el) => el.textContent?.includes("readme.md"));
      expect(readmeRow?.getAttribute("aria-selected")).toBe("true");
    });
    // The folder rows (not opened) carry no aria-selected — selection ≠ focus.
    const alphaRow = within(tree)
      .getAllByRole("treeitem")
      .find((el) => el.textContent?.includes("alpha"));
    expect(alphaRow?.getAttribute("aria-selected")).toBeNull();
  });

  it("surfaces a removeRoot failure inline instead of swallowing it", async () => {
    stubRichWorkspace({
      removeRoot: vi.fn(async () => ({ ok: false as const, error: "not-an-additional-root" as const })),
    });
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    const select = (await screen.findByTestId("chat-side-panel-root-select")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "/ws/proj" } });
    fireEvent.click(await screen.findByTestId("chat-side-panel-remove-root"));
    // The failure is shown to the user, not dropped silently.
    const banner = await screen.findByTestId("chat-side-panel-op-error");
    expect(banner.textContent).toBeTruthy();
    // Dismissible.
    fireEvent.click(screen.getByTestId("chat-side-panel-op-error-dismiss"));
    await waitFor(() => expect(screen.queryByTestId("chat-side-panel-op-error")).toBeNull());
  });

  it("surfaces a reveal failure inline instead of swallowing it", async () => {
    stubRichWorkspace({
      reveal: vi.fn(async () => ({ ok: false as const, error: "path-not-allowed" as const })),
    });
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    const fileRow = await screen.findByText("readme.md");
    fireEvent.contextMenu(fileRow);
    fireEvent.click(await screen.findByTestId("chat-side-panel-fs-ctx-reveal"));
    await screen.findByTestId("chat-side-panel-op-error");
  });

  it("file tab: session segment is disabled with a 0 badge when there are no artifacts", () => {
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    const sessionSeg = screen.getByTestId("chat-side-panel-file-source-session") as HTMLButtonElement;
    expect(sessionSeg.disabled).toBe(true);
    expect(screen.getByTestId("chat-side-panel-file-source-session-count").textContent).toBe("0");
    // Directory is the default source.
    expect(screen.getByTestId("chat-side-panel-file-source-directory").getAttribute("aria-pressed")).toBe("true");
  });

  it("file tab: switching to the session segment shows the session artifacts", () => {
    const targets: ChatPreviewTarget[] = [
      { id: "file-1", kind: "file", title: "report.md", sourceLabel: "read_file", createdOrder: 1, path: "/ws/report.md", canOpenExternal: false },
    ];
    const files: WorkspaceFileItem[] = [
      { id: "tool:/ws/report.md", path: "/ws/report.md", label: "report.md", detail: "/ws/report.md", sourceLabel: "read_file", operation: "read", previewTargetId: "file-1", canOpenExternal: false },
    ];
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={targets} files={files} initialSelectedId="file-1" />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    // Default (directory) source does not list the session artifact.
    expect(screen.getByTestId("chat-side-panel-file-tree")).not.toHaveTextContent("report.md");
    const sessionSeg = screen.getByTestId("chat-side-panel-file-source-session") as HTMLButtonElement;
    expect(sessionSeg.disabled).toBe(false);
    expect(screen.getByTestId("chat-side-panel-file-source-session-count").textContent).toBe("1");
    fireEvent.click(sessionSeg);
    expect(screen.getByTestId("chat-side-panel-file-tree")).toHaveTextContent("report.md");
  });

  it("file tab: the source segment strip is compact (h-6 buttons, tight padding)", () => {
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    // R3: the strip must not crowd the narrow file pane — 24px buttons + py-0.5.
    const strip = screen.getByTestId("chat-side-panel-file-source-segment");
    expect(strip.className).toContain("py-0.5");
    const dir = screen.getByTestId("chat-side-panel-file-source-directory");
    expect(dir.className).toContain("h-6");
    expect(dir.className).not.toContain("h-7");
  });

  it("file tab: the search box is hidden on the Directory segment and shown on Session (no dead search)", () => {
    const targets: ChatPreviewTarget[] = [
      { id: "file-1", kind: "file", title: "report.md", sourceLabel: "read_file", createdOrder: 1, path: "/ws/report.md", canOpenExternal: false },
    ];
    const files: WorkspaceFileItem[] = [
      { id: "tool:/ws/report.md", path: "/ws/report.md", label: "report.md", detail: "/ws/report.md", sourceLabel: "read_file", operation: "read", previewTargetId: "file-1", canOpenExternal: false },
    ];
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={targets} files={files} initialSelectedId="file-1" />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    // Directory is the default source; the search box would be a no-op there
    // (ProjectRootsBrowser takes no query), so it is not rendered.
    expect(screen.queryByTestId("chat-preview-search")).toBeNull();
    // Switching to Session (which the search actually filters) reveals it.
    fireEvent.click(screen.getByTestId("chat-side-panel-file-source-session"));
    expect(screen.getByTestId("chat-preview-search")).toBeTruthy();
  });

  it("subagent tab: lists spawns (running first) and shows the selected one's detail", () => {
    const subAgentSpawns: SubAgentSpawn[] = [
      { spawnId: "done-1", title: "Completed agent", status: "done", turns: [{ turn: 1, text: "did work", toolCallCount: 2 }], summary: "all done", toolCallCount: 2 },
      { spawnId: "run-1", title: "Live agent", status: "running", turns: [{ turn: 1, text: "working", toolCallCount: 1 }], toolCallCount: 1 },
    ];
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} subAgentSpawns={subAgentSpawns} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-subagent"));
    const rows = screen.getAllByTestId("chat-side-panel-subagent-row");
    expect(rows).toHaveLength(2);
    // Running spawn sorts first and is auto-selected in the detail pane.
    expect(rows[0]!.textContent).toContain("Live agent");
    expect(rows[0]!.getAttribute("aria-selected")).toBe("true");
    const detail = screen.getByTestId("chat-side-panel-subagent-detail");
    expect(detail.textContent).toContain("Live agent");
    // Selecting the completed spawn swaps the detail card.
    fireEvent.click(rows[1]!);
    expect(screen.getByTestId("chat-side-panel-subagent-detail").textContent).toContain("Completed agent");
  });

  it("subagent tab: list is a role=listbox and each row is a role=option (valid aria-selected)", () => {
    const subAgentSpawns: SubAgentSpawn[] = [
      { spawnId: "run-1", title: "Live agent", status: "running", turns: [], toolCallCount: 0 },
    ];
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} subAgentSpawns={subAgentSpawns} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-subagent"));
    // aria-selected is only valid inside a select container (listbox/grid/…).
    const listbox = screen.getByTestId("chat-side-panel-subagent-list");
    expect(listbox.getAttribute("role")).toBe("listbox");
    const rows = within(listbox).getAllByRole("option");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("subagent tab: renders a localized status label, not the raw enum", () => {
    const subAgentSpawns: SubAgentSpawn[] = [
      { spawnId: "done-1", title: "Done agent", status: "done", turns: [], toolCallCount: 0 },
    ];
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} subAgentSpawns={subAgentSpawns} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-subagent"));
    const row = screen.getByTestId("chat-side-panel-subagent-row");
    // Test locale is Korean: "완료" (statusDone), never the raw "done" enum.
    expect(row.textContent).toContain("완료");
    expect(row.textContent).not.toContain("done");
  });

  it("subagent tab: selection is pinned to the chosen spawn and does not jump when the list reorders", () => {
    // Two done spawns; select the second. When a new running spawn arrives and
    // reorders the list (running-first), the pinned selection must stay on the
    // originally-chosen spawn, not silently jump to the new top row.
    const initial: SubAgentSpawn[] = [
      { spawnId: "a", title: "Agent A", status: "done", turns: [], toolCallCount: 0 },
      { spawnId: "b", title: "Agent B", status: "done", turns: [], toolCallCount: 0 },
    ];
    const { rerender } = renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} subAgentSpawns={initial} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-subagent"));
    const rows = screen.getAllByTestId("chat-side-panel-subagent-row");
    fireEvent.click(rows[1]!); // select Agent B
    expect(screen.getByTestId("chat-side-panel-subagent-detail").textContent).toContain("Agent B");

    // A new running spawn arrives and would sort to the top of the list.
    const reordered: SubAgentSpawn[] = [
      ...initial,
      { spawnId: "c", title: "Agent C", status: "running", turns: [], toolCallCount: 0 },
    ];
    rerender(
      <TooltipProvider>
        <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} subAgentSpawns={reordered} />
      </TooltipProvider>,
    );
    // The detail stays pinned to Agent B — no silent jump to the new top row.
    expect(screen.getByTestId("chat-side-panel-subagent-detail").textContent).toContain("Agent B");
  });

  it("subagent tab: empty state when the chat has no spawns", () => {
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} subAgentSpawns={[]} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-subagent"));
    expect(screen.getByTestId("chat-side-panel-subagent-empty")).toBeTruthy();
  });

  it("side-chat IS a launcher item and opens the SideChatView", () => {
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    expect(screen.getByTestId("chat-side-panel-launcher-side-chat")).toBeTruthy();
    // Present in the tab-bar "+" menu once a tab exists.
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-file-browser"));
    openLauncherMenu();
    expect(screen.getByTestId("chat-side-panel-launcher-menu-side-chat")).toBeTruthy();
    expect(screen.getByTestId("chat-side-panel-launcher-menu-subagent")).toBeTruthy();
  });

  it("opening the side-chat tab renders the SideChatView (not a placeholder)", () => {
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId("chat-side-panel-launcher-side-chat"));
    expect(screen.getByTestId("side-chat-view")).toBeTruthy();
    expect(screen.queryByTestId("chat-side-panel-side-chat-placeholder")).toBeNull();
  });
});
