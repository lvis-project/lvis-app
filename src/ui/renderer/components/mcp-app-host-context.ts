/**
 * Build the STANDARD ext-apps `McpUiHostContext` for one MCP App card.
 *
 * This is the portability boundary. MCP Apps are 100% standard code: they read
 * `onhostcontextchanged` / `useHostStyles` / `applyHostStyleVariables` and expect
 * the FIXED `McpUiStyleVariableKey` vocabulary (`--color-background-primary`,
 * `--font-text-md-size`, …). The host's own theme tokens are the proprietary
 * `--lvis-*` custom properties — those MUST NOT leak to a guest, or the app would
 * only work inside LVIS. So this module translates the curated `--lvis-*` token
 * map (from `bundleToPluginTokens`) into the standard style-variable keys and
 * emits nothing else LVIS-specific.
 *
 * Kept React-free / DOM-free / pure so the real-<webview> e2e gate (which imports
 * the shipping renderer wiring) and unit tests can exercise it without a renderer.
 *
 * ─── Standard types re-declared locally ─────────────────────────────────────
 * The `McpUiTheme` / `McpUiStyleVariableKey` / `McpUiStyles` / `McpUiHostContext`
 * twins below are structurally identical to `@modelcontextprotocol/ext-apps`
 * `spec.types.ts`. They are NOT imported from the package because ext-apps 1.7.4's
 * `.d.ts` re-export the spec types through EXTENSIONLESS `export * from "./types"`,
 * which does not resolve under `moduleResolution: NodeNext` (the same reason the
 * host re-declares `McpUiResourceCsp` in `src/mcp/types.ts`, and the same class of
 * issue documented in `mcp-app-bridge.ts`). `__tests__/mcp-app-host-context.test.ts`
 * pins these twins against the upstream package so a spec change fails the suite
 * instead of drifting silently.
 */

/** @see ext-apps `McpUiTheme` */
export type McpUiTheme = "light" | "dark";

/**
 * The FIXED standard CSS-variable vocabulary exposed to MCP apps.
 * @see ext-apps `McpUiStyleVariableKey` (copied verbatim — order irrelevant).
 */
export type McpUiStyleVariableKey =
  | "--color-background-primary"
  | "--color-background-secondary"
  | "--color-background-tertiary"
  | "--color-background-inverse"
  | "--color-background-ghost"
  | "--color-background-info"
  | "--color-background-danger"
  | "--color-background-success"
  | "--color-background-warning"
  | "--color-background-disabled"
  | "--color-text-primary"
  | "--color-text-secondary"
  | "--color-text-tertiary"
  | "--color-text-inverse"
  | "--color-text-ghost"
  | "--color-text-info"
  | "--color-text-danger"
  | "--color-text-success"
  | "--color-text-warning"
  | "--color-text-disabled"
  | "--color-border-primary"
  | "--color-border-secondary"
  | "--color-border-tertiary"
  | "--color-border-inverse"
  | "--color-border-ghost"
  | "--color-border-info"
  | "--color-border-danger"
  | "--color-border-success"
  | "--color-border-warning"
  | "--color-border-disabled"
  | "--color-ring-primary"
  | "--color-ring-secondary"
  | "--color-ring-inverse"
  | "--color-ring-info"
  | "--color-ring-danger"
  | "--color-ring-success"
  | "--color-ring-warning"
  | "--font-sans"
  | "--font-mono"
  | "--font-weight-normal"
  | "--font-weight-medium"
  | "--font-weight-semibold"
  | "--font-weight-bold"
  | "--font-text-xs-size"
  | "--font-text-sm-size"
  | "--font-text-md-size"
  | "--font-text-lg-size"
  | "--font-heading-xs-size"
  | "--font-heading-sm-size"
  | "--font-heading-md-size"
  | "--font-heading-lg-size"
  | "--font-heading-xl-size"
  | "--font-heading-2xl-size"
  | "--font-heading-3xl-size"
  | "--font-text-xs-line-height"
  | "--font-text-sm-line-height"
  | "--font-text-md-line-height"
  | "--font-text-lg-line-height"
  | "--font-heading-xs-line-height"
  | "--font-heading-sm-line-height"
  | "--font-heading-md-line-height"
  | "--font-heading-lg-line-height"
  | "--font-heading-xl-line-height"
  | "--font-heading-2xl-line-height"
  | "--font-heading-3xl-line-height"
  | "--border-radius-xs"
  | "--border-radius-sm"
  | "--border-radius-md"
  | "--border-radius-lg"
  | "--border-radius-xl"
  | "--border-radius-full"
  | "--border-width-regular"
  | "--shadow-hairline"
  | "--shadow-sm"
  | "--shadow-md"
  | "--shadow-lg";

/** @see ext-apps `McpUiStyles` — hosts MAY provide any subset. */
export type McpUiStyles = Record<McpUiStyleVariableKey, string | undefined>;

/** @see ext-apps `McpUiHostStyles` */
export interface McpUiHostStyles {
  variables?: McpUiStyles;
  css?: { fonts?: string };
}

/**
 * @see ext-apps `McpUiHostContext`.
 * Only the fields this host populates are declared explicitly; the `[key: string]`
 * index signature carries the rest of the standard (and forward-compat) surface.
 */
