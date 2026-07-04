import type { ThemeBundle } from "./types.js";

/**
 * Marketplace — a quiet, professional light shell in the Vercel mold.
 *
 * Canvas is a near-white #fafafa with pure-white cards, near-black ink text,
 * and a single restrained #e5e5e5 hairline. The primary is the ink itself, so
 * controls read as calm monochrome with color reserved for status + charts.
 * Depth is carried entirely by the surface ladder + soft layered shadows.
 *
 * Description is a plain literal (not a `t()` key) so this bundle ships without
 * touching the generated locale catalogs.
 */
export const marketplaceBundle: ThemeBundle = {
  id: "marketplace",
  name: "Marketplace",
  description: "Quiet near-black ink on off-white — a professional, Vercel-like light shell.",
  shell: "light",
  highContrast: false,
  tokens: {
    background:               "0 0% 98%",     /* #fafafa canvas */
    foreground:               "0 0% 11%",     /* oklch(.205) ≈ #1c1c1c ink */
    card:                     "0 0% 100%",    /* #fff */
    "card-foreground":        "0 0% 11%",
    popover:                  "0 0% 100%",
    "popover-foreground":     "0 0% 11%",
    primary:                  "0 0% 11%",      /* near-black ink primary */
    "primary-foreground":     "0 0% 98%",
    secondary:                "0 0% 96%",
    "secondary-foreground":   "0 0% 11%",
    muted:                    "0 0% 96%",
    "muted-foreground":       "0 0% 43%",      /* #6d6d6d — clears WCAG AA 4.5 on muted */
    accent:                   "0 0% 94%",
    "accent-foreground":      "0 0% 11%",
    destructive:              "358 75% 49%",
    "destructive-foreground": "0 0% 100%",
    warning:                  "35 92% 40%",
    "warning-foreground":     "0 0% 100%",
    success:                  "152 56% 34%",
    "success-foreground":     "0 0% 100%",
    info:                     "212 90% 44%",
    "info-foreground":        "0 0% 100%",
    emphasis:                 "40 96% 46%",
    "emphasis-foreground":    "0 0% 11%",
    border:                   "0 0% 90%",      /* #e5e5e5 hairline */
    input:                    "0 0% 90%",
    ring:                     "0 0% 11%",
    "ui-line":                "0 0% 40%",
    "message-user-bg":        "0 0% 94%",
    "message-user-fg":        "0 0% 11%",
    "input-bar-bg":           "0 0% 100%",
    overlay:                  "0 0% 4%",
    "hover-overlay":          "0 0% 11%",
    "focus-ring":             "0 0% 11%",
    "link-fg":                "212 90% 44%",
    "selection-bg":           "0 0% 88%",
    "selection-fg":           "0 0% 11%",
    "scrollbar-thumb":        "0 0% 80%",
    "scrollbar-track":        "0 0% 96%",
    "kbd-bg":                 "0 0% 96%",
    "kbd-border":             "0 0% 88%",
    "code-bg":                "0 0% 97%",
    "code-fg":                "0 0% 11%",
    "code-border":            "0 0% 90%",
    "chart-1":                "212 90% 44%",
    "chart-2":                "152 56% 34%",
    "chart-3":                "262 60% 55%",
    "chart-4":                "25 90% 48%",
    "chart-5":                "330 65% 50%",
    "action-view":            "262 60% 55%",
    "action-branch":          "25 90% 48%",
    "action-compact":         "212 90% 44%",
  },
};
