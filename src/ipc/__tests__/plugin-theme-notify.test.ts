import { describe, it, expect } from "vitest";
import { validateThemePayload } from "../domains/plugins.js";

describe("validateThemePayload", () => {
  it("accepts a valid dark/purple/dark payload", () => {
    const result = validateThemePayload({ theme: "dark", chatTheme: "purple", codeTheme: "dark" });
    expect(result).toEqual({ ok: true, safe: { theme: "dark", chatTheme: "purple", codeTheme: "dark" } });
  });

  it("accepts light/default/light", () => {
    const result = validateThemePayload({ theme: "light", chatTheme: "default", codeTheme: "light" });
    expect(result.ok).toBe(true);
  });

  it("accepts high-contrast", () => {
    const result = validateThemePayload({ theme: "high-contrast", chatTheme: "blue", codeTheme: "dark" });
    expect(result.ok).toBe(true);
  });

  it("rejects null", () => {
    const result = validateThemePayload(null);
    expect(result).toEqual({ ok: false, error: "invalid-payload" });
  });

  it("rejects non-object", () => {
    expect(validateThemePayload("dark")).toEqual({ ok: false, error: "invalid-payload" });
  });

  it("rejects unknown theme value", () => {
    const result = validateThemePayload({ theme: "sepia", chatTheme: "default", codeTheme: "light" });
    expect(result).toEqual({ ok: false, error: "invalid-theme" });
  });

  it("rejects unknown chatTheme value", () => {
    const result = validateThemePayload({ theme: "dark", chatTheme: "red", codeTheme: "dark" });
    expect(result).toEqual({ ok: false, error: "invalid-chat-theme" });
  });

  it("rejects unknown codeTheme value", () => {
    const result = validateThemePayload({ theme: "dark", chatTheme: "default", codeTheme: "auto" });
    expect(result).toEqual({ ok: false, error: "invalid-code-theme" });
  });

  it("rejects extra injected fields — safe output has only 3 keys", () => {
    const result = validateThemePayload({
      theme: "dark", chatTheme: "default", codeTheme: "dark",
      evil: "injected", __proto__: { polluted: true },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.safe)).toEqual(["theme", "chatTheme", "codeTheme"]);
    }
  });
});
