import type { ThemeBundle } from "./types.js";

export const forestBundle: ThemeBundle = {
  id: "forest",
  name: "Forest",
  description: "라이트 셸 + 틸 액센트 + 라이트 코드",
  shell: "light",
  highContrast: false,
  tokens: {
    /* ── Tier B: semantic shell ──────────────────────────────────── */
    background:               "0 0% 100%",
    foreground:               "222 47% 11%",
    card:                     "0 0% 100%",
    "card-foreground":        "222 47% 11%",
    popover:                  "0 0% 100%",
    "popover-foreground":     "222 47% 11%",
    primary:                  "170 70% 45%",
    "primary-foreground":     "0 0% 5%",
    secondary:                "210 40% 96%",
    "secondary-foreground":   "222 47% 11%",
    muted:                    "210 40% 96%",
    "muted-foreground":       "215 25% 28%",
    accent:                   "210 40% 96%",
    "accent-foreground":      "222 47% 11%",
    destructive:              "0 84% 60%",
    "destructive-foreground": "0 0% 5%",
    warning:                  "35 91% 45%",     /* saturated amber — visible on white shell */
    "warning-foreground":     "0 0% 5%",
    success:                  "142 71% 45%",
    "success-foreground":     "0 0% 5%",
    /* ── Tier B': status / state ──────────────────────────────── */
    info:                     "199 89% 48%",
    "info-foreground":        "0 0% 5%",
    emphasis:                 "40 96% 50%",       /* amber-gold for star on light shell */
    "emphasis-foreground":    "0 0% 10%",
    border:                   "214 32% 91%",
    input:                    "214 32% 91%",
    ring:                     "170 70% 35%",
    "ui-line":                "210 40% 47.5%",
    "message-user-bg":        "170 70% 45%",
    "message-user-fg":        "0 0% 5%",
    "input-bar-bg":           "0 0% 100%",
    /* ── Tier B'': surface overlay + interaction ───────────────── */
    overlay:                  "222 47% 11%",      /* dark dim on light shell */
    "hover-overlay":          "222 47% 11%",      /* black tint dimmer */
    "focus-ring":             "170 70% 35%",
    "link-fg":                "170 70% 38%",
    /* ── Tier B''': peripheral system ──────────────────────────── */
    "selection-bg":           "170 70% 45%",
    "selection-fg":           "210 40% 98%",
    "scrollbar-thumb":        "214 32% 78%",
    "scrollbar-track":        "210 40% 96%",
    "kbd-bg":                 "210 40% 96%",
    "kbd-border":             "214 32% 78%",
    /* ── Tier C: code surface ──────────────────────────────────── */
    "code-bg":                "210 40% 98%",
    "code-fg":                "222 47% 11%",
    "code-border":            "214 32% 88%",
    /* ── Tier D: chart palette ─────────────────────────────────── */
    "chart-1":                "170 70% 45%",      /* teal (primary) */
    "chart-2":                "25 95% 53%",       /* orange */
    "chart-3":                "262 83% 58%",      /* violet */
    "chart-4":                "330 81% 60%",      /* pink */
    "chart-5":                "48 96% 50%",       /* yellow */
    /* ── Action tokens ─────────────────────────────────────────── */
    "action-view":            "170 70% 35%",
    "action-branch":          "25 95% 53%",
    "action-compact":         "170 70% 35%",
  },
};
