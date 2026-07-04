import type { ThemeBundle } from "./types.js";

/**
 * Moonstone (문스톤) — the default light shell: a weightless white canvas with a
 * soft periwinkle sheen (inspired by the antigravity.google reference).
 *
 * Pure-white canvas, near-black #121317 ink, and a soft periwinkle accent
 * family (#b7bfd9 tints for fills/focus, #dfe3ef selection) — the blue glow of
 * a moonstone gem drifting across white. Radius leans pill-ward (0.75rem, set
 * in the CSS block) and depth is carried by premium, softly-diffused layered
 * shadows so surfaces feel lifted, not flat.
 *
 * Description is a plain literal (not a `t()` key) so this bundle ships without
 * touching the generated locale catalogs.
 */
export const moonstoneBundle: ThemeBundle = {
  id: "moonstone",
  name: "Moonstone",
  description: "Weightless white with a soft periwinkle sheen — the blue glow of a moonstone gem.",
  shell: "light",
  highContrast: false,
  tokens: {
    background:               "0 0% 100%",     /* pure white canvas */
    foreground:               "225 12% 8%",    /* #121317 ink */
    card:                     "0 0% 100%",
    "card-foreground":        "225 12% 8%",
    popover:                  "0 0% 100%",
    "popover-foreground":     "225 12% 8%",
    primary:                  "225 12% 12%",   /* graphite ink primary */
    "primary-foreground":     "0 0% 100%",
    secondary:                "228 30% 96%",   /* periwinkle wash */
    "secondary-foreground":   "225 12% 12%",
    muted:                    "228 26% 96%",
    "muted-foreground":       "227 6% 29%",    /* #45474d */
    accent:                   "225 33% 91%",   /* #dfe3ef selection tint */
    "accent-foreground":      "225 12% 12%",
    destructive:              "358 70% 52%",
    "destructive-foreground": "0 0% 100%",
    warning:                  "35 88% 44%",
    "warning-foreground":     "0 0% 100%",
    success:                  "152 52% 36%",
    "success-foreground":     "0 0% 100%",
    info:                     "224 52% 58%",
    "info-foreground":        "0 0% 100%",
    emphasis:                 "40 92% 48%",
    "emphasis-foreground":    "225 12% 8%",
    border:                   "228 16% 90%",   /* rgba(33,34,38,.08)-ish hairline */
    input:                    "228 16% 90%",
    ring:                     "224 40% 66%",   /* periwinkle focus */
    "ui-line":                "228 12% 40%",
    "message-user-bg":        "225 33% 93%",   /* soft periwinkle bubble */
    "message-user-fg":        "225 14% 14%",
    "input-bar-bg":           "0 0% 100%",
    overlay:                  "228 20% 8%",
    "hover-overlay":          "225 12% 12%",
    "focus-ring":             "224 44% 62%",
    "link-fg":                "224 56% 52%",
    "selection-bg":           "225 33% 91%",   /* #dfe3ef */
    "selection-fg":           "225 14% 14%",
    "scrollbar-thumb":        "228 18% 80%",
    "scrollbar-track":        "228 26% 96%",
    "kbd-bg":                 "228 26% 96%",
    "kbd-border":             "228 16% 88%",
    "code-bg":                "228 30% 97%",
    "code-fg":                "225 12% 12%",
    "code-border":            "228 16% 90%",
    "chart-1":                "224 52% 62%",   /* periwinkle */
    "chart-2":                "152 52% 40%",
    "chart-3":                "268 46% 62%",
    "chart-4":                "28 82% 54%",
    "chart-5":                "330 58% 58%",
    "action-view":            "268 46% 58%",
    "action-branch":          "28 82% 52%",
    "action-compact":         "224 52% 58%",
  },
};
