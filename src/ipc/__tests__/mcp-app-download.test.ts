/**
 * `lvis:mcp:ui-download-file` — the gated IPC behind the MCP-app `ondownloadfile` handler.
 *
 * Three things are asserted here and nowhere else:
 *   1. An UNAUTHORIZED sender is refused (the channel writes a file).
 *   2. The user's save dialog is the authorization — a CANCEL writes nothing and is NOT
 *      an error.
 *   3. What the app can talk the host into writing is only what the app already had:
 *      a `resource_link` never becomes a fetch.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANNELS } from "../../contract/app-contract.js";
import { hostFrameEvent, foreignFrameEvent } from "../../__tests__/test-helpers.js";

const handleMap = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
const showSaveDialog = vi.fn();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      handleMap.set(channel, fn);
    }),
  },
  dialog: { showSaveDialog: (...args: unknown[]) => showSaveDialog(...args) },
  webContents: { getAllWebContents: () => [] },
  app: { getPath: () => tmpdir(), getVersion: () => "0.0.0-test" },
  BrowserWindow: class {},
  shell: { openPath: vi.fn() },
}));

/** The host renderer frame (what `validateHostRendererSender` accepts). */
const auditLog = vi.fn();

function makeDeps() {
  return {
    auditLogger: { log: auditLog },
    getMainWindow: () => null,
    pluginRuntime: {
      on: vi.fn(),
      listPluginCards: () => [],
      getRuntimePlugin: () => undefined,
      getMethodOwner: () => undefined,
    },
    pluginMarketplace: { list: async () => [], getFetcher: () => ({}) },
    settingsService: { get: () => ({}), getSettings: () => ({}) },
    mcpManager: { readUiResource: vi.fn(), namespacedToolName: vi.fn(), listServers: () => [] },
    pluginLoopbackManager: { has: () => false, readUiResource: vi.fn() },
    toolRegistry: { findByName: () => undefined },
    getPluginToolInvoker: () => null,
    conversationLoop: { getSessionId: () => "session-1", queueGuidance: vi.fn() },
    notificationService: { fire: vi.fn() },
  } as unknown as import("../types.js").IpcDeps;
}

let tempDir: string;

describe("lvis:mcp:ui-download-file", () => {
  let invoke: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

  beforeEach(async () => {
    handleMap.clear();
    auditLog.mockClear();
    showSaveDialog.mockReset();
    tempDir = mkdtempSync(join(tmpdir(), "lvis-mcp-dl-"));
    vi.resetModules();
    const { registerPluginsHandlers } = await import("../domains/plugins.js?t=" + Date.now());
    registerPluginsHandlers(makeDeps());
    invoke = handleMap.get(CHANNELS.mcp.uiDownloadFile)!;
    expect(invoke).toBeTypeOf("function");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const csvParams = {
    contents: [
      {
        type: "resource",
        resource: {
          uri: "ui://card/report.csv",
          mimeType: "text/csv",
          blob: Buffer.from("a,b\n1,2\n", "utf8").toString("base64"),
        },
      },
    ],
  };

  it("REFUSES an unauthorized sender — the channel writes a file", async () => {
    for (const url of ["https://evil.example/index.html", "", "lvis-plugin://shell/index.html"]) {
      const result = await invoke(foreignFrameEvent(url), "github", csvParams);

      expect(result).toMatchObject({ ok: false, error: "unauthorized-frame" });
    }
    // Nothing even reached the dialog.
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it("decodes the app's inline bytes and writes them where the USER chose", async () => {
    const target = join(tempDir, "report.csv");
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });

    const result = await invoke(hostFrameEvent(), "github", csvParams);

    expect(result).toEqual({ ok: true, disposition: "saved" });
    expect(readFileSync(target, "utf8")).toBe("a,b\n1,2\n");
    // The dialog is pre-filled with the SANITIZED name, never a path from the app.
    const options = showSaveDialog.mock.calls[0]![0] as { defaultPath: string };
    expect(options.defaultPath).toBe("report.csv");
  });

  it("a user CANCEL writes nothing and is NOT an error", async () => {
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });

    const result = await invoke(hostFrameEvent(), "github", csvParams);

    // `ok: true` — the bridge handler maps this to `{}`, never `{ isError: true }`.
    expect(result).toEqual({ ok: true, disposition: "cancelled" });
  });

  it("REJECTS a resource_link — the host never fetches an app-supplied URI", async () => {
    const result = await invoke(hostFrameEvent(), "github", {
      contents: [{ type: "resource_link", uri: "https://evil.example/exfil?q=1" }],
    });

    expect(result).toMatchObject({ ok: false, error: "resource-link-unsupported" });
    // No dialog, no fetch, no write.
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it("rejects an oversize payload before any dialog", async () => {
    const result = await invoke(hostFrameEvent(), "github", {
      contents: [
        { type: "resource", resource: { uri: "ui://card/big.bin", blob: "A".repeat(80 * 1024 * 1024) } },
      ],
    });

    expect(result).toMatchObject({ ok: false, error: "too-large" });
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it("rejects a missing/blank serverId (the renderer binds it; a blank one is a bug)", async () => {
    await expect(invoke(hostFrameEvent(), "", csvParams)).resolves.toMatchObject({
      ok: false,
      error: "invalid-server-id",
    });
  });
});
