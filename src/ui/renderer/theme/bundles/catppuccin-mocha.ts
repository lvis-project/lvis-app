import type { ThemeBundle } from "./types.js";

/**
 * Catppuccin Mocha — dark pastel.
 *
 * Source: https://catppuccin.com (Mocha variant).
 * Accent: mauve (#cba6f7) primary; red/yellow/green/blue derived from the
 *         Mocha aurora group. Surface uses base/mantle/surface0/surface1
 *         elevation for cards and popovers.
 */
export const catppuccinMochaBundle: ThemeBundle = {
  id: "catppuccin-mocha",
  name: "Catppuccin Mocha",
  description: "다크 셸 + 모브 액센트 + 파스텔 오로라",
  shell: "dark",
  highContrast: false,
  tokens: {
    background:               "240 21% 15%",   /* base #1e1e2e */
    foreground:               "226 64% 88%",   /* text #cdd6f4 */
    card:                     "240 23% 12%",   /* mantle #181825 */
    "card-foreground":        "226 64% 88%",
    popover:                  "234 13% 24%",   /* surface0 #313244 */
    "popover-foreground":     "226 64% 88%",
    primary:                  "267 84% 81%",   /* mauve #cba6f7 */
    "primary-foreground":     "240 21% 12%",
    secondary:                "234 13% 24%",
    "secondary-foreground":   "226 64% 88%",
    muted:                    "234 13% 24%",
    "muted-foreground":       "227 35% 80%",   /* subtext1 #bac2de */
    accent:                   "234 13% 31%",   /* surface1 #45475a */
    "accent-foreground":      "226 64% 88%",
    destructive:              "343 81% 75%",   /* red #f38ba8 */
    "destructive-foreground": "240 21% 12%",
    warning:                  "41 86% 83%",    /* yellow #f9e2af */
    "warning-foreground":     "240 21% 12%",
    success:                  "115 54% 76%",   /* green #a6e3a1 */
    "success-foreground":     "240 21% 12%",
    info:                     "217 92% 76%",   /* blue #89b4fa */
    "info-foreground":         "240 21% 12%",
    emphasis:                 "41 86% 83%",    /* yellow */
    "emphasis-foreground":    "240 21% 12%",
    border:                   "234 13% 31%",
    input:                    "234 13% 31%",
    ring:                     "267 84% 81%",
    "message-user-bg":        "267 84% 81%",
    "message-user-fg":        "240 21% 12%",
    "input-bar-bg":           "234 13% 24%",
    overlay:                  "240 23% 8%",
    "hover-overlay":          "226 64% 88%",
    "focus-ring":             "267 84% 85%",
    "link-fg":                "217 92% 80%",
    "selection-bg":           "267 84% 81%",
    "selection-fg":           "240 21% 12%",
    "scrollbar-thumb":        "234 13% 31%",
    "scrollbar-track":        "240 23% 12%",
    "kbd-bg":                 "234 13% 24%",
    "kbd-border":             "234 13% 36%",
    "code-bg":                "240 23% 12%",
    "code-fg":                "226 64% 88%",
    "code-border":            "234 13% 31%",
    "chart-1":                "267 84% 81%",   /* mauve */
    "chart-2":                "115 54% 76%",   /* green */
    "chart-3":                "23 92% 75%",    /* peach */
    "chart-4":                "217 92% 76%",   /* blue */
    "chart-5":                "316 73% 86%",   /* pink */
    "action-view":            "267 84% 81%",
    "action-branch":          "23 92% 75%",
    "action-compact":         "217 92% 76%",
  },
};
