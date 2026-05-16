import type { ThemeBundle } from "./types.js";

/**
 * Violet Dark bundle — dark shell with warm-grey surface and vivid-purple accent.
 *
 * Surface: warm-grey dark palette (Grey-1 base, Grey-7 text).
 * Accent:  vivid-purple primary, warm red destructive, lilac user bubble.
 *          Reads consistently across shells.
 */
export const violetDarkBundle: ThemeBundle = {
  id: "violet-dark",
  name: "Violet Dark",
  description: "다크 셸 + 웜그레이 서피스 + 비비드 퍼플 액센트",
  shell: "dark",
  highContrast: false,
  tokens: {
    /* ── Tier B: semantic shell ──────────────────────────────────── */
    /* Surface elevation with warm-grey hue progression (was flat neutral grey).
       Subtle 15–35° H tints make the Violet Dark shell read as "warm coffee",
       distinct from the cool navy of tokyo-night / midnight. */
    background:               "0 0% 15%",      /* Grey 1  #262626 — canvas (keep brand) */
    foreground:               "44 37% 94%",    /* Grey 7  #F6F3EB */
    card:                     "30 8% 20%",     /* warm-grey lifted card */
    "card-foreground":        "44 37% 94%",
    popover:                  "35 12% 26%",    /* warmest, most elevated dropdown surface */
    "popover-foreground":     "44 37% 94%",
    primary:                  "253 100% 65%",  /* #734dff — SEND */
    "primary-foreground":     "0 0% 100%",
    secondary:                "20 6% 23%",     /* deeper warm — sidebar / secondary buttons */
    "secondary-foreground":   "44 37% 94%",
    muted:                    "15 5% 19%",     /* slightly cooler & darker than card */
    "muted-foreground":       "40 8% 64%",     /* warm light gray — timestamps */
    accent:                   "30 15% 28%",    /* warmer + brighter — hover / active accent */
    "accent-foreground":      "44 37% 94%",
    destructive:              "1 98% 59%",     /* #FD312E — red STOP */
    "destructive-foreground": "0 0% 100%",
    warning:                  "38 92% 62%",     /* amber-400 ish — vivid on warm-dark grey */
    "warning-foreground":     "0 0% 10%",
    success:                  "142 71% 45%",
    "success-foreground":     "0 0% 5%",
    /* ── Tier B': status / state ──────────────────────────────── */
    info:                     "210 90% 60%",
    "info-foreground":        "0 0% 5%",
    emphasis:                 "48 96% 60%",
    "emphasis-foreground":    "0 0% 5%",
    border:                   "25 10% 30%",    /* warm dark border — picks up bundle hue */
    input:                    "25 10% 30%",
    ring:                     "263 70% 70%",
    "message-user-bg":        "271 76% 76%",   /* #c497ef — lilac user bubble */
    "message-user-fg":        "0 0% 15%",      /* dark on light lilac (was white → contrast ~1.5 fail) */
    "input-bar-bg":           "35 12% 26%",    /* warm elevated composer — matches popover */
    /* ── Tier B'': surface overlay + interaction ───────────────── */
    overlay:                  "0 0% 0%",
    "hover-overlay":          "44 37% 94%",    /* warm-grey-7 tint for warm dark shell */
    "focus-ring":             "263 70% 65%",
    "link-fg":                "253 100% 75%",
    /* ── Tier B''': peripheral system ──────────────────────────── */
    "selection-bg":           "271 76% 76%",
    "selection-fg":           "0 0% 15%",
    "scrollbar-thumb":        "25 8% 34%",
    "scrollbar-track":        "30 8% 20%",
    "kbd-bg":                 "15 5% 19%",
    "kbd-border":             "25 10% 30%",
    /* ── Tier C: code surface ──────────────────────────────────── */
    "code-bg":                "222 47% 9%",
    "code-fg":                "210 40% 96%",
    "code-border":            "217 33% 22%",
    /* ── Tier D: chart palette ─────────────────────────────────── */
    "chart-1":                "253 100% 65%",
    "chart-2":                "271 76% 76%",
    "chart-3":                "1 98% 59%",
    "chart-4":                "142 71% 45%",
    "chart-5":                "44 90% 60%",
    /* ── Action tokens ─────────────────────────────────────────── */
    "action-view":            "263 70% 50%",
    "action-branch":          "25 95% 53%",
    "action-compact":         "263 70% 50%",
  },
};
