/**
 * ThemeBundle — fully-specified paired theme set.
 *
 * Each bundle is self-contained: every semantic token is defined explicitly so
 * `var(--p-*)` chain dependencies are not required at render time. Bundles are
 * applied by writing `data-theme-bundle=<id>` on `<html>`.
 *
 * Token groups:
 *   - Tier B  : semantic shell + chat surface tokens
 *   - Tier B' : status + state tokens (info/success-fg/warning/emphasis)
 *   - Tier B'': surface overlay + interaction tokens (ui-line, overlay, hover-overlay, focus-ring, link)
 *   - Tier B''': peripheral system tokens (selection, scrollbar, kbd)
 *   - Tier C  : code-surface tokens (--code-bg, --code-fg, --code-border)
 *   - Tier D  : chart palette (--chart-1..--chart-5) for SVG visualizations
 *   - Action  : checkpoint action tokens (--action-view/-branch/-compact)
 */
import type { BundleId } from "../../../../shared/theme-bundles.js";

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
  "success-foreground": string;
  /* ── Tier B': status / state ──────────────────────────────── */
  info: string;
  "info-foreground": string;
  emphasis: string;            /* star / pin / highlight (yellow/gold per theme) */
  "emphasis-foreground": string;
  border: string;
  input: string;
  ring: string;
  "ui-line": string;
  "message-user-bg": string;
  "message-user-fg": string;
  "input-bar-bg": string;

  /* ── Tier B'': surface overlay + interaction ───────────────── */
  overlay: string;             /* modal backdrop dimmer, opacity applied per call */
  "hover-overlay": string;     /* inline hover dimmer (white on dark / black on light) */
  "focus-ring": string;        /* keyboard focus outline */
  "link-fg": string;           /* hyperlink color (may equal primary or differ) */

  /* ── Tier B''': peripheral system tokens ───────────────────── */
  "selection-bg": string;
  "selection-fg": string;
  "scrollbar-thumb": string;
  "scrollbar-track": string;
  "kbd-bg": string;
  "kbd-border": string;

  /* ── Tier C: code-surface tokens ────────────────────────────── */
  "code-bg": string;
  "code-fg": string;
  "code-border": string;

  /* ── Tier D: chart palette ──────────────────────────────────── */
  "chart-1": string;
  "chart-2": string;
  "chart-3": string;
  "chart-4": string;
  "chart-5": string;

  /* ── Action tokens ─────────────────────────────────────────── */
  "action-view": string;
  "action-branch": string;
  "action-compact": string;
}

export interface ThemeBundle {
  /** Unique stable identifier written to `data-theme-bundle`. */
  id: BundleId;
  /** Display name shown in the AppearanceTab card. */
  name: string;
  /** Short description used as accessible tooltip / subtitle. */
  description: string;
  /** Shell color scheme — drives `color-scheme` CSS property. */
  shell: "light" | "dark";
  /** When true this bundle is always displayed; never auto-suggested. */
  highContrast: boolean;
  /** Complete semantic token payload for this bundle. */
  tokens: BundleTokens;
}
