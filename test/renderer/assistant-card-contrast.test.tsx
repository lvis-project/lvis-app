/**
 * Light-theme contrast regression guard for AssistantCard.
 *
 * The issue (PR fix/chat-text-contrast-light-theme):
 *   `prose-invert` was applied unconditionally to the assistant message body.
 *   On dark theme the white-ish prose colors looked correct, but once the
 *   `light` shell shipped (PR #336) the chat background turned white and the
 *   bubble's body text (`--tw-prose-body` ≈ slate-200) became invisible on
 *   white. User report 2026-04-30 confirmed assistant replies were unreadable
 *   in light + default chat theme.
 *
 * Two-pronged guard:
 *   1. Component-level: the AssistantCard markdown wrapper must use the
 *      `lvis-prose` class and must NOT carry `prose-invert`. Anyone
 *      introducing a regression by re-adding `prose-invert` (or by deleting
 *      `lvis-prose`) breaks this test loudly.
 *   2. Token-level: we compute the WCAG AA luminance ratio between the
 *      `--foreground` and `--background` HSL primitives shipped by
 *      `src/styles.css` for every shipped `data-theme` variant. The body
 *      text contrast ratio must clear 4.5:1 on every shell.
 *
 * The second prong runs entirely against the CSS token primitives — no DOM,
 * no Tailwind compilation needed — so it stays fast and deterministic in CI.
 */
import "./setup.js";
import { describe, it, expect } from "vitest";
import { relativeLuminance } from "./helpers.js";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { AssistantCard } from "../../src/ui/renderer/components/AssistantCard.js";
import type { ChatEntry } from "../../src/lib/chat-stream-state.js";
import { BUNDLES } from "../../src/ui/renderer/theme/bundles/index.js";

/* ────────────────────────────────────────────────────────────────────────
 * 1. Component-level guard
 * ──────────────────────────────────────────────────────────────────────── */
