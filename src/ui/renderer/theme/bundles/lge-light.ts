import type { ThemeBundle } from "./types.js";

/**
 * LGE Light bundle — absorbs the current `data-chat-theme=lg` light variant.
 *
 * Surface: LG warm-grey palette (Grey 6/7 background, Grey 1 text).
 * Accent:  LG vivid-purple primary (#734dff), LG red destructive (#FD312E),
 *          LG lilac user bubble (#c497ef).
 */
export const lgeLightBundle: ThemeBundle = {
  id: "lge-light",
  name: "LGE 라이트",
  description: "라이트 셸 + LG 웜그레이 서피스 + 비비드 퍼플 액센트",
  shell: "light",
  highContrast: false,
  tokens: {
    /* ── Tier B: semantic shell ──────────────────────────────────── */
    background:               "40 25% 92%",    /* Grey 6  #F0ECE4 */
    foreground:               "0 0% 15%",      /* Grey 1  #262626 */
    card:                     "40 25% 92%",
    "card-foreground":        "0 0% 15%",
    popover:                  "0 0% 100%",
    "popover-foreground":     "0 0% 15%",
    primary:                  "253 100% 65%",  /* #734dff — SEND */
    "primary-foreground":     "0 0% 100%",
    secondary:                "44 37% 94%",    /* Grey 7  #F6F3EB */
    "secondary-foreground":   "0 0% 15%",
    muted:                    "44 37% 94%",
    "muted-foreground":       "43 3% 43%",     /* Grey 3  #716F6A */
    accent:                   "44 37% 94%",
    "accent-foreground":      "0 0% 15%",
    destructive:              "1 98% 59%",     /* #FD312E — LG red STOP */
    "destructive-foreground": "0 0% 100%",
    warning:                  "48 96% 89%",
    "warning-foreground":     "30 80% 25%",
    success:                  "142 71% 45%",
    border:                   "40 10% 78%",    /* Grey 4  #CBC8C2 */
    input:                    "40 10% 78%",
    ring:                     "263 70% 50%",
    "message-user-bg":        "271 76% 76%",   /* #c497ef — lilac user bubble */
    "message-user-fg":        "0 0% 100%",
    "input-bar-bg":           "0 0% 100%",     /* white composer */
    /* ── Tier C: code surface ──────────────────────────────────── */
    "code-bg":                "210 40% 98%",
    "code-fg":                "222 47% 11%",
    "code-border":            "214 32% 88%",
    /* ── Action tokens (PR-4/5) ────────────────────────────────── */
    "action-view":            "263 70% 50%",
    "action-branch":          "25 95% 53%",
    "action-compact":         "263 70% 50%",
  },
};
