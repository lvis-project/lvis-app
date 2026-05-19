import type { ThemeBundle } from "./types.js";

/**
 * Gruvbox Dark Hard — warm retro vim palette.
 *
 * Source: https://github.com/morhetz/gruvbox (hard contrast dark variant).
 * Accent: signature orange (#fe8019) drives primary; yellow (#fabd2f) acts
 * as a secondary warm highlight.
 */
export const gruvboxDarkHardBundle: ThemeBundle = {
  id: "gruvbox-dark-hard",
  name: "Gruvbox Dark Hard",
  description: "다크 셸 + 따뜻한 오렌지 액센트 + 레트로 빔 팔레트",
  shell: "dark",
  highContrast: false,
  tokens: {
    background:               "195 7% 12%",    /* bg0_h #1d2021 */
    foreground:               "43 59% 81%",    /* fg1 #ebdbb2 */
    card:                     "0 0% 16%",      /* bg0 #282828 */
    "card-foreground":        "43 59% 81%",
    popover:                  "18 6% 22%",     /* bg1 #3c3836 */
    "popover-foreground":     "43 59% 81%",
    primary:                  "24 99% 55%",    /* orange #fe8019 */
    "primary-foreground":     "195 7% 12%",
    secondary:                "20 8% 30%",     /* bg2 #504945 */
    "secondary-foreground":   "43 59% 81%",
    muted:                    "18 6% 22%",
    "muted-foreground":       "41 38% 73%",    /* fg2 #d5c4a1 */
    accent:                   "41 95% 58%",    /* yellow #fabd2f */
    "accent-foreground":      "195 7% 12%",
    destructive:              "6 96% 59%",     /* red #fb4934 */
    "destructive-foreground": "195 7% 12%",
    warning:                  "41 95% 58%",    /* yellow */
    "warning-foreground":     "195 7% 12%",
    success:                  "61 66% 44%",    /* green #b8bb26 */
    "success-foreground":     "195 7% 12%",
    info:                     "195 55% 62%",   /* warmer cyan — original gruvbox blue was washed out */
    "info-foreground":        "195 7% 12%",
    emphasis:                 "41 95% 58%",
    "emphasis-foreground":    "195 7% 12%",
    border:                   "20 8% 30%",
    input:                    "20 8% 30%",
    ring:                     "24 99% 55%",
    "ui-line":                "18 6% 53.0%",
    "message-user-bg":        "24 99% 55%",
    "message-user-fg":        "195 7% 12%",
    "input-bar-bg":           "0 0% 16%",
    overlay:                  "195 7% 6%",
    "hover-overlay":          "43 59% 81%",
    "focus-ring":             "24 99% 65%",
    "link-fg":                "41 95% 62%",
    "selection-bg":           "24 99% 55%",
    "selection-fg":           "195 7% 12%",
    "scrollbar-thumb":        "20 8% 30%",
    "scrollbar-track":        "0 0% 16%",
    "kbd-bg":                 "18 6% 22%",
    "kbd-border":             "20 8% 30%",
    "code-bg":                "195 7% 9%",
    "code-fg":                "43 59% 81%",
    "code-border":            "20 8% 30%",
    "chart-1":                "24 99% 55%",    /* orange */
    "chart-2":                "61 66% 44%",    /* green */
    "chart-3":                "41 95% 58%",    /* yellow */
    "chart-4":                "175 15% 58%",   /* blue */
    "chart-5":                "339 41% 68%",   /* purple */
    "action-view":            "339 41% 68%",
    "action-branch":          "24 99% 55%",
    "action-compact":         "175 15% 58%",
  },
};
