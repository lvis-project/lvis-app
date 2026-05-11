/**
 * Tailwind config — references SEMANTIC design tokens defined in
 * `src/styles.css`. Adding a new theme variant is a CSS-only change; this
 * file only changes when a new SEMANTIC token name is introduced.
 *
 * `darkMode: "class"` is retained for ecosystem compatibility (Storybook,
 * `dark:` utility) but theme switching is driven by `data-theme` on <html>
 * via ThemeProvider — see `docs/development/theme-system.md`.
 *
 * Token tier docs: docs/development/theme-system.md
 *
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  darkMode: ["class", '[data-theme="dark"]'],
  content: ["./src/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        "message-user": {
          DEFAULT: "hsl(var(--message-user-bg) / <alpha-value>)",
          foreground: "hsl(var(--message-user-fg) / <alpha-value>)",
        },
        "input-bar": "hsl(var(--input-bar-bg) / <alpha-value>)",
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning) / <alpha-value>)",
          foreground: "hsl(var(--warning-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success) / <alpha-value>)",
          foreground: "hsl(var(--success-foreground))",
        },
        info: {
          DEFAULT: "hsl(var(--info) / <alpha-value>)",
          foreground: "hsl(var(--info-foreground))",
        },
        emphasis: {
          DEFAULT: "hsl(var(--emphasis) / <alpha-value>)",
          foreground: "hsl(var(--emphasis-foreground))",
        },
        "action-view": "hsl(var(--action-view) / <alpha-value>)",
        "action-branch": "hsl(var(--action-branch) / <alpha-value>)",
        "action-compact": "hsl(var(--action-compact) / <alpha-value>)",
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [
    require("@tailwindcss/typography"),
  ],
};
