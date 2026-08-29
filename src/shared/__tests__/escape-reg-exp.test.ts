import { describe, expect, it } from "vitest";

import { escapeRegExp } from "../escape-reg-exp.js";

describe("escapeRegExp", () => {
  it("makes every regex metacharacter match itself", () => {
    for (const meta of [".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]) {
      expect(new RegExp(`^${escapeRegExp(meta)}$`).test(meta)).toBe(true);
    }
  });

  it("stops a crafted value from matching more than itself", () => {
    // The callers build patterns out of a plugin id, a tool alias or a path.
    // Unescaped, `a.c` would also match `abc`.
    expect(new RegExp(`^${escapeRegExp("a.c")}$`).test("abc")).toBe(false);
    expect(new RegExp(`^${escapeRegExp("a.c")}$`).test("a.c")).toBe(true);
    expect(new RegExp(`^${escapeRegExp(".*")}$`).test("anything")).toBe(false);
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeRegExp("plugin-id_1")).toBe("plugin-id_1");
  });
});
