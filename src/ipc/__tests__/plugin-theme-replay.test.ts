import { describe, it, expect, beforeEach, vi } from "vitest";

const sendSpy = vi.fn();
const fromIdSpy = vi.fn();

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/lvis-test", whenReady: () => Promise.resolve() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  webContents: { fromId: (...args: unknown[]) => fromIdSpy(...args) },
  dialog: {},
  shell: {},
}));

import {
  recordValidatedTheme,
  getLastThemePayload,
  replayThemeToWebview,
  __resetLastThemePayloadForTests,
} from "../domains/plugins.js";
import { HOST_ONLY_EMIT_NAMESPACES } from "../../plugins/capabilities.js";

describe("plugin theme replay cache", () => {
  beforeEach(() => {
    __resetLastThemePayloadForTests();
  });

  it("starts empty", () => {
    expect(getLastThemePayload()).toBeNull();
  });

  it("records a valid payload", () => {
    const result = recordValidatedTheme({
      bundleId: "tokyo-night",
      shell: "dark",
    });
    expect(result.ok).toBe(true);
    expect(getLastThemePayload()).toEqual({
      bundleId: "tokyo-night",
      shell: "dark",
    });
  });

  it("invalid payload leaves the existing cache untouched", () => {
    recordValidatedTheme({ bundleId: "lge-light", shell: "light" });
    const before = getLastThemePayload();

    const result = recordValidatedTheme({ bundleId: "sepia", shell: "light" });
    expect(result.ok).toBe(false);

    expect(getLastThemePayload()).toEqual(before);
  });

  it("overwrites earlier payload on each new valid call", () => {
    recordValidatedTheme({ bundleId: "lge-dark", shell: "dark" });
    recordValidatedTheme({ bundleId: "forest", shell: "light" });

    expect(getLastThemePayload()).toEqual({
      bundleId: "forest",
      shell: "light",
    });
  });

  it("preserves filtered tokens in the cached payload", () => {
    recordValidatedTheme({
      bundleId: "lge-dark",
      shell: "dark",
      tokens: { "--lvis-bg": "#111", "--evil-key": "red" },
    });

    expect(getLastThemePayload()).toEqual({
      bundleId: "lge-dark",
      shell: "dark",
      tokens: { "--lvis-bg": "#111" },
    });
  });

  it("records bundleId and shell correctly", () => {
    recordValidatedTheme({
      bundleId: "forest",
      shell: "light",
    });

    const cached = getLastThemePayload();
    expect(cached?.bundleId).toBe("forest");
    expect(cached?.shell).toBe("light");
  });

  it("unknown bundleId is rejected — cache stays null", () => {
    const result = recordValidatedTheme({
      bundleId: "injected-theme",
      shell: "dark",
    });

    expect(result.ok).toBe(false);
    expect(getLastThemePayload()).toBeNull();
  });
});

describe("replayThemeToWebview", () => {
  beforeEach(() => {
    __resetLastThemePayloadForTests();
    sendSpy.mockReset();
    fromIdSpy.mockReset();
  });

  it("returns null and does not send when the cache is empty", () => {
    fromIdSpy.mockReturnValue({ send: sendSpy, isDestroyed: () => false });

    const result = replayThemeToWebview(42);

    expect(result).toBeNull();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("sends host.theme.changed exactly once to the resolved wc when cache is filled", () => {
    fromIdSpy.mockReturnValue({ send: sendSpy, isDestroyed: () => false });
    recordValidatedTheme({ bundleId: "tokyo-night", shell: "dark" });

    const result = replayThemeToWebview(42);

    expect(fromIdSpy).toHaveBeenCalledOnce();
    expect(fromIdSpy).toHaveBeenCalledWith(42);
    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy).toHaveBeenCalledWith(
      "lvis:plugin:event",
      "host.theme.changed",
      { bundleId: "tokyo-night", shell: "dark" },
    );
    expect(result).toEqual({ bundleId: "tokyo-night", shell: "dark" });
  });

  it("does not send when wc.fromId returns undefined (already-destroyed wcId)", () => {
    fromIdSpy.mockReturnValue(undefined);
    recordValidatedTheme({ bundleId: "lge-light", shell: "light" });

    const result = replayThemeToWebview(99);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("does not send when wc.isDestroyed() is true", () => {
    fromIdSpy.mockReturnValue({ send: sendSpy, isDestroyed: () => true });
    recordValidatedTheme({ bundleId: "lge-dark", shell: "dark" });

    const result = replayThemeToWebview(11);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("swallows wc.send throw without surfacing", () => {
    fromIdSpy.mockReturnValue({
      send: () => { throw new Error("wc gone"); },
      isDestroyed: () => false,
    });
    recordValidatedTheme({ bundleId: "lge-dark", shell: "dark" });

    expect(() => replayThemeToWebview(7)).not.toThrow();
    expect(replayThemeToWebview(7)).toBeNull();
  });
});

describe("HOST_ONLY_EMIT_NAMESPACES", () => {
  it("blocks plugin emits in the `host.*` namespace (closes theme-spoofing surface)", () => {
    expect(HOST_ONLY_EMIT_NAMESPACES.has("host")).toBe(true);
  });

  it("still blocks plugin emits in the `plugin.*` namespace", () => {
    expect(HOST_ONLY_EMIT_NAMESPACES.has("plugin")).toBe(true);
  });
});
