/**
 * Labels built from server-supplied strings.
 *
 * The property is not "no dangerous characters" — the value is never executed. It is
 * that a label CANNOT LIE: two different resources must not render identically, and a
 * name must not render in an order other than the one it is stored in. Both are how a
 * user picks the wrong resource while believing they picked the right one.
 *
 * Every hostile character is written as an ESCAPE, never as a literal. A literal one is
 * invisible in the diff and the review that are supposed to check this file, and the
 * build gate refuses it for that reason.
 */
import { describe, expect, it } from "vitest";
import { displaySafeLabel } from "../display-safe-text.js";

const ZWSP = "​";
const ZWNBSP = "﻿";
const WORD_JOINER = "⁠";
const RLO = "‮";
const LRI = "⁦";
const PDI = "⁩";

describe("displaySafeLabel", () => {
  it("makes two names that render alike render differently", () => {
    // A zero-width space between characters is invisible in a picker row, so a hostile
    // `poli<ZWSP>cy.md` sits under the real `policy.md` looking identical. Removing it
    // is what puts the difference back on screen.
    const spoof = `poli${ZWSP}cy.md`;
    expect(spoof).not.toBe("policy.md");
    expect(displaySafeLabel(spoof, 128)).toBe("policy.md");
    expect(displaySafeLabel(`poli${ZWNBSP}cy${WORD_JOINER}.md`, 128)).toBe("policy.md");
  });

  it("strips the bidi override that reverses a visible name", () => {
    // The classic filename trick: RLO makes `…gnp.exe` read as `…exe.png`.
    expect(displaySafeLabel(`report-${RLO}gnp.exe`, 128)).toBe("report-gnp.exe");
    expect(displaySafeLabel(`a${LRI}b${PDI}c`, 128)).toBe("abc");
  });

  it("removes controls that could forge a row or truncate one", () => {
    expect(displaySafeLabel("policy\u0000.md", 128)).toBe("policy.md");
    expect(displaySafeLabel("line\u001fbreak", 128)).toBe("linebreak");
    // Real whitespace collapses rather than vanishing — the name stays readable.
    expect(displaySafeLabel("  annual   report .md  ", 128)).toBe("annual report .md");
    // A newline is whitespace, so it collapses to a space instead of splitting the row.
    expect(displaySafeLabel("two\nlines", 128)).toBe("two lines");
  });

  it("bounds the label and reports nothing for nothing", () => {
    expect(displaySafeLabel("x".repeat(500), 64)).toHaveLength(64);
    // An all-invisible name returns empty so the caller can fall back to the URI rather
    // than render a row the user cannot see or click with confidence.
    expect(displaySafeLabel(ZWSP.repeat(4), 128)).toBe("");
    expect(displaySafeLabel(42, 128)).toBe("");
    expect(displaySafeLabel(undefined, 128)).toBe("");
  });
});
