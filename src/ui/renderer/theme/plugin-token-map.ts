import type { ChatThemePreference, ResolvedTheme } from "./types.js";

// Derives the full set of --lvis-* CSS custom properties from the current
// (resolved shell theme, chat theme) combination. Values are literal HSL
// strings so plugins can apply them without needing any of the host's
// --p-* palette or var() chain. The mapping mirrors src/styles.css exactly;
// update both files when adding a new theme.
const _H = (h: number, s: number, l: number) => `hsl(${h}, ${s}%, ${l}%)`;

const _DARK_BASE: Record<string, string> = {
  "--lvis-bg":           _H(222.2, 84,   4.9),
  "--lvis-surface":      _H(222.2, 84,   7  ),
  "--lvis-fg":           _H(210,   40,  98  ),
  "--lvis-fg-muted":     _H(215,   20,  65  ),
  "--lvis-primary":      _H(217.2, 91.2,59.8),
  "--lvis-primary-fg":   _H(210,   40,  98  ),
  "--lvis-secondary":    _H(217,   33,  17  ),
  "--lvis-secondary-fg": _H(210,   40,  98  ),
  "--lvis-danger":       _H(0,     62.8,30.6),
  "--lvis-danger-fg":    _H(210,   40,  98  ),
  "--lvis-warning":      _H(48,    97,  77  ),
  "--lvis-warning-fg":   _H(30,    80,  25  ),
  "--lvis-success":      _H(142,   71,  45  ),
  "--lvis-border":       _H(217,   33,  17  ),
  "--lvis-ring":         _H(224.3, 76.3,48  ),
  "--lvis-radius":       "0.6rem",
  "--lvis-radius-sm":    "0.25rem",
};

const _LIGHT_BASE: Record<string, string> = {
  "--lvis-bg":           _H(0,     0,  100  ),
  "--lvis-surface":      _H(0,     0,  100  ),
  "--lvis-fg":           _H(222,   47,  11  ),
  "--lvis-fg-muted":     _H(215,   16,  47  ),
  "--lvis-primary":      _H(224.3, 76.3,48  ),
  "--lvis-primary-fg":   _H(210,   40,  98  ),
  "--lvis-secondary":    _H(210,   40,  96  ),
  "--lvis-secondary-fg": _H(222,   47,  11  ),
  "--lvis-danger":       _H(0,     84,  60  ),
  "--lvis-danger-fg":    _H(210,   40,  98  ),
  "--lvis-warning":      _H(48,    96,  89  ),
  "--lvis-warning-fg":   _H(30,    80,  25  ),
  "--lvis-success":      _H(142,   71,  45  ),
  "--lvis-border":       _H(214,   32,  91  ),
  "--lvis-ring":         _H(217.2, 91.2,59.8),
  "--lvis-radius":       "0.6rem",
  "--lvis-radius-sm":    "0.25rem",
};

const _HC_BASE: Record<string, string> = {
  "--lvis-bg":           _H(0,   0,   0  ),
  "--lvis-surface":      _H(0,   0,   0  ),
  "--lvis-fg":           _H(0,   0, 100  ),
  "--lvis-fg-muted":     _H(0,   0,  80  ),
  "--lvis-primary":      _H(60, 100,  50  ),
  "--lvis-primary-fg":   _H(0,   0,   0  ),
  "--lvis-secondary":    _H(0,   0,  15  ),
  "--lvis-secondary-fg": _H(0,   0, 100  ),
  "--lvis-danger":       _H(0, 100,  50  ),
  "--lvis-danger-fg":    _H(0,   0, 100  ),
  "--lvis-warning":      _H(48, 100,  50  ),
  "--lvis-warning-fg":   _H(0,   0,   0  ),
  "--lvis-success":      _H(120, 100,  40  ),
  "--lvis-border":       _H(0,   0, 100  ),
  "--lvis-ring":         _H(60, 100,  50  ),
  "--lvis-radius":       "0.6rem",
  "--lvis-radius-sm":    "0.25rem",
};

// Accent tokens that override any shell base for LG brand theme.
// Spread AFTER surface so LG-red danger and vivid-purple primary
// always win even if a surface map accidentally defines them.
const _LG_ACCENT: Record<string, string> = {
  "--lvis-primary":     _H(253, 100, 65),   // #734dff vivid purple SEND
  "--lvis-primary-fg":  _H(0,     0, 100),
  "--lvis-ring":        _H(263,  70,  50),   // p-purple-600
  "--lvis-danger":      _H(1,    98,  59),   // #FD312E LG red
  "--lvis-danger-fg":   _H(0,     0, 100),
};

const _LG_LIGHT_SURFACE: Record<string, string> = {
  "--lvis-bg":           _H(40,  25,  92),   // Grey-6 #F0ECE4
  "--lvis-surface":      _H(44,  37,  94),   // Grey-7 #F6F3EB
  "--lvis-fg":           _H(0,    0,  15),   // Grey-1 #262626
  "--lvis-fg-muted":     _H(43,   3,  43),   // Grey-3 #716F6A
  "--lvis-secondary":    _H(44,  37,  94),
  "--lvis-secondary-fg": _H(0,    0,  15),
  "--lvis-border":       _H(40,  10,  78),   // Grey-4 #CBC8C2
};

const _LG_DARK_SURFACE: Record<string, string> = {
  "--lvis-bg":           _H(0,    0,  15),   // Grey-1 #262626
  "--lvis-surface":      _H(0,    0,  18),
  "--lvis-fg":           _H(44,  37,  94),   // Grey-7 #F6F3EB
  "--lvis-fg-muted":     _H(40,   5,  60),
  "--lvis-secondary":    _H(0,    0,  20),
  "--lvis-secondary-fg": _H(44,  37,  94),
  "--lvis-border":       _H(0,    0,  28),
};

export function resolvePluginTokens(
  theme: ResolvedTheme,
  chatTheme: ChatThemePreference,
): Record<string, string> {
  const base = theme === "light" ? _LIGHT_BASE : theme === "high-contrast" ? _HC_BASE : _DARK_BASE;
  // HC locks primary/ring to yellow; no chat-theme overlay applies.
  if (theme === "high-contrast") return { ...base };
  switch (chatTheme) {
    case "lg": {
      const surface = theme === "dark" ? _LG_DARK_SURFACE : _LG_LIGHT_SURFACE;
      // surface first, then accent — accent must always win (LG red, vivid purple).
      return { ...base, ...surface, ..._LG_ACCENT };
    }
    case "purple":
      return { ...base, "--lvis-primary": _H(262, 83, 58), "--lvis-primary-fg": _H(0, 0, 100), "--lvis-ring": _H(263, 70, 50) };
    case "orange":
      return theme === "dark"
        ? { ...base, "--lvis-primary": _H(25, 95, 53), "--lvis-primary-fg": _H(0, 0, 100), "--lvis-ring": _H(21, 90, 48) }
        : { ...base, "--lvis-primary": _H(21, 90, 48), "--lvis-primary-fg": _H(0, 0, 100), "--lvis-ring": _H(25, 95, 53) };
    case "blue":
      return theme === "dark"
        ? { ...base, "--lvis-primary": _H(217.2, 91.2, 59.8), "--lvis-ring": _H(224.3, 76.3, 48) }
        : { ...base, "--lvis-primary": _H(224.3, 76.3, 48), "--lvis-ring": _H(217.2, 91.2, 59.8) };
    default:   // "default" — no overlay
      return { ...base };
  }
}
