import type { ThemeBundle } from "./types.js";

/**
 * Solarized Light — Ethan Schoonover's pioneering balanced light theme.
 *
 * Source: https://ethanschoonover.com/solarized (light variant).
 * Background uses base3 (#fdf6e3, warm yellow-tinted ivory); foreground uses
 * base00 (#657b83) for body text per Schoonover's contrast recommendation.
 */
export const solarizedLightBundle: ThemeBundle = {
  id: "solarized-light",
  name: "Solarized Light",
  description: "라이트 셸 + 솔라라이즈드 클래식 + 따뜻한 베이지 서피스",
  shell: "light",
  highContrast: false,
  tokens: {
    background:               "44 87% 94%",    /* base3 #fdf6e3 */
    foreground:               "196 13% 45%",   /* base00 #657b83 */
    card:                     "44 87% 94%",
    "card-foreground":        "196 13% 45%",
    popover:                  "46 42% 88%",    /* base2 #eee8d5 */
    "popover-foreground":     "194 14% 40%",   /* base01 — emphasized fg */
    primary:                  "205 69% 49%",   /* blue #268bd2 */
    "primary-foreground":     "44 87% 94%",
    secondary:                "46 42% 88%",
    "secondary-foreground":   "194 14% 40%",
    muted:                    "46 42% 88%",
    "muted-foreground":       "180 7% 55%",    /* base0 #839496 */
    accent:                   "175 59% 40%",   /* cyan #2aa198 */
    "accent-foreground":      "44 87% 94%",
    destructive:              "1 71% 52%",     /* red #dc322f */
    "destructive-foreground": "44 87% 94%",
    warning:                  "42 95% 45%",    /* lifted Schoonover yellow */
    "warning-foreground":     "44 87% 94%",
    success:                  "78 78% 42%",    /* lifted out of olive territory */
    "success-foreground":     "44 87% 94%",
    info:                     "205 69% 49%",   /* blue */
    "info-foreground":        "44 87% 94%",
    emphasis:                 "45 100% 35%",   /* solarized yellow */
    "emphasis-foreground":    "44 87% 94%",
    border:                   "46 42% 78%",
    input:                    "46 42% 78%",
    ring:                     "205 69% 49%",
    "message-user-bg":        "205 69% 49%",
    "message-user-fg":        "44 87% 94%",
    "input-bar-bg":           "44 87% 94%",
    overlay:                  "194 14% 25%",
    "hover-overlay":          "194 14% 30%",
    "focus-ring":             "205 69% 49%",
    "link-fg":                "237 43% 60%",   /* violet #6c71c4 */
    "selection-bg":           "175 59% 40%",
    "selection-fg":           "44 87% 94%",
    "scrollbar-thumb":        "46 25% 72%",
    "scrollbar-track":        "46 42% 88%",
    "kbd-bg":                 "46 42% 88%",
    "kbd-border":             "46 42% 78%",
    "code-bg":                "46 42% 88%",
    "code-fg":                "194 14% 40%",
    "code-border":            "46 42% 78%",
    "chart-1":                "205 69% 49%",   /* blue */
    "chart-2":                "68 100% 30%",   /* green */
    "chart-3":                "18 80% 44%",    /* orange */
    "chart-4":                "331 64% 52%",   /* magenta */
    "chart-5":                "175 59% 40%",   /* cyan */
    "action-view":            "237 43% 60%",
    "action-branch":          "18 80% 44%",
    "action-compact":         "205 69% 49%",
  },
};
