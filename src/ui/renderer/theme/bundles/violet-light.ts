import type { ThemeBundle } from "./types.js";

/**
 * Violet Light bundle — light shell with warm-grey surface and vivid-purple accent.
 *
 * Surface: warm-grey palette (Grey 6/7 background, Grey 1 text).
 * Accent:  vivid-purple primary (#734dff), warm red destructive (#FD312E),
 *          lilac user bubble (#c497ef).
 */
export const violetLightBundle: ThemeBundle = {
  id: "violet-light",
  name: "Violet Light",
  description: "라이트 셸 + 웜그레이 서피스 + 비비드 퍼플 액센트",
  shell: "light",
  highContrast: false,
  tokens: {
    /* ── Tier B: semantic shell ──────────────────────────────────── */
    /* Surface elevation (5-tier richness — was flat single-shade before) */
    background:               "40 25% 92%",    /* Grey 6  #F0ECE4 — canvas */
    foreground:               "0 0% 15%",      /* Grey 1  #262626 */
    card:                     "40 35% 96%",    /* lifted warm ivory — chat bubble + panel surface */
    "card-foreground":        "0 0% 15%",
    popover:                  "0 0% 100%",     /* pure white — dropdowns / floating */
    "popover-foreground":     "0 0% 15%",
    primary:                  "253 100% 65%",  /* #734dff — SEND */
    "primary-foreground":     "0 0% 100%",
    secondary:                "30 22% 86%",    /* deeper warm beige — secondary buttons / sidebar */
    "secondary-foreground":   "0 0% 15%",
    muted:                    "40 22% 89%",    /* between card and secondary — muted blocks */
    "muted-foreground":       "43 8% 28%",     /* darkened for body contrast on 89% L muted */
    accent:                   "25 35% 82%",    /* warmer + deeper — hover / active accent surface */
    "accent-foreground":      "0 0% 15%",
    destructive:              "1 98% 59%",     /* #FD312E — red STOP */
    "destructive-foreground": "0 0% 100%",
    warning:                  "35 91% 45%",     /* saturated amber — visible on warm-beige shell */
    "warning-foreground":     "0 0% 5%",
    success:                  "142 71% 45%",
    "success-foreground":     "0 0% 5%",
    /* ── Tier B': status / state ──────────────────────────────── */
    info:                     "210 90% 50%",
    "info-foreground":        "0 0% 100%",
    emphasis:                 "40 96% 50%",     /* amber-gold for star on warm-grey shell */
    "emphasis-foreground":    "0 0% 10%",
    border:                   "30 14% 75%",    /* warm grey border — visible against 92% bg */
    input:                    "30 14% 75%",
    ring:                     "263 70% 50%",
    "ui-line":                "40 22% 38.5%",
    "message-user-bg":        "271 76% 76%",   /* #c497ef — lilac user bubble */
    "message-user-fg":        "0 0% 15%",      /* dark on light lilac (was white → contrast ~1.5 fail) */
    "input-bar-bg":           "0 0% 100%",     /* white composer */
    /* ── Tier B'': surface overlay + interaction ───────────────── */
    overlay:                  "0 0% 0%",
    "hover-overlay":          "0 0% 0%",       /* black tint dimmer for light shell */
    "focus-ring":             "263 70% 50%",
    "link-fg":                "253 100% 55%",
    /* ── Tier B''': peripheral system ──────────────────────────── */
    "selection-bg":           "271 76% 76%",
    "selection-fg":           "0 0% 15%",
    "scrollbar-thumb":        "30 14% 65%",
    "scrollbar-track":        "40 22% 89%",
    "kbd-bg":                 "40 22% 89%",
    "kbd-border":             "30 14% 75%",
    /* ── Tier C: code surface ──────────────────────────────────── */
    "code-bg":                "210 40% 98%",
    "code-fg":                "222 47% 11%",
    "code-border":            "214 32% 88%",
    /* ── Tier D: chart palette ─────────────────────────────────── */
    "chart-1":                "253 100% 65%",   /* vivid purple */
    "chart-2":                "1 98% 59%",      /* red */
    "chart-3":                "271 76% 76%",    /* lilac */
    "chart-4":                "142 71% 45%",    /* green */
    "chart-5":                "25 95% 53%",     /* orange */
    /* ── Action tokens ─────────────────────────────────────────── */
    "action-view":            "263 70% 50%",
    "action-branch":          "25 95% 53%",
    "action-compact":         "263 70% 50%",
  },
};
