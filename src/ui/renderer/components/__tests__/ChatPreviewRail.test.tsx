import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LvisApi } from "../../types.js";
import type { ChatPreviewTarget, WorkspaceFileItem } from "../../preview/preview-targets.js";
import { ChatPreviewRail } from "../ChatPreviewRail.js";

function api(): LvisApi {
  return {
    openExternalUrl: vi.fn(async () => ({ ok: true })),
    chatGetVerbatimToolResult: vi.fn(async () => null),
  } as unknown as LvisApi;
}

describe("ChatPreviewRail", () => {
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

    render(
      <ChatPreviewRail
        api={api()}
        sessionId="session-1"
        targets={targets}
        files={files}
        selectedId="file-1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId("chat-preview-rail")).toBeTruthy();
    expect(screen.getAllByText("report.md")).toHaveLength(2);
    expect(screen.getByText("metrics.json")).toBeTruthy();

    const search = screen.getByPlaceholderText(/검색|Search/i);
    fireEvent.change(search, { target: { value: "metrics" } });
    expect(screen.getAllByText("report.md")).toHaveLength(1);
    expect(screen.getByText("metrics.json")).toBeTruthy();

    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /파일 1|Files 1/i }));
    expect(screen.getByText("C:/workspace/report.md")).toBeTruthy();
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

    const { container } = render(
      <ChatPreviewRail
        api={api()}
        sessionId="session-1"
        targets={targets}
        files={[]}
        selectedId="plugin-1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

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
