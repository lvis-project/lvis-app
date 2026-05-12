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

/** WCAG 2.2 relative luminance from sRGB tuple. */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number): number =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
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

  it("body font-family inside @layer base leads with system-ui and mirrors HOST_FONT_STACK", () => {
    /*
     * Regression guard for issue #556 / #670. Plugin webviews paint with the
     * same `system-ui`-first stack via plugin-ui-shell.html; host body must
     * lead with `system-ui` so letterforms match across the boundary. The
     * Korean entries that follow are unicode-range fallback (CSS font
     * matching), NOT regression-recovery fallback — Hangul codepoints have
     * no glyph in `system-ui` itself so a Hangul-capable fallback is
     * required by spec.
     *
     * Anchored to `@layer base` so a future `body.foo { ... }` override
     * elsewhere in the file cannot accidentally satisfy the regex. Uses
     * `[^{}]*?` so a nested rule (`&::before { ... }`) inside the body
     * block still preserves the assertion.
     */
    expect(css).toMatch(
      /@layer\s+base\s*\{[\s\S]*?\bbody\s*\{[^{}]*?font-family:\s*system-ui\s*,/,
    );
    // Korean fallback must still be in the stack so Hangul renders cross-OS.
    expect(css).toMatch(
      /body\s*\{[^{}]*?font-family:[^{}]*?("Noto Sans KR"|"Malgun Gothic"|"Apple SD Gothic Neo")/,
    );
  });

  it("all host-owned chrome surfaces mirror HOST_FONT_STACK (SoT cross-mirror invariant)", () => {
    /*
     * Issue #556 / #670 — host-owned chrome surfaces ship raw font-family
     * literals across 5 files (CSS / HTML cannot import a JS constant at
     * runtime). The SoT is `src/shared/host-font-stack.ts` (HOST_FONT_STACK).
     * This test asserts every mirror leads with `system-ui` AND includes
     * the Korean fallback chain, so a typography update in one surface that
     * forgets a sibling fails loudly here.
     */
    const mirrors: Array<[string, string]> = [
      ["styles.css body", css],
      ["plugin-ui-shell.html body", readFileSync("src/plugin-ui-shell.html", "utf-8").replace(/\r\n/g, "\n")],
      ["main.ts splash inline", readFileSync("src/main.ts", "utf-8").replace(/\r\n/g, "\n")],
      ["window-titlebar-shell.ts body", readFileSync("src/main/window-titlebar-shell.ts", "utf-8").replace(/\r\n/g, "\n")],
    ];
    for (const [label, text] of mirrors) {
      expect(text, `${label} must lead font-family with system-ui`).toMatch(
        /font-family\s*:\s*system-ui\s*,/,
      );
      expect(text, `${label} must keep a Hangul fallback in the stack`).toMatch(
        /font-family\s*:[^;}]*?("Noto Sans KR"|"Malgun Gothic"|"Apple SD Gothic Neo")/,
      );
    }
  });

  it("HOST_FONT_STACK is the ONLY surface that mentions Noto Sans KR as a fallback (grep-zero invariant)", () => {
    /*
     * Defensive — if anyone adds a NEW host-owned shell that bakes a raw
     * font stack containing `"Noto Sans KR"` they must register it in the
     * mirror list above. The 4 known mirrors plus the SoT module are
     * allow-listed; every other src/ file must be 0.
     */
    const allowlist = new Set(
      [
        "src/shared/host-font-stack.ts",
        "src/styles.css",
        "src/plugin-ui-shell.html",
        "src/main.ts",
        "src/main/window-titlebar-shell.ts",
        // Test files reference the stack literally for assertions.
        "test/renderer/assistant-card-contrast.test.tsx",
      ].map((p) => p.replace(/\\/g, "/")),
    );
    function walk(dir: string, out: string[]): void {
      const fs = require("node:fs") as typeof import("node:fs");
      const path = require("node:path") as typeof import("node:path");
      let entries: string[];
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const name of entries) {
        const full = path.join(dir, name).replace(/\\/g, "/");
        let s;
        try { s = fs.statSync(full); } catch { continue; }
        if (s.isDirectory()) {
          if (name === "node_modules" || name === "dist") continue;
          walk(full, out);
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
      "Korean font fallback should only appear inside HOST_FONT_STACK mirrors — add new shell to the mirror list",
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
