import type { ThemeBundle } from "./types.js";

/**
 * Rosé Pine — soho-vibes dark theme with iris/foam/gold accents.
 *
 * Source: https://rosepinetheme.com (main variant).
 * Accent: iris (#c4a7e7) primary; love/gold/foam fill the destructive/warning/
 * info slots respectively. Surface uses base/surface/overlay elevation steps.
 */
export const rosePineBundle: ThemeBundle = {
  id: "rose-pine",
  name: "Rosé Pine",
  description: "다크 셸 + 아이리스 액센트 + 부드러운 로즈 톤",
  shell: "dark",
  highContrast: false,
  tokens: {
    background:               "249 22% 12%",   /* base #191724 */
    foreground:               "245 50% 91%",   /* text #e0def4 */
    card:                     "247 23% 15%",   /* surface #1f1d2e */
    "card-foreground":        "245 50% 91%",
    popover:                  "248 25% 18%",   /* overlay #26233a */
    "popover-foreground":     "245 50% 91%",
    primary:                  "267 57% 78%",   /* iris #c4a7e7 */
    "primary-foreground":     "249 22% 12%",
    secondary:                "249 15% 28%",   /* highlight-med #403d52 */
    "secondary-foreground":   "245 50% 91%",
    muted:                    "248 25% 18%",
    "muted-foreground":       "248 15% 61%",   /* subtle #908caa */
    accent:                   "189 43% 73%",   /* foam #9ccfd8 */
    "accent-foreground":      "249 22% 12%",
    destructive:              "343 76% 68%",   /* love #eb6f92 */
    "destructive-foreground": "249 22% 12%",
    warning:                  "35 88% 72%",    /* gold #f6c177 */
    "warning-foreground":     "249 22% 12%",
    success:                  "197 49% 50%",   /* lifted pine for legibility */
    "success-foreground":     "249 22% 12%",
    info:                     "189 43% 73%",   /* foam */
    "info-foreground":        "249 22% 12%",
    emphasis:                 "35 88% 72%",    /* gold */
    "emphasis-foreground":    "249 22% 12%",
    border:                   "248 13% 36%",   /* highlight-high #524f67 */
    input:                    "248 13% 36%",
    ring:                     "267 57% 78%",
    "message-user-bg":        "267 57% 78%",
    "message-user-fg":        "249 22% 12%",
    "input-bar-bg":           "247 23% 15%",
    overlay:                  "249 22% 6%",
    "hover-overlay":          "245 50% 91%",
    "focus-ring":             "267 57% 82%",
    "link-fg":                "2 55% 83%",     /* rose #ebbcba */
    "selection-bg":           "267 57% 78%",
    "selection-fg":           "249 22% 12%",
    "scrollbar-thumb":        "248 13% 36%",
    "scrollbar-track":        "247 23% 15%",
    "kbd-bg":                 "248 25% 18%",
    "kbd-border":             "248 13% 36%",
    "code-bg":                "244 18% 10%",
    "code-fg":                "245 50% 91%",
    "code-border":            "249 15% 28%",
    "chart-1":                "267 57% 78%",   /* iris */
    "chart-2":                "189 43% 73%",   /* foam */
    "chart-3":                "35 88% 72%",    /* gold */
    "chart-4":                "343 76% 68%",   /* love */
    "chart-5":                "2 55% 83%",     /* rose */
    "action-view":            "267 57% 78%",
    "action-branch":          "35 88% 72%",
    "action-compact":         "189 43% 73%",
  },
};
