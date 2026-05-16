import type { ThemeBundle } from "./types.js";

export const tokyoNightBundle: ThemeBundle = {
  id: "tokyo-night",
  name: "Tokyo Night",
  description: "다크 셸 + 블루 액센트 + 다크 코드",
  shell: "dark",
  highContrast: false,
  tokens: {
    /* ── Tier B: semantic shell ──────────────────────────────────── */
    background:               "222.2 84% 4.9%",
    foreground:               "210 40% 98%",
    card:                     "222.2 84% 7%",
    "card-foreground":        "210 40% 98%",
    popover:                  "222.2 84% 4.9%",
    "popover-foreground":     "210 40% 98%",
    primary:                  "217.2 91.2% 59.8%",
    "primary-foreground":     "210 40% 98%",
    secondary:                "217 33% 17%",
    "secondary-foreground":   "210 40% 98%",
    muted:                    "217 33% 17%",
    "muted-foreground":       "215 20% 65%",
    accent:                   "217 33% 17%",
    "accent-foreground":      "210 40% 98%",
    destructive:              "0 78% 58%",
    "destructive-foreground": "210 40% 98%",
    warning:                  "38 92% 62%",     /* amber-400 ish — vivid on dark navy */
    "warning-foreground":     "0 0% 10%",
    success:                  "142 71% 45%",
    "success-foreground":     "0 0% 5%",
    /* ── Tier B': status / state ──────────────────────────────── */
    info:                     "199 89% 55%",
    "info-foreground":        "0 0% 5%",
    emphasis:                 "48 96% 60%",      /* yellow-gold for star/pin */
    "emphasis-foreground":    "0 0% 5%",
    border:                   "217 33% 17%",
    input:                    "217 33% 17%",
    ring:                     "224.3 76.3% 48%",
    "message-user-bg":        "217.2 91.2% 59.8%",
    "message-user-fg":        "0 0% 5%",
    "input-bar-bg":           "222.2 84% 7%",
    /* ── Tier B'': surface overlay + interaction ───────────────── */
    overlay:                  "222 47% 4%",      /* modal backdrop base */
    "hover-overlay":          "210 40% 98%",     /* white tint for dark shell */
    "focus-ring":             "217.2 91.2% 70%",
    "link-fg":                "199 89% 65%",
    /* ── Tier B''': peripheral system ──────────────────────────── */
    "selection-bg":           "217.2 91.2% 59.8%",
    "selection-fg":           "210 40% 98%",
    "scrollbar-thumb":        "217 33% 28%",
    "scrollbar-track":        "222.2 84% 7%",
    "kbd-bg":                 "217 33% 17%",
    "kbd-border":             "217 33% 28%",
    /* ── Tier C: code surface ──────────────────────────────────── */
    "code-bg":                "222 47% 9%",
    "code-fg":                "210 40% 96%",
    "code-border":            "217 33% 22%",
    /* ── Tier D: chart palette ─────────────────────────────────── */
    "chart-1":                "217.2 91.2% 59.8%",  /* blue (primary) */
    "chart-2":                "142 71% 45%",         /* green */
    "chart-3":                "25 95% 53%",          /* orange */
    "chart-4":                "262 83% 58%",         /* violet */
    "chart-5":                "330 81% 60%",         /* pink */
    /* ── Action tokens ─────────────────────────────────────────── */
    "action-view":            "262 83% 58%",
    "action-branch":          "25 95% 53%",
    "action-compact":         "262 83% 58%",
  },
};
