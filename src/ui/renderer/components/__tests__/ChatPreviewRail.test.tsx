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

function StatefulPanel({
  api,
  sessionId,
  targets,
  files,
  initialSelectedId,
}: {
  api: LvisApi;
  sessionId?: string;
  targets: ChatPreviewTarget[];
  files: WorkspaceFileItem[];
  initialSelectedId: string | null;
}) {
  const [selectedId, setSelectedId] = useState(initialSelectedId);
  return (
    <ChatSidePanel
      api={api}
      sessionId={sessionId}
      targets={targets}
      files={files}
      selectedId={selectedId}
      onSelect={setSelectedId}
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
      <ChatSidePanel
        api={api()}
        sessionId="session-1"
        targets={targets}
        files={files}
        selectedId="file-1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
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
      <StatefulPanel
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
      <ChatSidePanel
        api={api()}
        sessionId="session-1"
        targets={targets}
        files={[]}
        selectedId="plugin-1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
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
