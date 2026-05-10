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
});
