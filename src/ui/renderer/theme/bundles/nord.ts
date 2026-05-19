import type { ThemeBundle } from "./types.js";

/**
 * Nord — arctic, north-bluish color palette.
 *
 * Source: https://www.nordtheme.com — Polar Night (bg group), Snow Storm
 * (fg group), Frost (cool accent group), Aurora (red/orange/yellow/green/
 * magenta state group).
 */
export const nordBundle: ThemeBundle = {
  id: "nord",
  name: "Nord",
  description: "다크 셸 + 북극 프로스트 액센트 + 오로라 상태색",
  shell: "dark",
  highContrast: false,
  tokens: {
    background:               "220 16% 22%",   /* nord0 #2e3440 */
    foreground:               "219 28% 88%",   /* nord4 #d8dee9 */
    card:                     "222 16% 28%",   /* nord1 #3b4252 */
    "card-foreground":        "219 28% 88%",
    popover:                  "220 17% 32%",   /* nord2 #434c5e */
    "popover-foreground":     "219 28% 88%",
    primary:                  "193 43% 67%",   /* nord8 #88c0d0 */
    "primary-foreground":     "220 16% 22%",
    secondary:                "220 16% 36%",   /* nord3 #4c566a */
    "secondary-foreground":   "219 28% 88%",
    muted:                    "222 16% 28%",
    "muted-foreground":       "219 28% 75%",
    accent:                   "210 34% 63%",   /* nord9 #81a1c1 */
    "accent-foreground":      "220 16% 22%",
    destructive:              "354 68% 62%",   /* lifted nord11 — original 42% sat read as muddy */
    "destructive-foreground": "220 16% 8%",
    warning:                  "40 71% 73%",    /* nord13 #ebcb8b */
    "warning-foreground":     "220 16% 22%",
    success:                  "92 28% 65%",    /* nord14 #a3be8c */
    "success-foreground":     "220 16% 22%",
    info:                     "210 34% 63%",   /* nord9 — frost blue-purple */
    "info-foreground":        "220 16% 22%",
    emphasis:                 "40 71% 73%",    /* nord13 yellow */
    "emphasis-foreground":    "220 16% 22%",
    border:                   "220 16% 36%",
    input:                    "220 16% 36%",
    ring:                     "193 43% 67%",
    "ui-line":                "222 16% 64.0%",
    "message-user-bg":        "193 43% 67%",
    "message-user-fg":        "220 16% 22%",
    "input-bar-bg":           "222 16% 28%",
    overlay:                  "220 16% 12%",
    "hover-overlay":          "219 28% 88%",
    "focus-ring":             "193 43% 72%",
    "link-fg":                "213 32% 65%",   /* nord10 brighter */
    "selection-bg":           "193 43% 67%",
    "selection-fg":           "220 16% 22%",
    "scrollbar-thumb":        "220 16% 36%",
    "scrollbar-track":        "222 16% 28%",
    "kbd-bg":                 "220 17% 32%",
    "kbd-border":             "220 16% 40%",
    "code-bg":                "220 16% 18%",
    "code-fg":                "219 28% 88%",
    "code-border":            "220 16% 36%",
    "chart-1":                "193 43% 67%",   /* frost cyan */
    "chart-2":                "92 28% 65%",    /* aurora green */
    "chart-3":                "14 51% 63%",    /* aurora orange */
    "chart-4":                "311 20% 63%",   /* aurora magenta */
    "chart-5":                "40 71% 73%",    /* aurora yellow */
    "action-view":            "210 34% 63%",
    "action-branch":          "14 51% 63%",
    "action-compact":         "193 43% 67%",
  },
};
