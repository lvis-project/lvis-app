import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
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
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // ── Ink (the brand): near-black cool neutral. Primary text + buttons + active. ──
        ink: { DEFAULT: "#14161d", soft: "#3a3d47" },
        // ── Ambient accent: the single soft periwinkle glow (antigravity). Never text. ──
        glow: { DEFAULT: "#b7bfd9", soft: "#c3ccdf" },
        // ── Legacy brand aliases — remapped to neutral so existing classes across the
        //    41 routes keep working but resolve to the monochrome system. Prefer
        //    ink / secondary / muted-foreground / glow in new code. See DESIGN.md §3.3.
        teal: {
          DEFAULT: "#3a3d47", // was brand green → ink-soft (eyebrows/labels/links)
          dark: "#14161d", //    → ink
          50: "#f3f4f6",
          100: "#e6e7ec",
          500: "#3a3d47",
          600: "#26282f",
          700: "#14161d",
        },
        citron: { DEFAULT: "#e7eaf2", soft: "#eef0f6" }, // lime → soft periwinkle chip
        coral: { DEFAULT: "#7a7f8a" }, //                    orange → muted neutral
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      // System-first stack matching the marketplace, with Korean coverage. No web-font download.
      fontFamily: {
        sans: [
          "Pretendard Variable",
          "Pretendard",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Apple SD Gothic Neo",
          "Noto Sans KR",
          "system-ui",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.18s ease-out",
        "accordion-up": "accordion-up 0.18s ease-out",
        "fade-in": "fade-in 0.32s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
