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
// The bidi range is listed separately because those characters are NOT
// default-ignorable: they reorder what is already visible rather than hiding.
const CONTROL_AND_INVISIBLE_RE = new RegExp(
  "["
  + "\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f" // C0 / C1 controls
  + "\\u202a-\\u202e\\u2066-\\u2069" // bidi embeddings, overrides, isolates
  + "]"
  + "|\\p{Default_Ignorable_Code_Point}",
  "gu",
);

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
