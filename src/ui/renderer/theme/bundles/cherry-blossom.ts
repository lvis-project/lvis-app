import type { ThemeBundle } from "./types.js";

/**
 * Cherry Blossom (체리 블라썸) — light shell with the LVIS loading-splash
 * key colors as the accent system.
 *
 * Background: pure white per user request — the loading-splash gradient
 * (`#fdfafa → #ffdce4 → #ffb4c6 → #fff`) is intentionally NOT used as the
 * chat background to keep long reading sessions calm.
 * Accent:    splash brand red `#ef0b4c` (343 92% 49%) — the wordmark color.
 * Secondary: splash brand magenta `#d900ff` (291 100% 50%) — the logo
 *            gradient endpoint, routed through --action-view + --link-fg.
 * Bubble:    lilac-pink (321 65% 78%) sampled from the cherry-petal interior
 *            so user messages read as soft pink against the white shell.
 */
export const cherryBlossomBundle: ThemeBundle = {
  id: "cherry-blossom",
  name: "체리 블라썸",
  description: "라이트 셸 + 체리 레드 액센트 + 스플래시 브랜드 팔레트",
  shell: "light",
  highContrast: false,
  tokens: {
    background:               "0 0% 100%",
    foreground:               "0 0% 10%",
    card:                     "340 60% 99%",   /* very pale blush */
    "card-foreground":        "0 0% 10%",
    popover:                  "0 0% 100%",
    "popover-foreground":     "0 0% 10%",
    primary:                  "343 92% 49%",   /* #ef0b4c — splash wordmark */
    "primary-foreground":     "0 0% 100%",
    secondary:                "340 50% 95%",
    "secondary-foreground":   "0 0% 10%",
    muted:                    "340 30% 96%",
    "muted-foreground":       "340 10% 45%",
    accent:                   "340 40% 92%",
    "accent-foreground":      "0 0% 10%",
    destructive:              "0 100% 50%",    /* #FF0000 — splash gradient start */
    "destructive-foreground": "0 0% 100%",
    warning:                  "35 91% 45%",
    "warning-foreground":     "0 0% 100%",
    success:                  "142 55% 42%",
    "success-foreground":     "0 0% 100%",
    info:                     "220 90% 55%",
    "info-foreground":        "0 0% 100%",
    emphasis:                 "35 91% 50%",    /* gold star on white shell */
    "emphasis-foreground":    "0 0% 100%",
    border:                   "340 20% 88%",
    input:                    "340 20% 88%",
    ring:                     "343 92% 49%",
    "message-user-bg":        "321 65% 78%",   /* lilac petal pink */
    "message-user-fg":        "0 0% 10%",
    "input-bar-bg":           "0 0% 100%",
    overlay:                  "340 30% 12%",   /* dark plum dim */
    "hover-overlay":          "0 0% 0%",
    "focus-ring":             "343 92% 49%",
    "link-fg":                "291 100% 45%",  /* #D900FF darker for legibility */
    "selection-bg":           "321 65% 78%",
    "selection-fg":           "0 0% 10%",
    "scrollbar-thumb":        "340 25% 75%",
    "scrollbar-track":        "340 30% 96%",
    "kbd-bg":                 "340 30% 96%",
    "kbd-border":             "340 20% 88%",
    "code-bg":                "340 50% 98%",
    "code-fg":                "0 0% 10%",
    "code-border":            "340 20% 88%",
    "chart-1":                "343 92% 49%",   /* cherry red */
    "chart-2":                "291 100% 50%",  /* magenta */
    "chart-3":                "142 55% 42%",   /* leaf green */
    "chart-4":                "220 90% 55%",   /* blue */
    "chart-5":                "35 91% 50%",    /* gold */
    "action-view":            "291 100% 50%",  /* splash magenta */
    "action-branch":          "35 91% 45%",
    "action-compact":         "343 92% 49%",
  },
};
