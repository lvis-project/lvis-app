import type { ThemeBundle } from "./types.js";

/**
 * High-Contrast bundle — accessibility-first.
 *
 * Black background, yellow primary (WCAG AA+), white border, dark code.
 * Always displayed in the AppearanceTab (highContrast: true).
 */
export const highContrastBundle: ThemeBundle = {
  id: "high-contrast",
  name: "고대비",
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
    border:                   "0 0% 100%",
    input:                    "0 0% 100%",
    ring:                     "60 100% 50%",
    "message-user-bg":        "60 100% 50%",
    "message-user-fg":        "0 0% 0%",
    "input-bar-bg":           "0 0% 0%",
    /* ── Tier C: code surface ──────────────────────────────────── */
    "code-bg":                "222 47% 9%",
    "code-fg":                "210 40% 96%",
    "code-border":            "0 0% 100%",
    /* ── Action tokens (PR-4/5) ────────────────────────────────── */
    "action-view":            "60 100% 50%",
    "action-branch":          "60 100% 50%",
    "action-compact":         "60 100% 50%",
  },
};
