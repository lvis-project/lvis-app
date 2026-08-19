/**
 * Make a string from outside the host safe to RENDER as a label.
 *
 * This is a display concern, not a validation one, and the distinction matters: the
 * value it protects (an MCP resource's name, title, or URI) must reach the server that
 * published it byte-for-byte, so it cannot be normalized at the boundary the way an
 * invalid one is rejected there. What this returns is for the eye only — the picker row,
 * a chip, a tooltip — while the original travels unchanged.
 *
 * Three classes of character, all of which make a label lie about itself:
 *   - C0/C1 controls, which can truncate a row or forge a line;
 *   - zero-width characters, which let two different resources render identically
 *     (`policy.md` and `poli​cy.md`), so a user cannot tell which one they picked;
 *   - bidi overrides and isolates, which reorder the visible string — the trick that
 *     makes `annual-report-‮gnp.exe` read as `annual-report-exe.png`.
 *
 * Related but deliberately separate: `permissions/reviewer` sanitizes untrusted text
 * with an overlapping character class plus markdown stripping and secret masking,
 * because its output is fed to a MODEL. This one only has to make a label honest, so it
 * does not touch anything else — sharing one function would mean either that path
 * stopped masking secrets or this one started rewriting names it has no business
 * rewriting.
 *
 * Pure: no imports, so it stays usable from any process.
 */

// Escaped spellings on purpose: a literal control byte in a source file is invisible
// in every diff and review that would otherwise have to catch it, which is why the
// build gate refuses them.
//
// Tab, newline and CR are deliberately NOT in this class. They are real whitespace, so
// the collapse below turns them into a single space, which keeps the separation the eye
// sees. Deleting them would make a name with a line break render identically to one
// without it - re-creating the collision this function exists to prevent, one character
// class further along. Found by a test, not by review.
//
// `Default_Ignorable_Code_Point` rather than hand-listed ranges, because the
// hand-listed version passed its own tests while sixteen other invisibles walked
// straight through it - soft hyphen, the Hangul fillers, variation selectors, the
// astral tag characters. A property escape IS the class, so the next one nobody has
// heard of is covered too; enumerating ranges is a promise to keep re-reading the
// Unicode tables forever. The `u` flag is what makes the astral ones match as
// codepoints instead of as lone surrogates.
//
// ACCEPTED COST, stated rather than discovered: the class includes variation selectors,
// so a server-published `<warning emoji>+VS16 alert.md` renders with the monochrome
// glyph instead of the emoji one. That is a legitimate prose codepoint being removed by
// the half of the split that is supposed to leave prose alone, and it is kept anyway
// because the same character is a spoof vector in the OTHER consumer: after a
// non-emoji character a variation selector renders as nothing, so `file:///a<VS>b.md`
// and `file:///ab.md` are indistinguishable identifiers. One class, two consumers, and
// the identifier's need wins — a label losing an emoji's colour is a cosmetic loss, a
// URI that can impersonate another URI is not.
//
// The bidi range is listed explicitly as belt-and-braces. Note it is NOT because those
// characters fall outside the property — U+202A-U+202E and U+2066-U+2069 are all
// `Default_Ignorable`, verified. An earlier version of this comment claimed the
// opposite, which is worse than saying nothing: a reader who believed it could delete
// the property escape and keep the enumeration, which is exactly backwards.
const CONTROL_AND_INVISIBLE_RE = new RegExp(
  "["
  + "\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f" // C0 / C1 controls
  + "\\u202a-\\u202e\\u2066-\\u2069" // bidi embeddings, overrides, isolates
  + "]"
  + "|\\p{Default_Ignorable_Code_Point}",
  "gu",
);

/**
 * Does `value` contain a character that makes a string lie about itself?
 *
 * Exported so a VALIDATION boundary can refuse such a value outright while this module
 * keeps the one definition of the class. `isUsableResourceUri` uses it: a URI is an
 * identifier, so a bidi override or a zero-width space in one has no legitimate use and
 * the audit row that prints it cannot be display-normalized without falsifying a
 * forensic record.
 *
 * The two consumers differ in what they DO, not in what they recognize, and that split
 * is the point: prose (a resource's `name` or `title`) can legitimately contain any
 * codepoint, so it is normalized for display; an identifier can be refused. A second
 * enumeration for the boundary is what this replaces — it leaked 14 of 17 sampled
 * members of the class, which is the failure this module's own comment predicts about
 * hand-listed ranges.
 */
export function hasInvisibleOrReorderingChars(value: string): boolean {
  CONTROL_AND_INVISIBLE_RE.lastIndex = 0;
  return CONTROL_AND_INVISIBLE_RE.test(value);
}

// The VALIDATION class, kept here rather than at the boundaries because the
// boundaries kept getting it different. Twelve modules each wrote the range out
// by hand and landed on four different answers; the union below is what those
// authors between them found to matter, and no single site had all of it.
//
//   - C0 (U+0000-U+001F) and DEL: every copy had these.
//   - C1 (U+0080-U+009F): only `tool-use-id` had these. U+0085 is NEL, a line
//     terminator, and U+009B is CSI - the 8-bit form of the `ESC [` that
//     introduces an ANSI escape sequence. A validator that refuses U+001B and
//     admits U+009B is not expressing a policy, it is missing a case.
//   - U+2028 / U+2029: only `memory-capture-service` had these. They are LINE
//     SEPARATOR and PARAGRAPH SEPARATOR - line breaks that a C0 range does not
//     cover and that JSON carries through unescaped.
//
// Deliberately NOT folded in: the bidi and `Default_Ignorable` members of
// `CONTROL_AND_INVISIBLE_RE` above. That class is applied by DELETING from a
// string; this one is applied by REFUSING one. The accepted cost recorded above
// - variation selectors go with it - is a monochrome glyph when you delete and
// a dropped user message when you refuse. Those are not the same price, so the
// two classes stay apart and each one says which operation it is for.
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// The same class with the three characters that are real whitespace put back.
// Tab, newline and carriage return are ordinary content in a chat message, a
// formatted transcript, or a directive; the rest of C0 is not.
const NON_WHITESPACE_CONTROL_CHAR_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Does `value` carry a control character of any kind?
 *
 * For fields where no whitespace is content: identifiers, session ids, logins,
 * capability keys, model and mode names, single-line titles. Refusing is the
 * caller's job; this only answers the question.
 */
export function hasControlChars(value: string): boolean {
  return CONTROL_CHAR_RE.test(value);
}

/**
 * Does `value` carry a control character other than tab, newline or carriage
 * return?
 *
 * For fields where line structure is content: a message body, a formatted
 * transcript, a directive. Use {@link hasControlChars} for anything that has to
 * stay on one line - the difference between these two is the difference between
 * prose and an identifier, and the sites that had it wrong had it wrong by
 * copying the neighbouring field's check rather than by choosing.
 */
export function hasNonWhitespaceControlChars(value: string): boolean {
  return NON_WHITESPACE_CONTROL_CHAR_RE.test(value);
}

/**
 * Collapse everything invisible or reordering out of `value`, bound it, and trim.
 * Returns `""` for a non-string or an all-invisible input, which the caller shows as a
 * fallback rather than as an empty row.
 */
export function displaySafeLabel(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(CONTROL_AND_INVISIBLE_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}
