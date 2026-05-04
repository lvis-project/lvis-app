import { describe, it, expect, beforeEach } from "vitest";
import {
  recordValidatedTheme,
  getLastThemePayload,
  __resetLastThemePayloadForTests,
} from "../domains/plugins.js";

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
