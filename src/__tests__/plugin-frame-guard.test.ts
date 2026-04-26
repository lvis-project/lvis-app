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

function ev(url: string): IpcMainInvokeEvent {
  return { senderFrame: { url } } as unknown as IpcMainInvokeEvent;
}

describe("validatePluginFrame", () => {
  it("accepts a plugin-ui-shell file:// frame", () => {
    expect(validatePluginFrame(ev("file:///dist/src/plugin-ui-shell.html"))).toBe(true);
  });

  it("rejects a host renderer file:// frame (no plugin-ui-shell in path)", () => {
    expect(validatePluginFrame(ev("file:///dist/src/index.html"))).toBe(false);
  });

  it("rejects a generic file:// frame", () => {
    expect(validatePluginFrame(ev("file:///some/other/file.html"))).toBe(false);
  });

  it("rejects http:// frames even if they contain plugin-ui-shell", () => {
    expect(validatePluginFrame(ev("http://evil.example.com/plugin-ui-shell.html"))).toBe(false);
  });

  it("rejects https:// frames", () => {
    expect(validatePluginFrame(ev("https://evil.example.com/"))).toBe(false);
  });

  it("treats null event as trusted (unit-test ergonomics)", () => {
    expect(validatePluginFrame(null)).toBe(true);
    expect(validatePluginFrame(undefined)).toBe(true);
    expect(validatePluginFrame({} as IpcMainInvokeEvent)).toBe(true);
  });

  it("rejects malformed URL", () => {
    expect(validatePluginFrame(ev("not-a-url"))).toBe(false);
  });
});
