import type { ThemeBundle } from "./types.js";

/**
 * Catppuccin Latte — light pastel.
 *
 * Source: https://catppuccin.com (Latte variant). Pairs with Catppuccin Mocha
 * for shell light/dark switching while preserving the same accent semantics.
 */
export const catppuccinLatteBundle: ThemeBundle = {
  id: "catppuccin-latte",
  name: "Catppuccin Latte",
  description: "라이트 셸 + 모브 액센트 + 따뜻한 파스텔",
  shell: "light",
  highContrast: false,
  tokens: {
    background:               "220 23% 95%",   /* base #eff1f5 */
    foreground:               "234 16% 35%",   /* text #4c4f69 */
    card:                     "220 22% 92%",   /* mantle #e6e9ef */
    "card-foreground":        "234 16% 35%",
    popover:                  "0 0% 100%",
    "popover-foreground":     "234 16% 35%",
    primary:                  "266 85% 58%",   /* mauve #8839ef */
    "primary-foreground":     "0 0% 100%",
    secondary:                "223 16% 83%",   /* surface0 #ccd0da */
    "secondary-foreground":   "234 16% 35%",
    muted:                    "223 16% 88%",
    "muted-foreground":       "233 10% 47%",   /* subtext0 #6c6f85 */
    accent:                   "225 14% 77%",   /* surface1 #bcc0cc */
    "accent-foreground":      "234 16% 35%",
    destructive:              "347 87% 44%",   /* red #d20f39 */
    "destructive-foreground": "0 0% 100%",
    warning:                  "35 77% 49%",    /* yellow #df8e1d */
    "warning-foreground":     "0 0% 100%",
    success:                  "109 58% 40%",   /* green #40a02b */
    "success-foreground":     "0 0% 100%",
    info:                     "220 91% 54%",   /* blue #1e66f5 */
    "info-foreground":        "0 0% 100%",
    emphasis:                 "35 77% 49%",    /* warmer yellow for light shell */
    "emphasis-foreground":    "0 0% 100%",
    border:                   "225 14% 77%",
    input:                    "225 14% 77%",
    ring:                     "266 85% 58%",
    "message-user-bg":        "266 85% 58%",
    "message-user-fg":        "0 0% 100%",
    "input-bar-bg":           "0 0% 100%",
    overlay:                  "234 16% 25%",
    "hover-overlay":          "234 16% 35%",
    "focus-ring":             "266 85% 58%",
    "link-fg":                "220 91% 54%",
    "selection-bg":           "266 85% 58%",
    "selection-fg":           "0 0% 100%",
    "scrollbar-thumb":        "223 16% 75%",
    "scrollbar-track":        "220 23% 92%",
    "kbd-bg":                 "223 16% 88%",
    "kbd-border":             "225 14% 77%",
    "code-bg":                "220 22% 92%",
    "code-fg":                "234 16% 35%",
    "code-border":            "225 14% 77%",
    "chart-1":                "266 85% 58%",   /* mauve */
    "chart-2":                "109 58% 40%",   /* green */
    "chart-3":                "22 99% 52%",    /* peach */
    "chart-4":                "220 91% 54%",   /* blue */
    "chart-5":                "183 74% 35%",   /* teal */
    "action-view":            "266 85% 58%",
    "action-branch":          "22 99% 52%",
    "action-compact":         "220 91% 54%",
  },
};
