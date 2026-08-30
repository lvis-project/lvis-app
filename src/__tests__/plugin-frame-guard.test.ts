/**
 * #237 Option B — validatePluginFrame guard tests
 *
 * Verifies that the plugin webview frame validator correctly accepts plugin-ui-shell
 * file:// frames and rejects host renderer frames or remote origins.
 */
import { describe, it, expect, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: { isPackaged: false },
  dialog: {},
  shell: {},
  BrowserWindow: vi.fn(),
}));

import { validatePluginFrame } from "../ipc-bridge.js";
import { foreignFrameEvent } from "./test-helpers.js";

describe("validatePluginFrame", () => {
  it("accepts a plugin-ui-shell file:// frame", () => {
    expect(validatePluginFrame(foreignFrameEvent("file:///dist/src/plugin-ui-shell.html"))).toBe(true);
  });

  it("rejects a host renderer file:// frame (no plugin-ui-shell in path)", () => {
    expect(validatePluginFrame(foreignFrameEvent("file:///dist/src/index.html"))).toBe(false);
  });

  it("rejects a generic file:// frame", () => {
    expect(validatePluginFrame(foreignFrameEvent("file:///some/other/file.html"))).toBe(false);
  });

  it("rejects http:// frames even if they contain plugin-ui-shell", () => {
    expect(validatePluginFrame(foreignFrameEvent("http://evil.example.com/plugin-ui-shell.html"))).toBe(false);
  });

  it("rejects https:// frames", () => {
    expect(validatePluginFrame(foreignFrameEvent("https://evil.example.com/"))).toBe(false);
  });

  it("refuses a missing sender frame", () => {
    expect(validatePluginFrame(null)).toBe(false);
    expect(validatePluginFrame(undefined)).toBe(false);
    expect(validatePluginFrame({} as IpcMainInvokeEvent)).toBe(false);
  });

  it("rejects malformed URL", () => {
    expect(validatePluginFrame(foreignFrameEvent("not-a-url"))).toBe(false);
  });
});
