import { describe, expect, it } from "vitest";

import { containsGlobMetacharacter, globMatch, globToRegExp } from "../glob-matcher.js";

describe("glob-matcher", () => {
  it("matches double-star with zero or more path segments", () => {
    const re = globToRegExp("src/**/*.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/nested/b.ts")).toBe(true);
    expect(re.test("src/a.js")).toBe(false);
  });

  it("keeps single-star and question-mark within one segment", () => {
    expect(globMatch("src/abc.ts", "src/a?c.*", { caseInsensitive: false })).toBe(true);
    expect(globMatch("src/nested/abc.ts", "src/*.ts", { caseInsensitive: false })).toBe(false);
  });

  it("normalizes Windows separators", () => {
    expect(globMatch("src\\nested\\b.ts", "src/**/*.ts", { caseInsensitive: false })).toBe(true);
  });

  it("supports explicit case-insensitive matching for sensitive path policy", () => {
    expect(globMatch("/Users/me/.SSH/id_rsa", "**/.ssh/**", { caseInsensitive: true })).toBe(true);
  });

  it("does not let single-star cross path segment boundaries", () => {
    expect(globMatch("/work/a/b/secret.txt", "/work/*/secret.txt", { caseInsensitive: false })).toBe(false);
    expect(globMatch("/work/a/secret.txt", "/work/*/secret.txt", { caseInsensitive: false })).toBe(true);
  });

  it("matches double-star sensitive directory descendants", () => {
    expect(globMatch("/Users/me/.ssh/nested/id_ed25519", "**/.ssh/**", { caseInsensitive: false })).toBe(true);
    expect(globMatch("/Users/me/.ssh", "**/.ssh/**", { caseInsensitive: false })).toBe(false);
  });

  it("escapes regex metacharacters in literal path segments", () => {
    expect(globMatch("/tmp/a+b/file[1].txt", "/tmp/a+b/file[1].txt", { caseInsensitive: false })).toBe(true);
    expect(globMatch("/tmp/ab/file1.txt", "/tmp/a+b/file[1].txt", { caseInsensitive: false })).toBe(false);
  });

  it("treats brace syntax as a literal because this matcher is a small subset", () => {
    expect(globMatch("/tmp/{a,b}.txt", "/tmp/{a,b}.txt", { caseInsensitive: false })).toBe(true);
    expect(globMatch("/tmp/a.txt", "/tmp/{a,b}.txt", { caseInsensitive: false })).toBe(false);
  });

  it("does not treat an empty pattern as a wildcard", () => {
    expect(globMatch("", "", { caseInsensitive: false })).toBe(true);
    expect(globMatch("anything", "", { caseInsensitive: false })).toBe(false);
  });

  it("keeps root-anchored and relative patterns distinct", () => {
    expect(globMatch("/work/a.txt", "/work/*.txt", { caseInsensitive: false })).toBe(true);
    expect(globMatch("work/a.txt", "/work/*.txt", { caseInsensitive: false })).toBe(false);
  });

  it("matches trailing double-star against all descendants", () => {
    expect(globMatch("/work/a/b/c.txt", "/work/**", { caseInsensitive: false })).toBe(true);
    expect(globMatch("/other/a.txt", "/work/**", { caseInsensitive: false })).toBe(false);
  });
});

describe("containsGlobMetacharacter", () => {
  // Any character the caller does not flag is a character it is promising the
  // matcher treats literally. Rather than restate the promise, ask the matcher:
  // for every printable ASCII character, a pattern built around it must either
  // be flagged, or match nothing but itself. A metacharacter added to
  // `globToRegExpSource` without being added to the predicate fails here.
  const PRINTABLE_ASCII = Array.from(
    { length: 0x7e - 0x20 + 1 },
    (_unused, index) => String.fromCharCode(0x20 + index),
  );

  // `\` is deliberately outside the sweep, and is pinned on its own below. It
  // is not a wildcard but a separator: `normalizeGlobPath` rewrites it to `/`
  // on the pattern AND on the path being tested, so it cannot expand a grant
  // into a family of names. Flagging it would refuse every grant on Windows,
  // where every path is full of them.
  const SEPARATOR = "\\";

  it.each(
    PRINTABLE_ASCII
      .filter((ch) => ch !== SEPARATOR)
      .map((ch) => [ch.charCodeAt(0).toString(16), ch]),
  )(
    "flags U+%s or matches it literally",
    (_hex, ch) => {
      const name = `pre${ch}post`;
      if (containsGlobMetacharacter(name)) return;

      // Not flagged, so it must behave as itself: matching the identical name,
      // and matching no other name of the same shape.
      expect(globMatch(name, name, { caseInsensitive: false })).toBe(true);
      for (const other of ["preXpost", "prepost", "preXXpost", "pre/post"]) {
        if (other === name) continue;
        expect(globMatch(other, name, { caseInsensitive: false })).toBe(false);
      }
    },
  );

  it("treats a backslash as a separator, not as a wildcard", () => {
    // Both sides are normalised, so a name holding a literal backslash and the
    // same name holding a separator collapse onto each other — a one-for-one
    // confusion between two specific paths, not a widening to a family. On a
    // POSIX filesystem, where a backslash is a legal filename character, that
    // still means a grant reaches a path the user did not read; it is recorded
    // here rather than fixed, because refusing it would refuse every Windows
    // path grant and the remedy belongs with the separator handling.
    const pattern = String.raw`pre\post`;

    expect(globMatch(String.raw`pre\post`, pattern, { caseInsensitive: false })).toBe(true);
    expect(globMatch("pre/post", pattern, { caseInsensitive: false })).toBe(true);
    // The bound that matters: it still cannot reach an arbitrary sibling.
    expect(globMatch("preXpost", pattern, { caseInsensitive: false })).toBe(false);
    expect(globMatch("pre/other/post", pattern, { caseInsensitive: false })).toBe(false);
  });

  it("flags exactly the characters this matcher gives meaning to", () => {
    expect(containsGlobMetacharacter("Reports*2024")).toBe(true);
    expect(containsGlobMetacharacter("Reports?2024")).toBe(true);
    expect(containsGlobMetacharacter("/work/**/notes.md")).toBe(true);
    expect(containsGlobMetacharacter("/work/Reports-2024/notes.md")).toBe(false);
    // Brackets and braces reach `escapeRegex`, so they are already literal and
    // flagging them would refuse grants that carry no wildcard at all.
    expect(containsGlobMetacharacter("[2024-06] Reports")).toBe(false);
    expect(containsGlobMetacharacter("/work/{a,b}")).toBe(false);
  });

  it("cannot be satisfied by escaping, because the grammar has no escape", () => {
    // The reason rejection is the fix rather than a `escapeGlobLiteral()`:
    // a backslash is rewritten to a separator before the pattern is read, so
    // the "escaped" asterisk is still a wildcard and the backslash has become
    // a path boundary.
    expect(globMatch("Reports*2024", String.raw`Reports\*2024`, { caseInsensitive: false })).toBe(false);
    expect(globMatch("Reports/X2024", String.raw`Reports\*2024`, { caseInsensitive: false })).toBe(true);
  });
});
