import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildMcpAppHostContext } from "../mcp-app-host-context.js";
import { MCP_APP_AVAILABLE_DISPLAY_MODES } from "../../../../shared/mcp-app-display-mode.js";
// The anti-drift pin (bottom of this file) is a TEXT diff of the shipped upstream
// `.d.ts` against this repo's local twin — deliberately, not a type-level check. The
// upstream types cannot be imported for member-level resolution under
// `moduleResolution: NodeNext` (the package's extensionless re-exports mis-resolve —
// modelcontextprotocol/ext-apps#705, the very reason `mcp-app-host-context.ts`
// re-declares the twin), so a pin written with `import type` would depend on the thing
// that is broken. Reading the two source texts does not.

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
      displayMode: "inline",
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
      displayMode: "fullscreen",
    });

    expect(ctx.theme).toBe("dark");
    expect(ctx.locale).toBe("ko");
    expect(ctx.timeZone).toBe("Asia/Seoul");
    // The card's CURRENT mode is whatever the mount applied (here: the detached shell).
    expect(ctx.displayMode).toBe("fullscreen");
  });

  it("advertises exactly the display modes the host can apply — the handler's SoT", () => {
    const ctx = buildMcpAppHostContext({
      shell: "light",
      tokens: LIGHT_TOKENS,
      locale: "en",
      timeZone: "UTC",
      displayMode: "inline",
    });

    // `pip` is NOT advertised (no second, always-on-top window stack exists), and the
    // list must be exactly `MCP_APP_AVAILABLE_DISPLAY_MODES` — the same SoT
    // `onrequestdisplaymode` checks a request against. Advertising a mode the handler
    // would refuse (or refusing one we advertised) is the drift this pin exists for.
    expect(ctx.availableDisplayModes).toEqual([...MCP_APP_AVAILABLE_DISPLAY_MODES]);
    expect(ctx.availableDisplayModes).not.toContain("pip");
    expect(ctx.displayMode).toBe("inline");
  });

  it("hands out a COPY of the advertised set, never the host's own constant", () => {
    const ctx = buildMcpAppHostContext({
      shell: "light",
      tokens: {},
      locale: "en",
      timeZone: "UTC",
      displayMode: "inline",
    });

    // The context object crosses to a guest-facing surface; a mutation of it must not
    // reach back into the module constant every other card reads.
    expect(ctx.availableDisplayModes).not.toBe(MCP_APP_AVAILABLE_DISPLAY_MODES);
    ctx.availableDisplayModes?.push("pip");
    expect(MCP_APP_AVAILABLE_DISPLAY_MODES).not.toContain("pip");
  });

  it("translates LVIS tokens to the standard style-variable vocabulary", () => {
    const { styles } = buildMcpAppHostContext({
      shell: "light",
      tokens: LIGHT_TOKENS,
      locale: "en",
      timeZone: "UTC",
      displayMode: "inline",
    });
    const variables: Record<string, string | undefined> = styles?.variables ?? {};

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
      displayMode: "inline",
    });
    const variables: Record<string, string | undefined> = styles?.variables ?? {};

    expect(variables["--color-ring-primary"]).toBe(DARK_TOKENS["--lvis-ring"]);
    expect(variables["--color-ring-info"]).toBe(DARK_TOKENS["--lvis-ring"]);
  });

  it("emits ONLY standard keys — never a proprietary --lvis-* name", () => {
    const { styles } = buildMcpAppHostContext({
      shell: "light",
      tokens: LIGHT_TOKENS,
      locale: "en",
      timeZone: "UTC",
      displayMode: "inline",
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
      displayMode: "inline",
    });
    const variables: Record<string, string | undefined> = styles?.variables ?? {};

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
      displayMode: "inline",
    });
    expect(withFamily.styles?.variables?.["--font-sans"]).toBe("Inter, sans-serif");

    const withoutFamily = buildMcpAppHostContext({
      shell: "light",
      tokens: LIGHT_TOKENS,
      locale: "en",
      timeZone: "UTC",
      displayMode: "inline",
    });
    expect(withoutFamily.styles?.variables?.["--font-sans"]).toBeUndefined();
  });

  it("omits styles entirely when no tokens are provided", () => {
    const ctx = buildMcpAppHostContext({
      shell: "light",
      tokens: {},
      locale: "en",
      timeZone: "UTC",
      displayMode: "inline",
    });

    expect(ctx.styles).toBeUndefined();
    // Non-style fields still populate.
    expect(ctx.theme).toBe("light");
    expect(ctx.platform).toBe("desktop");
  });

});

// ─── Anti-drift pin against the SHIPPED upstream package ──────────────────────
//
// `mcp-app-host-context.ts` re-declares the standard `McpUiStyleVariableKey`
// vocabulary locally. That is the portability boundary of this whole feature: every key
// we emit must be one an MCP App actually reads. A re-declared type drifts silently by
// construction — upstream adds a key, ours does not, and nothing fails — so the twin is
// PINNED here against the union in the installed
// `@modelcontextprotocol/ext-apps/dist/src/spec.types.d.ts`.
//
// Text extraction rather than a type import: see the note at the top of this file.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const UPSTREAM_SPEC_TYPES = resolve(
  REPO_ROOT,
  "node_modules/@modelcontextprotocol/ext-apps/dist/src/spec.types.d.ts",
);
const LOCAL_TWIN = resolve(HERE, "../mcp-app-host-context.ts");

/** Pull the quoted members of the `McpUiStyleVariableKey` union out of a TS source text. */
function styleVariableKeys(source: string): string[] {
  const declaration = /McpUiStyleVariableKey\s*=([\s\S]*?);/.exec(source);
  if (!declaration) throw new Error("McpUiStyleVariableKey union not found");
  return [...declaration[1]!.matchAll(/"(--[a-z0-9-]+)"/gi)].map((m) => m[1]!);
}

describe("McpUiStyleVariableKey twin is pinned to upstream ext-apps", () => {
  it("declares EXACTLY the upstream style-variable vocabulary (a spec change fails here)", () => {
    const upstream = styleVariableKeys(readFileSync(UPSTREAM_SPEC_TYPES, "utf8"));
    const local = styleVariableKeys(readFileSync(LOCAL_TWIN, "utf8"));

    // Sanity: the extraction actually found a union, not an empty match.
    expect(upstream.length).toBeGreaterThan(50);
    // Order is irrelevant to a union; membership is not.
    expect([...local].sort()).toEqual([...upstream].sort());
  });

  it("only ever maps LVIS tokens onto keys that exist upstream", () => {
    const upstream = new Set(styleVariableKeys(readFileSync(UPSTREAM_SPEC_TYPES, "utf8")));
    const emitted = Object.keys(
      buildMcpAppHostContext({
        shell: "light",
        tokens: { ...LIGHT_TOKENS, "--lvis-font-family": "Inter, sans-serif" },
        locale: "en",
        timeZone: "UTC",
        displayMode: "inline",
      }).styles?.variables ?? {},
    );

    expect(emitted.length).toBeGreaterThan(0);
    for (const key of emitted) {
      expect(upstream.has(key), `not a standard ext-apps style key: ${key}`).toBe(true);
    }
  });
});