export interface McpUiHostContext {
  /** Forward-compat: hosts MAY carry additional standard fields. */
  [key: string]: unknown;
  theme?: McpUiTheme;
  styles?: McpUiHostStyles;
  locale?: string;
  timeZone?: string;
  platform?: "web" | "desktop" | "mobile";
  deviceCapabilities?: {
    touch?: boolean;
    hover?: boolean;
  };
}

/**
 * Ordered `[LVIS token → standard ext-apps style key]` pairs.
 *
 * A single LVIS token may fan out to more than one standard key (see `--lvis-ring`
 * below). Only keys whose source token is present in `tokens` are emitted, so any
 * subset is valid per the spec (`McpUiStyles` — "hosts MAY provide any subset").
 *
 * Accent approximation: LVIS's brand accent is `--lvis-primary`, but the standard
 * vocabulary has no dedicated brand/accent slot. The closest standard bucket is
 * "info", so `--lvis-primary` → `--color-background-info` and the focus ring maps
 * to BOTH `--color-ring-primary` and `--color-ring-info` so apps keying on either
 * standard focus token pick up the LVIS accent.
 */
const TOKEN_TO_STYLE_KEY: ReadonlyArray<readonly [string, McpUiStyleVariableKey]> = [
  // Neutrals
  ["--lvis-bg", "--color-background-primary"],
  ["--lvis-surface", "--color-background-secondary"],
  ["--lvis-surface-overlay", "--color-background-tertiary"],
  ["--lvis-fg", "--color-text-primary"],
  ["--lvis-fg-muted", "--color-text-secondary"],
  ["--lvis-fg-disabled", "--color-text-disabled"],
  ["--lvis-border", "--color-border-primary"],
  // Accent — LVIS "primary" brand → closest standard bucket is "info" (see note above).
  ["--lvis-primary", "--color-background-info"],
  ["--lvis-primary-fg", "--color-text-inverse"],
  ["--lvis-ring", "--color-ring-primary"],
  ["--lvis-ring", "--color-ring-info"],
  // Status (1:1)
  ["--lvis-danger", "--color-background-danger"],
  ["--lvis-danger-fg", "--color-text-danger"],
  ["--lvis-warning", "--color-background-warning"],
  ["--lvis-warning-fg", "--color-text-warning"],
  ["--lvis-success", "--color-background-success"],
  ["--lvis-success-fg", "--color-text-success"],
  // Radius
  ["--lvis-radius-xs", "--border-radius-xs"],
  ["--lvis-radius-sm", "--border-radius-sm"],
  ["--lvis-radius", "--border-radius-md"],
  ["--lvis-radius-lg", "--border-radius-lg"],
  ["--lvis-radius-full", "--border-radius-full"],
  // Fonts
  ["--lvis-text-xs", "--font-text-xs-size"],
  ["--lvis-text-sm", "--font-text-sm-size"],
  ["--lvis-text-base", "--font-text-md-size"],
  ["--lvis-text-lg", "--font-text-lg-size"],
  ["--lvis-weight-normal", "--font-weight-normal"],
  ["--lvis-weight-medium", "--font-weight-medium"],
  ["--lvis-weight-semibold", "--font-weight-semibold"],
  // Font family — only present when the user set a custom family (ThemeProvider
  // writes `--lvis-font-family` on the document root). Absent from the curated
  // bundle token map, so it is emitted only when the caller threads it in.
  ["--lvis-font-family", "--font-sans"],
];

export interface McpAppHostContextInput {
  /** Active shell scheme (maps 1:1 to the standard `McpUiTheme`). */
  shell: "light" | "dark";
  /** Resolved `--lvis-*` token → CSS value map (from `bundleToPluginTokens`). */
  tokens: Record<string, string>;
  /** BCP-47 language tag (e.g. "en", "ko"). */
  locale: string;
  /** IANA time zone (e.g. "America/New_York"). */
  timeZone: string;
}

/**
 * Translate LVIS host theme + locale + timezone into the standard
 * `McpUiHostContext`. Emits ONLY standard `McpUiStyleVariableKey` style
 * variables — never a `--lvis-*` key.
 */
export function buildMcpAppHostContext(input: McpAppHostContextInput): McpUiHostContext {
  const { shell, tokens, locale, timeZone } = input;

  const variables: Partial<Record<McpUiStyleVariableKey, string>> = {};
  for (const [source, target] of TOKEN_TO_STYLE_KEY) {
    const value = tokens[source];
    if (typeof value === "string" && value.length > 0) {
      variables[target] = value;
    }
  }

  const theme: McpUiTheme = shell;
  const context: McpUiHostContext = {
    theme,
    locale,
    timeZone,
    // Electron desktop host with a pointer, no touch.
    platform: "desktop",
    deviceCapabilities: { hover: true, touch: false },
  };

  if (Object.keys(variables).length > 0) {
    // `McpUiStyles` is declared `Record<key, string | undefined>` but the spec
    // states hosts MAY provide any subset, so a partial object is the intended
    // shape. Narrow the accumulator to the standard type at this single point.
    context.styles = { variables: variables as McpUiStyles };
  }

  return context;
}
