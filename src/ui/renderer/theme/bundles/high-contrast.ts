import type { ThemeBundle } from "./types.js";

/**
 * High-Contrast bundle — accessibility-first.
 *
 * Black background, yellow primary (WCAG AA+), white border, dark code.
 * Always displayed in the AppearanceTab (highContrast: true).
 */
export const highContrastBundle: ThemeBundle = {
  id: "high-contrast",
  name: "High Contrast",
  description: "블랙 배경 + 옐로우 액센트 — 접근성 최우선",
  shell: "dark",
  highContrast: true,
  tokens: {
    /* ── Tier B: semantic shell ──────────────────────────────────── */
    background:               "0 0% 0%",
    foreground:               "0 0% 100%",
    card:                     "0 0% 0%",
    "card-foreground":        "0 0% 100%",
    popover:                  "0 0% 0%",
    "popover-foreground":     "0 0% 100%",
    primary:                  "60 100% 50%",   /* yellow — WCAG AA+ */
    "primary-foreground":     "0 0% 0%",
    secondary:                "0 0% 15%",
    "secondary-foreground":   "0 0% 100%",
    muted:                    "0 0% 15%",
    "muted-foreground":       "0 0% 80%",
    accent:                   "60 100% 50%",
    "accent-foreground":      "0 0% 0%",
    destructive:              "0 100% 50%",
    "destructive-foreground": "0 0% 100%",
    warning:                  "48 100% 50%",
    "warning-foreground":     "0 0% 0%",
    success:                  "120 100% 40%",
    "success-foreground":     "0 0% 0%",
    /* ── Tier B': status / state ──────────────────────────────── */
    info:                     "210 100% 60%",
    "info-foreground":        "0 0% 0%",
    emphasis:                 "60 100% 50%",   /* same as primary — yellow is the WCAG-validated highlight */
    "emphasis-foreground":    "0 0% 0%",
    border:                   "0 0% 100%",
    input:                    "0 0% 100%",
    ring:                     "60 100% 50%",
    "message-user-bg":        "60 100% 50%",
    "message-user-fg":        "0 0% 0%",
    "input-bar-bg":           "0 0% 0%",
    /* ── Tier B'': surface overlay + interaction ───────────────── */
    overlay:                  "0 0% 0%",
    "hover-overlay":          "0 0% 100%",
    "focus-ring":             "60 100% 50%",
    "link-fg":                "60 100% 50%",
    /* ── Tier B''': peripheral system ──────────────────────────── */
    "selection-bg":           "60 100% 50%",
    "selection-fg":           "0 0% 0%",
    "scrollbar-thumb":        "0 0% 100%",
    "scrollbar-track":        "0 0% 0%",
    "kbd-bg":                 "0 0% 15%",
    "kbd-border":             "0 0% 100%",
    /* ── Tier C: code surface ──────────────────────────────────── */
    "code-bg":                "222 47% 9%",
    "code-fg":                "210 40% 96%",
    "code-border":            "0 0% 100%",
    /* ── Tier D: chart palette — saturated primary hues for WCAG AA+ */
    "chart-1":                "60 100% 50%",   /* yellow */
    "chart-2":                "120 100% 50%",  /* green */
    "chart-3":                "0 100% 50%",    /* red */
    "chart-4":                "180 100% 50%",  /* cyan */
    "chart-5":                "300 100% 60%",  /* magenta */
    /* ── Action tokens ─────────────────────────────────────────── */
    "action-view":            "60 100% 50%",
    "action-branch":          "60 100% 50%",
    "action-compact":         "60 100% 50%",
  },
};
