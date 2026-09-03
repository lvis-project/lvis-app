/**
 * Every key a caller asks for must exist in the catalog.
 *
 * The catalog check next door validates locale PARITY — that every supported
 * locale carries the same key set. It says nothing about whether a key a caller passes
 * to `t()` is in that set, so a typo or an invented key passes every gate and
 * ships: `t()` falls back to echoing the key, and the UI renders the literal
 * string "sidebar.newChat" where a label belongs. That is a user-visible defect
 * that only looking at the running app catches, which is exactly the kind of
 * check that should not depend on someone looking.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { messages } from "../messages/index.js";

const SRC = resolve(import.meta.dirname, "../..");
// `src/i18n` is the translator itself, not a caller: the only keys it names are
// the `t("some.key")` examples in its own docs, and treating those as usage
// would make this gate fail on documentation.
const SKIP_DIRS = new Set(["node_modules", "__tests__", "__mocks__", "i18n"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) sourceFiles(path, out);
    } else if (/\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

// Only LITERAL keys are checkable. A computed key (`t(someVariable)`) cannot be
// resolved statically, and the pattern below simply does not match it — this
// gate covers what it can prove and stays silent about the rest rather than
// guessing.
const LITERAL_KEY = /\bt\(\s*"([a-zA-Z][\w]*(?:\.[\w-]+)+)"/g;

describe("i18n keys used in source", () => {
  it("all resolve to a real catalog entry", () => {
    // English is the fallback catalog and is loaded eagerly; Korean, the only
    // other supported locale, is lazy, and the parity check next door already
    // proves it matches.
    const catalog = messages.en as Record<string, string>;
    const missing = new Map<string, string[]>();

    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf-8");
      for (const match of text.matchAll(LITERAL_KEY)) {
        const key = match[1]!;
        if (Object.hasOwn(catalog, key)) continue;
        const where = missing.get(key) ?? [];
        where.push(file.slice(SRC.length + 1));
        missing.set(key, where);
      }
    }

    expect(
      Array.from(missing, ([key, files]) => `${key} — ${files.join(", ")}`),
    ).toEqual([]);
  });
});
