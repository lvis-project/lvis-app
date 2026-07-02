// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders preview targets, filters them, and switches to workspace files", () => {
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
        id: "json-1",
        kind: "json",
        title: "metrics.json",
        sourceLabel: "builtin",
        createdOrder: 1,
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

    renderPanel(
      <HarnessPanel
        api={api()}
        sessionId="session-1"
        targets={targets}
        files={files}
        initialSelectedId="file-1"
      />,
    );

    expect(screen.getByTestId("chat-side-panel")).toBeTruthy();
    expect(screen.getByTestId("chat-preview-rail")).toBeTruthy();
    expect(screen.getByTestId("chat-side-panel-file-tree")).toBeTruthy();
    expect(screen.getAllByText("report.md").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("metrics.json")).toBeNull();

    const search = screen.getByPlaceholderText(/검색|Search/i);
    fireEvent.change(search, { target: { value: "report" } });
    expect(screen.getByTestId("chat-side-panel-file-tree")).toHaveTextContent("report.md");
    expect(screen.getByText("C:\\workspace\\report.md")).toBeTruthy();

    fireEvent.click(screen.getByTestId("chat-side-panel-mode-preview"));
    const previewSearch = screen.getByPlaceholderText(/검색|Search/i);
    fireEvent.change(previewSearch, { target: { value: "metrics" } });
    expect(screen.queryByText("report.md")).toBeNull();
    expect(screen.getAllByText("metrics.json").length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByTestId("chat-side-panel-mode-files"));
    expect(screen.getByTestId("chat-side-panel-file-tree")).toHaveTextContent("report.md");
    const splitLayout = screen.getByTestId("chat-side-panel-file-split-layout") as HTMLElement;
    const splitter = screen.getByTestId("chat-side-panel-file-splitter");
    expect(splitLayout.style.gridTemplateRows).toContain("45%");
    fireEvent.keyDown(splitter, { key: "ArrowDown" });
    expect(splitLayout.style.gridTemplateRows).toContain("50%");
    fireEvent.keyDown(splitter, { key: "Home" });
    expect(splitLayout.style.gridTemplateRows).toContain("22%");
    fireEvent.keyDown(splitter, { key: "End" });
    expect(splitLayout.style.gridTemplateRows).toContain("72%");
    fireEvent.click(screen.getByTestId("chat-side-panel-add-browser-tab"));
    expect(screen.getAllByRole("tab").length).toBeGreaterThanOrEqual(5);
  });

  it("separates browser artifacts from files and general previews", () => {
    const targets: ChatPreviewTarget[] = [
      {
        id: "html-1",
        kind: "html",
        title: "Artifact dashboard",
        subtitle: "render_html",
        sourceLabel: "builtin",
        createdOrder: 0,
        payload: { html: "<main>Preview OK</main>", title: "Artifact dashboard", height: 200 },
      },
      {
        id: "url-1",
        kind: "url",
        title: "example.com/docs",
        subtitle: "web_fetch",
        sourceLabel: "builtin",
        createdOrder: 1,
        url: "https://example.com/docs",
      },
      {
        id: "json-1",
        kind: "json",
        title: "metrics.json",
        sourceLabel: "builtin",
        createdOrder: 2,
        value: { ok: true },
        raw: "{\"ok\":true}",
      },
    ];

    const { container } = renderPanel(
      <HarnessPanel
        api={api()}
        sessionId="session-1"
        targets={targets}
        files={[]}
        initialSelectedId="html-1"
      />,
    );

    expect(screen.queryByTestId("chat-side-panel-file-split-layout")).toBeNull();
    expect(screen.getByTestId("chat-side-panel-file-empty")).toHaveTextContent(/workspace|파일/i);

    fireEvent.click(screen.getByTestId("chat-side-panel-mode-browser"));
    expect(screen.getByTestId("chat-side-panel-tab-actions")).toBeTruthy();
    expect(screen.getByTestId("chat-side-panel-add-file-browser-tab")).toBeTruthy();
    expect(screen.getByTestId("chat-side-panel-add-browser-tab")).toBeTruthy();
    expect(screen.getByTestId("chat-side-panel-add-terminal-tab")).toBeTruthy();
    expect(screen.getAllByText("Artifact dashboard").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("example.com/docs").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId("chat-side-panel-browser-viewer")).toBeTruthy();
    expect(screen.getByTestId("chat-side-panel-browser-frame")).toBeTruthy();
    expect(screen.queryByText("metrics.json")).toBeNull();

    const addressInput = screen.getByTestId("chat-side-panel-browser-address") as HTMLInputElement;
    fireEvent.change(addressInput, { target: { value: "google.com" } });
    fireEvent.click(screen.getByTestId("chat-side-panel-browser-go"));
    const manualWebview = container.querySelector('[data-testid="chat-side-panel-browser-webview"]');
    expect(manualWebview).not.toBeNull();
    expect(manualWebview?.getAttribute("src")).toBe("https://google.com/");

    fireEvent.click(screen.getAllByTestId("chat-side-panel-browser-row")[1]!);
    const webview = container.querySelector('[data-testid="chat-side-panel-browser-webview"]');
    expect(webview).not.toBeNull();
    expect(webview?.getAttribute("src")).toBe("https://example.com/docs");
    expect(webview?.getAttribute("partition")).toBe(LVIS_SIDE_BROWSER_PARTITION);
    expect(webview?.getAttribute("webpreferences")).toContain("javascript=yes");
    expect(webview?.hasAttribute("allowpopups")).toBe(false);

    fireEvent.click(screen.getByTestId("chat-side-panel-mode-preview"));
    expect(screen.queryByText("Artifact dashboard")).toBeNull();
    expect(screen.queryByText("example.com/docs")).toBeNull();
    expect(screen.getAllByText("metrics.json").length).toBeGreaterThanOrEqual(1);
  });

  it("preserves added workspace tabs across a ChatSidePanel unmount (session switch)", () => {
    // The store lives above the panel (in the harness, mirroring ChatView), so
    // unmounting the panel — as happens on a session switch, leaving home, or
    // closing the rail — must NOT lose tab state. Previously the tabs lived in
    // ChatSidePanel's own useState and were destroyed on every unmount.
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

    // Four default tabs at mount.
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    // Add a browser tab -> five tabs, and it becomes active.
    fireEvent.click(screen.getByTestId("chat-side-panel-add-browser-tab"));
    expect(screen.getAllByRole("tab")).toHaveLength(5);

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
    expect(screen.getAllByRole("tab")).toHaveLength(5);
  });

  it("renders MCP app payloads through McpAppView", async () => {
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

    fireEvent.click(screen.getByTestId("chat-side-panel-mode-preview"));
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
});
