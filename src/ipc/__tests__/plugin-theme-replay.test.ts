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
      theme: "dark",
      chatTheme: "purple",
      codeTheme: "dark",
    });
    expect(result.ok).toBe(true);
    expect(getLastThemePayload()).toEqual({
      theme: "dark",
      chatTheme: "purple",
      codeTheme: "dark",
    });
  });

  it("invalid payload leaves the existing cache untouched", () => {
    recordValidatedTheme({ theme: "light", chatTheme: "lg", codeTheme: "light" });
    const before = getLastThemePayload();

    const result = recordValidatedTheme({ theme: "sepia", chatTheme: "lg", codeTheme: "light" });
    expect(result.ok).toBe(false);

    expect(getLastThemePayload()).toEqual(before);
  });

  it("overwrites earlier payload on each new valid call", () => {
    recordValidatedTheme({ theme: "dark", chatTheme: "lg", codeTheme: "dark" });
    recordValidatedTheme({ theme: "light", chatTheme: "blue", codeTheme: "light" });

    expect(getLastThemePayload()).toEqual({
      theme: "light",
      chatTheme: "blue",
      codeTheme: "light",
    });
  });

  it("preserves filtered tokens in the cached payload", () => {
    recordValidatedTheme({
      theme: "dark",
      chatTheme: "lg",
      codeTheme: "dark",
      tokens: { "--lvis-bg": "#111", "--evil-key": "red" },
    });

    expect(getLastThemePayload()).toEqual({
      theme: "dark",
      chatTheme: "lg",
      codeTheme: "dark",
      tokens: { "--lvis-bg": "#111" },
    });
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
    recordValidatedTheme({ theme: "dark", chatTheme: "purple", codeTheme: "dark" });

    const result = replayThemeToWebview(42);

    expect(fromIdSpy).toHaveBeenCalledOnce();
    expect(fromIdSpy).toHaveBeenCalledWith(42);
    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy).toHaveBeenCalledWith(
      "lvis:plugin:event",
      "host.theme.changed",
      { theme: "dark", chatTheme: "purple", codeTheme: "dark" },
    );
    expect(result).toEqual({ theme: "dark", chatTheme: "purple", codeTheme: "dark" });
  });

  it("does not send when wc.fromId returns undefined (already-destroyed wcId)", () => {
    fromIdSpy.mockReturnValue(undefined);
    recordValidatedTheme({ theme: "light", chatTheme: "lg", codeTheme: "light" });

    const result = replayThemeToWebview(99);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("does not send when wc.isDestroyed() is true", () => {
    fromIdSpy.mockReturnValue({ send: sendSpy, isDestroyed: () => true });
    recordValidatedTheme({ theme: "dark", chatTheme: "lg", codeTheme: "dark" });

    const result = replayThemeToWebview(11);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("swallows wc.send throw without surfacing", () => {
    fromIdSpy.mockReturnValue({
      send: () => { throw new Error("wc gone"); },
      isDestroyed: () => false,
    });
    recordValidatedTheme({ theme: "dark", chatTheme: "lg", codeTheme: "dark" });

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
