/**
 * Labels built from server-supplied strings.
 *
 * The property is not "no dangerous characters" — the value is never executed. It is
 * that a label CANNOT LIE: two different resources must not render identically, and a
 * name must not render in an order other than the one it is stored in. Both are how a
 * user picks the wrong resource while believing they picked the right one.
 *
 * Every hostile character is written as a `String.fromCodePoint` ESCAPE rather than as a
 * literal, so a reader can see WHICH character each case is about. Note what does NOT
 * enforce that: `check-source-text-safe.mjs` tests raw BYTES below 0x20, so U+200B
 * (`E2 80 8B`) is structurally invisible to it. The discipline here is the author's, and
 * an earlier version of this file claimed the gate as its enforcement while carrying six
 * literal invisibles — which is exactly the unreviewable diff the discipline exists to
 * prevent.
 */
import { describe, expect, it } from "vitest";
import { displaySafeLabel, hasControlChars, hasInvisibleOrReorderingChars, hasNonWhitespaceControlChars } from "../display-safe-text.js";

const cp = (value: number) => String.fromCodePoint(value);
const ZWSP = cp(0x200b);
const ZWNBSP = cp(0xfeff);
const WORD_JOINER = cp(0x2060);
const RLO = cp(0x202e);
const LRI = cp(0x2066);
const PDI = cp(0x2069);
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

  // The test that the hand-listed version passed while sixteen other invisibles walked
  // through it. Enumerating cases here would repeat that mistake with a longer list, so
  // this asserts over a SAMPLE OF THE CLASS instead — one representative per family a
  // reviewer found, plus two astral ones that only match under the `u` flag.
  it("removes the whole default-ignorable class, not a list of remembered characters", () => {
    const invisibles = [
      0x00ad, // soft hyphen
      0x034f, // combining grapheme joiner
      0x061c, // Arabic letter mark
      0x115f, // Hangul choseong filler
      0x1160, // Hangul jungseong filler
      0x17b4, // Khmer vowel inherent aq
      0x180b, // Mongolian free variation selector
      0x2065, // unassigned but default-ignorable
      0x3164, // Hangul filler
      0xfe00, // variation selector 1
      0xfe0f, // variation selector 16
      0xffa0, // halfwidth Hangul filler
      0xe0001, // language tag (astral)
      0xe0041, // tag latin capital A (astral)
    ];
    for (const codePoint of invisibles) {
      const spoof = `poli${String.fromCodePoint(codePoint)}cy.md`;
      // The premise: it is a DIFFERENT string that renders the same. If this ever fails,
      // the case is measuring nothing.
      expect(spoof, codePoint.toString(16)).not.toBe("policy.md");
      expect(displaySafeLabel(spoof, 128), codePoint.toString(16)).toBe("policy.md");
    }
  });

  it("leaves legitimate non-ASCII names alone", () => {
    // The counterweight: the rule must not become "strip anything unfamiliar". A server
    // publishing Hangul or CJK names is honest and common, and a picker that mangles them
    // is a worse outcome than the spoof it was defending against.
    expect(displaySafeLabel("정상-보고서.md", 128)).toBe("정상-보고서.md");
    expect(displaySafeLabel("年度報告.pdf", 128)).toBe("年度報告.pdf");
    expect(displaySafeLabel("café-résumé.txt", 128)).toBe("café-résumé.txt");
  });

  it("strips a variation selector, which is a deliberate cost", () => {
    // Pinned so it reads as a decision. The emoji loses its colour presentation in a
    // label; the same character after a non-emoji character is invisible, which is why
    // the shared class refuses it for identifiers. See the module comment.
    const VS16 = String.fromCodePoint(0xfe0f);
    expect(displaySafeLabel(`⚠${VS16} alert.md`, 128)).toBe("⚠ alert.md");
  });
});

describe("hasControlChars / hasNonWhitespaceControlChars", () => {
  it("catches the C1 controls that only one of twelve hand-written copies had", () => {
    // U+0085 is NEL, a line terminator. U+009B is CSI, the 8-bit form of the
    // `ESC [` that opens an ANSI escape sequence. A validator that refuses
    // U+001B (which every copy did) and admits U+009B is missing a case, not
    // expressing a policy.
    expect(hasControlChars(`a${"\u001b"}b`)).toBe(true);
    expect(hasControlChars(`a${"\u009b"}b`)).toBe(true);
    expect(hasControlChars(`a${"\u0085"}b`)).toBe(true);
    expect(hasNonWhitespaceControlChars(`a${"\u009b"}b`)).toBe(true);
    expect(hasNonWhitespaceControlChars(`a${"\u0085"}b`)).toBe(true);
  });

  it("catches U+2028/U+2029, the line breaks a C0 range does not cover", () => {
    expect(hasControlChars(`a${"\u2028"}b`)).toBe(true);
    expect(hasControlChars(`a${"\u2029"}b`)).toBe(true);
    expect(hasNonWhitespaceControlChars(`a${"\u2028"}b`)).toBe(true);
  });

  it("splits on tab/newline/CR and nothing else", () => {
    for (const ws of ["\t", "\n", "\r"]) {
      expect(hasControlChars(`a${ws}b`)).toBe(true);
      expect(hasNonWhitespaceControlChars(`a${ws}b`)).toBe(false);
    }
    expect(hasControlChars("plain text")).toBe(false);
    expect(hasNonWhitespaceControlChars("plain text")).toBe(false);
  });

  it("leaves bidi, zero-width and variation selectors to the display class", () => {
    // Stated so the omission reads as a decision. These classes are applied by
    // different operations: the display one DELETES, so losing a variation
    // selector costs a monochrome glyph; these two REFUSE, so folding the same
    // members in would drop a user's emoji-bearing message outright.
    expect(hasControlChars(`a${"\u202e"}b`)).toBe(false);
    expect(hasControlChars(`a${"\u200b"}b`)).toBe(false);
    expect(hasControlChars(`ok${"\ufe0f"}`)).toBe(false);
    expect(hasInvisibleOrReorderingChars(`a${"\u202e"}b`)).toBe(true);
    expect(hasInvisibleOrReorderingChars(`a${"\u200b"}b`)).toBe(true);
  });
});
