import type { ThemeBundle } from "./types.js";

/**
 * LGE Dark bundle — absorbs the current `[data-theme="dark"][data-chat-theme="lg"]` variant.
 *
 * Surface: LG warm-grey dark palette (Grey-1 base, Grey-7 text).
 * Accent:  same as LGE Light (vivid-purple, LG red, lilac bubble) — brand
 *          reads consistently across shells.
 */
export const lgeDarkBundle: ThemeBundle = {
  id: "lge-dark",
  name: "LGE 다크",
  description: "다크 셸 + LG 웜그레이 서피스 + 비비드 퍼플 액센트",
  shell: "dark",
  highContrast: false,
  tokens: {
    /* ── Tier B: semantic shell ──────────────────────────────────── */
    background:               "0 0% 15%",      /* Grey 1  #262626 — chat surface */
    foreground:               "44 37% 94%",    /* Grey 7  #F6F3EB */
    card:                     "0 0% 18%",      /* slight elevation above surface */
    "card-foreground":        "44 37% 94%",
    popover:                  "0 0% 22%",
    "popover-foreground":     "44 37% 94%",
    primary:                  "253 100% 65%",  /* #734dff — SEND */
    "primary-foreground":     "0 0% 100%",
    secondary:                "0 0% 20%",
    "secondary-foreground":   "44 37% 94%",
    muted:                    "0 0% 20%",
    "muted-foreground":       "40 5% 60%",     /* warm light gray — timestamps */
    accent:                   "0 0% 20%",
    "accent-foreground":      "44 37% 94%",
    destructive:              "1 98% 59%",     /* #FD312E — LG red STOP */
    "destructive-foreground": "0 0% 100%",
    warning:                  "48 97% 77%",
    "warning-foreground":     "30 80% 25%",
    success:                  "142 71% 45%",
    border:                   "0 0% 28%",
    input:                    "0 0% 28%",
    ring:                     "263 70% 50%",
    "message-user-bg":        "271 76% 76%",   /* #c497ef — lilac user bubble */
    "message-user-fg":        "0 0% 100%",
    "input-bar-bg":           "0 0% 22%",      /* elevated composer */
    /* ── Tier C: code surface ──────────────────────────────────── */
    "code-bg":                "222 47% 9%",
    "code-fg":                "210 40% 96%",
    "code-border":            "217 33% 22%",
    /* ── Action tokens (PR-4/5) ────────────────────────────────── */
    "action-view":            "263 70% 50%",
    "action-branch":          "25 95% 53%",
    "action-compact":         "263 70% 50%",
  },
};
