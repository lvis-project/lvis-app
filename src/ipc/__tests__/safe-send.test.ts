import { describe, expect, it, vi } from "vitest";
import { sendToWebContents, sendToWindow } from "../safe-send.js";

describe("safe renderer IPC send", () => {
  it("returns false without sending when webContents is already destroyed", () => {
    const send = vi.fn();

    const ok = sendToWebContents({
      isDestroyed: () => true,
      send,
    } as never, "lvis:test", { ok: true });

    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("swallows send races so caller flows keep running", () => {
    const logger = { warn: vi.fn() };

    const ok = sendToWebContents({
      isDestroyed: () => false,
      send: () => {
        throw new TypeError("Object has been destroyed");
      },
    } as never, "lvis:test", { ok: true }, logger);

    expect(ok).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        channel: "lvis:test",
        error: "Object has been destroyed",
      },
      "renderer IPC send skipped",
    );
  });

  it("checks BrowserWindow destruction before reading webContents", () => {
    const webContents = {
      isDestroyed: () => false,
      send: vi.fn(),
    };
    const win = {
      isDestroyed: () => true,
      webContents,
    };

    const ok = sendToWindow(win as never, "lvis:test", { ok: true });

    expect(ok).toBe(false);
    expect(webContents.send).not.toHaveBeenCalled();
  });
});
