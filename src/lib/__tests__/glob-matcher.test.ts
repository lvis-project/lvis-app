import { describe, expect, it } from "vitest";

import { globMatch, globToRegExp } from "../glob-matcher.js";

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
