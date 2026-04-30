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
import { AssistantCard } from "../../src/ui/renderer/components/AssistantCard.js";
import type { ChatEntry } from "../../src/lib/chat-stream-state.js";

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
