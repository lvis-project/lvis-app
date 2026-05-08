/**
 * ThemeBundle — fully-specified paired theme set.
 *
 * Each bundle is self-contained: every semantic token is defined explicitly so
 * `var(--p-*)` chain dependencies are not required at render time. Bundles are
 * applied by writing `data-theme-bundle=<id>` on `<html>`.
 *
 * Token groups:
 *   - Tier B (25): semantic shell + chat surface tokens
 *   - Tier C (3):  code-surface tokens (--code-bg, --code-fg, --code-border)
 *   - Action (3):  PR-4/5 reserved action tokens (--action-view, --action-branch, --action-compact)
 */
export interface BundleTokens {
  /* ── Tier B: semantic shell tokens ─────────────────────────── */
  background: string;
  foreground: string;
  card: string;
  "card-foreground": string;
  popover: string;
  "popover-foreground": string;
  primary: string;
  "primary-foreground": string;
  secondary: string;
  "secondary-foreground": string;
  muted: string;
  "muted-foreground": string;
  accent: string;
  "accent-foreground": string;
  destructive: string;
  "destructive-foreground": string;
  warning: string;
  "warning-foreground": string;
  success: string;
  border: string;
  input: string;
  ring: string;
  "message-user-bg": string;
  "message-user-fg": string;
  "input-bar-bg": string;
  /* success-fg is intentionally absent from Tier B — no component uses it directly */

  /* ── Tier C: code-surface tokens ────────────────────────────── */
  "code-bg": string;
  "code-fg": string;
  "code-border": string;

  /* ── Action tokens (PR-4/5 reserved) ────────────────────────── */
  "action-view": string;
  "action-branch": string;
  "action-compact": string;
}

export interface ThemeBundle {
  /** Unique stable identifier written to `data-theme-bundle`. */
  id: string;
  /** Display name shown in the AppearanceTab card. */
  name: string;
  /** Short description used as accessible tooltip / subtitle. */
  description: string;
  /** Shell color scheme — drives `color-scheme` CSS property. */
  shell: "light" | "dark";
  /** When true this bundle is always displayed; never auto-suggested. */
  highContrast: boolean;
  /** All 25 Tier B + 3 Tier C + 3 action tokens. */
  tokens: BundleTokens;
}