describe("AssistantCard — markdown wrapper classes (light-theme regression guard)", () => {
  function makeEntry(text: string): Extract<ChatEntry, { kind: "assistant" }> {
    return { kind: "assistant", text, streaming: false };
  }

  it("uses lvis-prose and does NOT carry prose-invert", () => {
    const { getByTestId } = render(<AssistantCard entry={makeEntry("hello world")} />);
    const body = getByTestId("assistant-message-body");
    expect(body.classList.contains("lvis-prose")).toBe(true);
    // The inverted variant hard-codes near-white text. It MUST NOT appear on
    // a chat surface or the light shell will repaint the regression.
    expect(body.classList.contains("prose-invert")).toBe(false);
  });

  it("still applies the base `prose` and `prose-sm` typography classes", () => {
    const { getByTestId } = render(<AssistantCard entry={makeEntry("body")} />);
    const body = getByTestId("assistant-message-body");
    expect(body.classList.contains("prose")).toBe(true);
    expect(body.classList.contains("prose-sm")).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * 2. Token-level guard — WCAG luminance against every shipped shell
 * ──────────────────────────────────────────────────────────────────────── */

/** Convert a CSS HSL triple ("222 47% 11%") to its sRGB tuple in 0..1. */
function hslTripleToRgb(triple: string): [number, number, number] {
  const parts = triple.trim().split(/\s+/);
  const h = parseFloat(parts[0]!);
  const s = parseFloat(parts[1]!.replace("%", "")) / 100;
  const l = parseFloat(parts[2]!.replace("%", "")) / 100;

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return [r + m, g + m, b + m];
}


/** WCAG contrast ratio in 1.0..21.0. */
function contrastRatio(fgHsl: string, bgHsl: string): number {
  const fg = relativeLuminance(hslTripleToRgb(fgHsl));
  const bg = relativeLuminance(hslTripleToRgb(bgHsl));
  const [hi, lo] = fg > bg ? [fg, bg] : [bg, fg];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Snapshot of the `--foreground` and `--background` primitives shipped from
 * `src/styles.css`. If those primitives change, update the table here so
 * we keep guarding the actual ship values, not stale duplicates.
 *
 * (We deliberately re-declare instead of importing — the styles are CSS,
 * not JS, and pulling a CSS parser into Vitest just for token contrast is
 * not worth the install footprint.)
 */
const SHELL_TOKENS: Record<string, { fg: string; bg: string }> = {
  dark: {
    fg: "210 40% 98%",      // --p-slate-50
    bg: "222.2 84% 4.9%",    // --p-slate-950
  },
  light: {
    fg: "222 47% 11%",       // --p-slate-900
    bg: "0 0% 100%",         // --p-slate-0
  },
  "high-contrast": {
    fg: "0 0% 100%",
    bg: "0 0% 0%",
  },
};

describe("Theme tokens — body text contrast must clear WCAG AA on every shell", () => {
  for (const [shell, { fg, bg }] of Object.entries(SHELL_TOKENS)) {
    it(`data-theme=\"${shell}\" has --foreground / --background contrast >= 4.5:1`, () => {
      const ratio = contrastRatio(fg, bg);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe("Theme bundles — chat and code text contrast must clear WCAG AA", () => {
  for (const bundle of BUNDLES) {
    it(`${bundle.id} foreground/background contrast >= 4.5:1`, () => {
      const ratio = contrastRatio(bundle.tokens.foreground, bundle.tokens.background);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });

    it(`${bundle.id} code foreground/background contrast >= 4.5:1`, () => {
      const ratio = contrastRatio(bundle.tokens["code-fg"], bundle.tokens["code-bg"]);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe("lvis-prose CSS coverage — markdown tables stay readable", () => {
  const css = readFileSync("src/styles.css", "utf-8").replace(/\r\n/g, "\n");

  it("uses .prose.lvis-prose specificity so Typography defaults cannot repaint text black", () => {
    expect(css).toContain(".prose.lvis-prose {");
    expect(css).toMatch(/\.prose\.lvis-prose\s+:where\([^)]*\bp\b[^)]*\bstrong\b[^)]*\bth\b[^)]*\btd\b[^)]*\)/);
  });

  it("forces table cells and headers onto semantic foreground tokens", () => {
    expect(css).toMatch(/\.prose\.lvis-prose\s+:where\(td\).*color:\s*hsl\(var\(--foreground\) \/ 0\.88\)/s);
    expect(css).toMatch(/\.prose\.lvis-prose\s+:where\(th\).*color:\s*hsl\(var\(--foreground\)\)/s);
    expect(css).toMatch(/\.lvis-prose\s+:is\([^)]*\bth\b[^)]*\btd\b[^)]*\)/);
    expect(css).toMatch(/\.lvis-prose\s+:is\(td\).*color:\s*hsl\(var\(--foreground\) \/ 0\.88\)/s);
    expect(css).toMatch(/\.lvis-prose\s+:is\(th\).*color:\s*hsl\(var\(--foreground\)\)/s);
  });

  it("keeps nested bold and inline text inside table cells inheriting readable cell color", () => {
    expect(css).toContain(".prose.lvis-prose :where(th *, td *)");
    expect(css).toContain(".lvis-prose :is(th, td) :is(p, span, strong, em)");
  });

  /**
   * Extract and concatenate the contents of every `@layer NAME { ... }` block
   * in `source`. CSS cascade-layers allows the same layer name to appear in
   * multiple `@layer NAME { ... }` declarations (they merge at parse time),
   * so styles.css declares `@layer base` more than once. This walker tracks
   * brace depth to skip multi-level nesting (`:root`, theme bundle blocks)
   * — JS RegExp has no recursive group support, so a regex anchor either
   * fails on the nesting or falsely matches selectors OUTSIDE the layer.
   */
  function extractLayerBody(source: string, layerName: string): string | null {
    const markerRe = new RegExp(`@layer\\s+${layerName}\\s*\\{`, "g");
    const slices: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = markerRe.exec(source)) !== null) {
      let i = match.index + match[0].length;
      let depth = 1;
      while (i < source.length && depth > 0) {
        const ch = source[i];
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        i++;
      }
      if (depth !== 0) return null;
      slices.push(source.slice(match.index + match[0].length, i - 1));
      markerRe.lastIndex = i;
    }
    return slices.length > 0 ? slices.join("\n") : null;
  }

  it("body font-family inside @layer base leads with system-ui and keeps Hangul fallback", () => {
    /*
     * Regression guard for issue #556 / #670. Plugin webviews paint with the
     * same `system-ui`-first stack via plugin-ui-shell.html; host body must
     * lead with `system-ui` so letterforms match across the boundary. The
     * Korean entries that follow are unicode-range fallback (CSS font
     * matching), NOT regression-recovery fallback — Hangul codepoints have
     * no glyph in `system-ui` itself so a Hangul-capable fallback is
     * required by spec.
     *
     * Scoped to `@layer base` via `extractLayerBody` so a future `body { ... }`
     * outside the layer cannot accidentally satisfy the regex.
     */
    const layerBase = extractLayerBody(css, "base");
    expect(layerBase, "@layer base block not found in styles.css").not.toBeNull();
    // styles.css body wraps the default stack in `var(--lvis-font-family, …)`
    // so a Track A user-override path can swap it at runtime. The default
    // stack inside the fallback expression must still begin with `system-ui`
    // and retain a Hangul fallback for cross-OS rendering.
    expect(layerBase!).toMatch(
      /\bbody\s*\{[^{}]*?font-family:\s*var\(\s*--lvis-font-family\s*,\s*system-ui\s*,/,
    );
    expect(layerBase!).toMatch(
      /body\s*\{[^{}]*?font-family:[^{}]*?("Noto Sans KR"|"Malgun Gothic"|"Apple SD Gothic Neo")/,
    );
  });

  /*
   * Issue #556 / #670 — host-owned chrome surfaces ship raw font-family
   * literals across files (CSS / HTML cannot import a JS constant at
   * runtime). The SoT is `src/shared/host-font-stack.ts` (HOST_FONT_STACK).
   * Each mirror file declares the stack with potentially different inline
   * whitespace (splash CSS minifies `, ` to `,` for byte budget). The
   * `mirrors` list below enumerates every host-owned surface; each line is
   * a regex that captures the font-family value verbatim from that file.
   *
   * `extractFontStack` pulls the captured value, normalizes whitespace, and
   * the assertion compares against `HOST_FONT_STACK` normalized the same
   * way — true SoT byte-equality (modulo whitespace) rather than substring.
   * Add a new shell here AND in the grep-zero allowlist below.
   */
  const HOST_FONT_STACK_LITERAL =
    "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, " +
    "\"Apple SD Gothic Neo\", \"Noto Sans KR\", \"Malgun Gothic\", sans-serif";
  // Normalize a font-family value to a canonical form for byte-comparison:
  // - collapse internal whitespace runs to a single space
  // - strip the optional space after every comma (splash CSS minifies these)
  // - trim leading/trailing whitespace
  const normalize = (s: string) =>
    s.replace(/\s+/g, " ").replace(/\s*,\s*/g, ",").trim();

  const FONT_STACK_MIRRORS: Array<{
    label: string;
    path: string;
    /** Returns the font-family value text from the source file, or null if absent. */
    extract: (text: string) => string | null;
  }> = [
    {
      label: "styles.css @layer base body",
      path: "src/styles.css",
      extract: (text) => {
        const layer = extractLayerBody(text, "base");
        if (!layer) return null;
        // styles.css wraps the default stack in `var(--lvis-font-family, <stack>)`
        // so the user-override path can swap it at runtime (Track A font customization).
        // Peel the wrapper if present and return only the inner fallback stack.
        const wrapped = layer.match(/\bbody\s*\{[^{}]*?font-family:\s*var\(\s*--lvis-font-family\s*,\s*([\s\S]*?)\s*\)\s*;/);
        if (wrapped) return wrapped[1]!;
        const raw = layer.match(/\bbody\s*\{[^{}]*?font-family:\s*([^;}]+)/);
        return raw ? raw[1]! : null;
      },
    },
    {
      label: "plugin-ui-shell.html body",
      path: "src/plugin-ui-shell.html",
      extract: (text) => text.match(/body\s*\{[^{}]*?font-family:\s*([^;}]+)/)?.[1] ?? null,
    },
    {
      label: "main.ts splash inline",
      path: "src/main.ts",
      extract: (text) => text.match(/html,body\s*\{[^{}]*?font-family:\s*([^;}]+)/)?.[1] ?? null,
    },
    {
      label: "window-titlebar-shell.ts body",
      path: "src/main/window-titlebar-shell.ts",
      extract: (text) => text.match(/body\s*\{[^{}]*?font-family:\s*([^;}]+)/)?.[1] ?? null,
    },
    {
      label: "tools/render-html.ts wrapWithCsp",
      path: "src/tools/render-html.ts",
      extract: (text) => text.match(/html,body\{[^{}]*?font-family:([^;}]+)/)?.[1] ?? null,
    },
  ];

  it("every host-owned chrome surface mirrors HOST_FONT_STACK byte-for-byte (whitespace-normalized)", () => {
    for (const { label, path, extract } of FONT_STACK_MIRRORS) {
      const text = readFileSync(path, "utf-8").replace(/\r\n/g, "\n");
      const value = extract(text);
      expect(value, `${label}: could not locate font-family literal — extractor stale?`).not.toBeNull();
      expect(normalize(value!), `${label}: stack diverges from HOST_FONT_STACK`).toBe(normalize(HOST_FONT_STACK_LITERAL));
    }
  });

  it("HOST_FONT_STACK is the ONLY surface that mentions Noto Sans KR as a fallback (grep-zero invariant)", () => {
    /*
     * Defensive — if anyone adds a NEW host-owned shell that bakes a raw
     * font stack containing `"Noto Sans KR"` they must register it in the
     * mirror list above. Allowlist below = SoT module + every registered
     * mirror + this test file.
     */
    const allowlist = new Set(
      [
        "src/shared/host-font-stack.ts",
        ...FONT_STACK_MIRRORS.map((m) => m.path),
        // Test files reference the stack literally for assertions.
        "test/renderer/assistant-card-contrast.test.tsx",
        // Track A: AppearanceTab ships FONT_FAMILY_PRESETS with named Hangul
        // fonts (Pretendard / Noto Sans KR / IBM Plex) that the user can pick
        // from. These are not HOST_FONT_STACK mirrors — they are user-facing
        // preset options that ship the named-font-family stacks the validator
        // then accepts as `appearance.font.family`. Allowlisted.
        "src/ui/renderer/tabs/AppearanceTab.tsx",
        // Settings-store unit tests exercise the font-family validator with
        // sample stacks containing the same Korean font names.
        "src/data/__tests__/settings-store.test.ts",
      ].map((p) => p.replace(/\\/g, "/")),
    );
    function walk(dir: string, out: string[], depth = 0): void {
      // depth cap = 12 — protects against symlink cycles a contributor might
      // introduce under src/ without notice. The repo today has no symlinks.
      if (depth > 12) return;
      const fs = require("node:fs") as typeof import("node:fs");
      const path = require("node:path") as typeof import("node:path");
      let entries: string[];
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const name of entries) {
        const full = path.join(dir, name).replace(/\\/g, "/");
        let s;
        try { s = fs.lstatSync(full); } catch { continue; }
        if (s.isSymbolicLink()) continue;
        if (s.isDirectory()) {
          if (name === "node_modules" || name === "dist") continue;
          walk(full, out, depth + 1);
          continue;
        }
        if (/\.(ts|tsx|html|css)$/.test(name)) out.push(full);
      }
    }
    const files: string[] = [];
    walk("src", files);
    const violations: string[] = [];
    for (const f of files) {
      if (allowlist.has(f)) continue;
      const text = readFileSync(f, "utf-8");
      if (/"Noto Sans KR"|"Malgun Gothic"|"Apple SD Gothic Neo"/.test(text)) {
        violations.push(f);
      }
    }
    expect(
      violations,
      "Korean font fallback should only appear inside HOST_FONT_STACK mirrors — add new shell to FONT_STACK_MIRRORS + allowlist",
    ).toEqual([]);
  });

  it("keeps lvis-prose rules UNLAYERED so they beat Tailwind Typography's @layer utilities", () => {
    /*
     * Regression guard for the 2026-05-13 dark-theme bold/strong/th issue
     * (PR #665 review). Tailwind v4 emits the typography plugin under
     * `@layer utilities` which includes a hard-coded
     *   .prose { --tw-prose-bold: oklch(21% …) }  /* dark color *\/
     * Wrapping `.lvis-prose` overrides in `@layer components` (or any
     * earlier layer) silently loses to `@layer utilities` per the CSS
     * cascade-layers spec REGARDLESS of selector specificity. The only
     * reliable fix is to keep the lvis-prose block unlayered.
     *
     * This test reads the source CSS and asserts the lvis-prose block is
     * not wrapped in any @layer directive.
     */
    const lvisAnchor = css.indexOf(".prose.lvis-prose,\n  .lvis-prose {");
    expect(lvisAnchor).toBeGreaterThan(0);
    // Walk backwards looking for the nearest unbalanced `@layer NAME {`
    // (i.e. one whose matching `}` is after lvisAnchor).
    const head = css.slice(0, lvisAnchor);
    let depth = 0;
    let i = head.length;
    while (i > 0) {
      const ch = head[i - 1];
      if (ch === "}") depth++;
      else if (ch === "{") {
        if (depth === 0) {
          // Found enclosing open-brace. Inspect what comes before it.
          const before = head.slice(Math.max(0, i - 80), i - 1).trim();
          expect(before).not.toMatch(/@layer\s+\w/);
          return;
        }
        depth--;
      }
      i--;
    }
    // Reached file start without finding an enclosing `{` → unlayered. OK.
  });
});
