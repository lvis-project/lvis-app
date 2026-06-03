import type { ThemeBundle } from "./types.js";
import { t } from "../../../../i18n/runtime.js";

/**
 * Cherry Blossom (체리 블라썸) — the default light shell with a crisp petal
 * palette and LVIS loading-splash accents.
 *
 * Background: pure white per user request — the loading-splash gradient
 * (`#fdfafa → #ffdce4 → #ffb4c6 → #fff`) is intentionally NOT used as the
 * chat background to keep long reading sessions calm.
 * Accent:    refined cherry red — strong enough for controls, calmer than
 *            splash red for sustained UI use.
 * Secondary: blossom wash + darker magenta link/action accents.
 * Bubble:    pale petal pink with plum text, preserving contrast on white.
 */
export const cherryBlossomBundle: ThemeBundle = {
  id: "cherry-blossom",
  name: "Cherry Blossom",
  description: t("cherryBlossom.description"),
  shell: "light",
  highContrast: false,
  tokens: {
    background:               "0 0% 100%",
    foreground:               "342 26% 12%",
    card:                     "345 70% 98%",   /* white with a petal tint */
    "card-foreground":        "342 26% 12%",
    popover:                  "0 0% 100%",
    "popover-foreground":     "342 26% 12%",
    primary:                  "343 78% 44%",   /* refined cherry red */
    "primary-foreground":     "0 0% 100%",
    secondary:                "348 72% 95%",
    "secondary-foreground":   "342 32% 18%",
    muted:                    "342 45% 96%",
    "muted-foreground":       "340 18% 36%",
    accent:                   "332 74% 92%",
    "accent-foreground":      "342 36% 16%",
    destructive:              "355 78% 44%",
    "destructive-foreground": "0 0% 100%",
    warning:                  "35 92% 43%",
    "warning-foreground":     "342 26% 12%",
    success:                  "150 52% 36%",
    "success-foreground":     "0 0% 100%",
    info:                     "220 78% 48%",
    "info-foreground":        "0 0% 100%",
    emphasis:                 "41 91% 50%",    /* warm pollen gold */
    "emphasis-foreground":    "342 26% 12%",
    border:                   "340 30% 84%",
    input:                    "340 30% 84%",
    ring:                     "343 78% 44%",
    "ui-line":                "343 52% 43%",
    "message-user-bg":        "342 78% 86%",   /* pale petal pink */
    "message-user-fg":        "342 34% 14%",
    "input-bar-bg":           "0 0% 100%",
    overlay:                  "342 36% 10%",   /* dark plum dim */
    "hover-overlay":          "342 26% 12%",
    "focus-ring":             "343 78% 44%",
    "link-fg":                "291 82% 38%",
    "selection-bg":           "342 78% 86%",
    "selection-fg":           "342 34% 14%",
    "scrollbar-thumb":        "340 34% 62%",
    "scrollbar-track":        "342 45% 96%",
    "kbd-bg":                 "345 60% 97%",
    "kbd-border":             "340 30% 84%",
    "code-bg":                "345 60% 98%",
    "code-fg":                "342 26% 12%",
    "code-border":            "340 30% 84%",
    "chart-1":                "343 78% 44%",   /* cherry red */
    "chart-2":                "291 82% 42%",   /* magenta */
    "chart-3":                "150 52% 36%",   /* leaf green */
    "chart-4":                "220 78% 48%",   /* lake blue */
    "chart-5":                "41 91% 50%",    /* pollen gold */
    "action-view":            "291 82% 42%",
    "action-branch":          "35 92% 43%",
    "action-compact":         "343 78% 44%",
  },
};
