import { describe, expect, it } from "vitest";
// Upstream type imported for the anti-drift PIN below. Type-only, so it is erased
// at build time (the package's extensionless re-exports never resolve under
// NodeNext, which is exactly why `mcp-app-host-context.ts` re-declares the twin).
import type { McpUiHostContext as UpstreamMcpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { buildMcpAppHostContext } from "../mcp-app-host-context.js";
import type { McpUiHostContext } from "../mcp-app-host-context.js";

// A representative subset of the curated `--lvis-*` token map (values are the
// resolved CSS strings `bundleToPluginTokens` produces). Deliberately omits some
// tokens (e.g. `--lvis-warning`) to exercise "emit only present keys".
const LIGHT_TOKENS: Record<string, string> = {
  "--lvis-bg": "hsl(0, 0%, 100%)",
  "--lvis-surface": "hsl(0, 0%, 98%)",
  "--lvis-surface-overlay": "hsl(0, 0%, 96%)",
  "--lvis-fg": "hsl(222, 47%, 11%)",
  "--lvis-fg-muted": "hsl(215, 16%, 47%)",
  "--lvis-fg-disabled": "hsl(215, 16%, 65%)",
  "--lvis-border": "hsl(214, 32%, 91%)",
  "--lvis-primary": "hsl(217, 91%, 60%)",
  "--lvis-primary-fg": "hsl(0, 0%, 100%)",
  "--lvis-ring": "hsl(217, 91%, 60%)",
  "--lvis-danger": "hsl(0, 84%, 60%)",
  "--lvis-danger-fg": "hsl(0, 0%, 100%)",
  "--lvis-success": "hsl(142, 71%, 45%)",
  "--lvis-success-fg": "hsl(0, 0%, 100%)",
  "--lvis-radius": "0.6rem",
  "--lvis-radius-full": "9999px",
  "--lvis-text-base": "1rem",
  "--lvis-text-lg": "1.125rem",
  "--lvis-weight-semibold": "600",
};

const DARK_TOKENS: Record<string, string> = {
  "--lvis-bg": "hsl(222, 84%, 5%)",
  "--lvis-fg": "hsl(210, 40%, 98%)",
  "--lvis-primary": "hsl(217, 91%, 60%)",
  "--lvis-ring": "hsl(217, 91%, 65%)",
};

describe("buildMcpAppHostContext", () => {
  it("maps the light shell + locale/timeZone/platform to standard fields", () => {
    const ctx = buildMcpAppHostContext({
      shell: "light",
      tokens: LIGHT_TOKENS,
      locale: "en",
      timeZone: "America/New_York",
    });

    expect(ctx.theme).toBe("light");
    expect(ctx.locale).toBe("en");
    expect(ctx.timeZone).toBe("America/New_York");
    expect(ctx.platform).toBe("desktop");
    expect(ctx.deviceCapabilities).toEqual({ hover: true, touch: false });
  });

  it("maps the dark shell to theme=dark", () => {
    const ctx = buildMcpAppHostContext({
      shell: "dark",
      tokens: DARK_TOKENS,
      locale: "ko",
      timeZone: "Asia/Seoul",
    });

    expect(ctx.theme).toBe("dark");
    expect(ctx.locale).toBe("ko");
    expect(ctx.timeZone).toBe("Asia/Seoul");
  });

  it("translates LVIS tokens to the standard style-variable vocabulary", () => {
    const { styles } = buildMcpAppHostContext({
      shell: "light",
      tokens: LIGHT_TOKENS,
      locale: "en",
      timeZone: "UTC",
    });
    const variables = styles?.variables ?? {};

    // Neutrals
    expect(variables["--color-background-primary"]).toBe(LIGHT_TOKENS["--lvis-bg"]);
    expect(variables["--color-background-secondary"]).toBe(LIGHT_TOKENS["--lvis-surface"]);
    expect(variables["--color-background-tertiary"]).toBe(LIGHT_TOKENS["--lvis-surface-overlay"]);
    expect(variables["--color-text-primary"]).toBe(LIGHT_TOKENS["--lvis-fg"]);
    expect(variables["--color-text-secondary"]).toBe(LIGHT_TOKENS["--lvis-fg-muted"]);
    expect(variables["--color-text-disabled"]).toBe(LIGHT_TOKENS["--lvis-fg-disabled"]);
    expect(variables["--color-border-primary"]).toBe(LIGHT_TOKENS["--lvis-border"]);

    // Accent → info bucket, and inverse text for the on-accent foreground.
    expect(variables["--color-background-info"]).toBe(LIGHT_TOKENS["--lvis-primary"]);
    expect(variables["--color-text-inverse"]).toBe(LIGHT_TOKENS["--lvis-primary-fg"]);

    // Status (1:1)
    expect(variables["--color-background-danger"]).toBe(LIGHT_TOKENS["--lvis-danger"]);
    expect(variables["--color-text-danger"]).toBe(LIGHT_TOKENS["--lvis-danger-fg"]);
    expect(variables["--color-background-success"]).toBe(LIGHT_TOKENS["--lvis-success"]);
    expect(variables["--color-text-success"]).toBe(LIGHT_TOKENS["--lvis-success-fg"]);

    // Radius + fonts
    expect(variables["--border-radius-md"]).toBe(LIGHT_TOKENS["--lvis-radius"]);
    expect(variables["--border-radius-full"]).toBe(LIGHT_TOKENS["--lvis-radius-full"]);
    expect(variables["--font-text-md-size"]).toBe(LIGHT_TOKENS["--lvis-text-base"]);
    expect(variables["--font-text-lg-size"]).toBe(LIGHT_TOKENS["--lvis-text-lg"]);
    expect(variables["--font-weight-semibold"]).toBe(LIGHT_TOKENS["--lvis-weight-semibold"]);
  });

  it("fans the focus ring out to BOTH the primary and info standard ring keys", () => {
    const { styles } = buildMcpAppHostContext({
      shell: "dark",
      tokens: DARK_TOKENS,
      locale: "en",
      timeZone: "UTC",
    });
    const variables = styles?.variables ?? {};

    expect(variables["--color-ring-primary"]).toBe(DARK_TOKENS["--lvis-ring"]);
    expect(variables["--color-ring-info"]).toBe(DARK_TOKENS["--lvis-ring"]);
  });

  it("emits ONLY standard keys — never a proprietary --lvis-* name", () => {
    const { styles } = buildMcpAppHostContext({
      shell: "light",
      tokens: LIGHT_TOKENS,
      locale: "en",
      timeZone: "UTC",
    });
    const keys = Object.keys(styles?.variables ?? {});

    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.startsWith("--lvis-")).toBe(false);
    }
    // Every emitted key is a standard ext-apps variable (starts with one of the
    // fixed prefixes), never a bespoke bucket.
    for (const key of keys) {
      expect(
        key.startsWith("--color-") ||
          key.startsWith("--font-") ||
          key.startsWith("--border-") ||
          key.startsWith("--shadow-"),
      ).toBe(true);
    }
  });

  it("emits only keys whose source token is present", () => {
    const { styles } = buildMcpAppHostContext({
      shell: "light",
      tokens: LIGHT_TOKENS,
      locale: "en",
      timeZone: "UTC",
    });
    const variables = styles?.variables ?? {};

    // LIGHT_TOKENS has no `--lvis-warning`, so its standard key must be absent.
    expect(variables["--color-background-warning"]).toBeUndefined();
    expect("--color-background-warning" in variables).toBe(false);
  });

  it("maps --lvis-font-family to --font-sans only when the caller threads it in", () => {
    const withFamily = buildMcpAppHostContext({
      shell: "light",
      tokens: { ...LIGHT_TOKENS, "--lvis-font-family": "Inter, sans-serif" },
      locale: "en",
      timeZone: "UTC",
    });
    expect(withFamily.styles?.variables?.["--font-sans"]).toBe("Inter, sans-serif");

    const withoutFamily = buildMcpAppHostContext({
      shell: "light",
      tokens: LIGHT_TOKENS,
      locale: "en",
      timeZone: "UTC",
    });
    expect(withoutFamily.styles?.variables?.["--font-sans"]).toBeUndefined();
  });

  it("omits styles entirely when no tokens are provided", () => {
    const ctx = buildMcpAppHostContext({
      shell: "light",
      tokens: {},
      locale: "en",
      timeZone: "UTC",
    });

    expect(ctx.styles).toBeUndefined();
    // Non-style fields still populate.
    expect(ctx.theme).toBe("light");
    expect(ctx.platform).toBe("desktop");
  });

  it("local McpUiHostContext twin stays structurally compatible with upstream", () => {
    const built = buildMcpAppHostContext({
      shell: "light",
      tokens: LIGHT_TOKENS,
      locale: "en",
      timeZone: "UTC",
    });

    // Type-level PIN (erased at runtime): the local twin must be assignable BOTH
    // ways with the upstream `McpUiHostContext`. If ext-apps renames/retypes a
    // field, the local twin in mcp-app-host-context.ts must be updated to match.
    const asUpstream: UpstreamMcpUiHostContext = built;
    const asLocal: McpUiHostContext = asUpstream;

    expect(asLocal.theme).toBe("light");
  });
});
