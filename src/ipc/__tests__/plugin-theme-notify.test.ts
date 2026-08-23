import { describe, it, expect } from "vitest";
import { validateThemePayload } from "../domains/plugins.js";
import { bundleToPluginTokens } from "../../ui/renderer/theme/plugin-token-map.js";
import { loadAllThemeBundles } from "../../ui/renderer/theme/bundles/index.js";

// v2 helper: a full ThemeProvider v2 payload shape — tokens required per spec
const V2_PAYLOAD = {
  bundleId: "tokyo-night",
  shell: "dark",
  tokens: { "--lvis-bg": "#0d0d12" },
} as const;

describe("validateThemePayload", () => {
  it("accepts a valid bundleId + shell (dark)", () => {
    const result = validateThemePayload({ bundleId: "tokyo-night", shell: "dark", tokens: { "--lvis-bg": "#0d0d12" } });
    expect(result).toEqual({ ok: true, safe: { bundleId: "tokyo-night", shell: "dark", tokens: { "--lvis-bg": "#0d0d12" } } });
  });

  it("accepts light shell", () => {
    const result = validateThemePayload({ bundleId: "violet-light", shell: "light", tokens: { "--lvis-bg": "#fff" } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.bundleId).toBe("violet-light");
      expect(result.safe.shell).toBe("light");
    }
  });

  it("accepts high-contrast bundle", () => {
    const result = validateThemePayload({ bundleId: "high-contrast", shell: "dark", tokens: { "--lvis-bg": "#000" } });
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

  it("accepts payload and strips unknown injected fields", () => {
    const result = validateThemePayload({
      bundleId: "midnight", shell: "dark",
      tokens: { "--lvis-bg": "#000" },
      evil: "injected", __proto__: { polluted: true },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.bundleId).toBe("midnight");
      expect(result.safe.shell).toBe("dark");
      expect(result.safe.tokens).toEqual({ "--lvis-bg": "#000" });
      expect((result.safe as Record<string, unknown>).evil).toBeUndefined();
    }
  });

  it("passes through valid --lvis-* tokens", () => {
    const result = validateThemePayload({
      bundleId: "violet-dark", shell: "dark",
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
      expect(result.safe.tokens).toEqual({});
    }
  });

  it("drops token values with expression() injection", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--lvis-bg": "expression(alert(1))" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({});
    }
  });

  it("drops token values with HTML tag injection", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--lvis-bg": "<script>x</script>" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({});
    }
  });

  it("returns stable empty tokens object when all token entries are filtered out", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--evil": "red" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({});
    }
  });

  it("rejects token-less payload (tokens required)", () => {
    const result = validateThemePayload({ bundleId: "tokyo-night", shell: "dark" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("missing-tokens");
    }
  });

  it("drops token values with Unicode-escaped url() — allowlist blocks bypass attempts", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--lvis-bg": "url(https://evil.com?leak=1)" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({});
    }
  });

  it("drops var() references — only literal HSL/hex/dimension values pass", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--lvis-bg": "var(--p-secret-color)" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({});
    }
  });

  it("accepts hsl with decimal values and hex colors", () => {
    const result = validateThemePayload({
      bundleId: "violet-dark", shell: "dark",
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
      ["violet-light", "light"],
      ["violet-dark", "dark"],
      ["high-contrast", "dark"],
    ];
    for (const [bundleId, shell] of cases) {
      const result = validateThemePayload({ bundleId, shell, tokens: { "--lvis-bg": "#000" } });
      expect(result.ok, `bundleId=${bundleId}`).toBe(true);
      if (result.ok) expect(result.safe.bundleId).toBe(bundleId);
    }
  });

  // The validator and the token producer have to agree on value shapes. When
  // they drifted, the seven derived color-mix tokens were dropped from every
  // payload and plugin panels silently kept the SDK's dark-theme fallbacks —
  // visible as a dark chip in a light shell, with nothing logged anywhere.
  it("keeps every token every real bundle produces", async () => {
    // Marketplace entries are manifests until loaded, so pull the full set.
    const bundles = await loadAllThemeBundles();
    expect(bundles.length).toBeGreaterThan(5);
    for (const bundle of bundles) {
      const tokens = bundleToPluginTokens(bundle);
      const result = validateThemePayload({ bundleId: bundle.id, shell: bundle.shell, tokens });
      expect(result.ok, `bundleId=${bundle.id}`).toBe(true);
      if (!result.ok) continue;
      const dropped = Object.keys(tokens).filter((key) => !(key in (result.safe.tokens ?? {})));
      expect(dropped, `bundleId=${bundle.id}`).toEqual([]);
    }
  });

  it("accepts a color-mix token but not one carrying a second declaration", () => {
    const result = validateThemePayload({
      bundleId: "violet-light",
      shell: "light",
      tokens: {
        "--lvis-primary-bg-subtle": "color-mix(in srgb, hsl(217.2, 91.2%, 59.8%) 14%, hsl(0, 0%, 100%))",
        "--lvis-focus-shadow": "color-mix(in srgb, #734dff 62%, transparent)",
        "--lvis-input-bar-placeholder": "hsla(222.2, 84%, 7%, 0.82)",
        "--lvis-surface-hover": "color-mix(in srgb, hsl(0, 0%, 0%) 6%, hsl(0, 0%, 96%)); background:url(https://evil.example)",
        "--lvis-primary-bg-strong": "color-mix(in srgb, color-mix(in srgb, #fff 5%, #000) 28%, transparent)",
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.safe.tokens ?? {}).sort()).toEqual([
        "--lvis-focus-shadow",
        "--lvis-input-bar-placeholder",
        "--lvis-primary-bg-subtle",
      ]);
    }
  });

  it("v2 payload (V2_PAYLOAD const) round-trips correctly", () => {
    const result = validateThemePayload(V2_PAYLOAD);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.bundleId).toBe("tokyo-night");
      expect(result.safe.shell).toBe("dark");
      expect(result.safe.tokens).toEqual({ "--lvis-bg": "#0d0d12" });
    }
  });
});
