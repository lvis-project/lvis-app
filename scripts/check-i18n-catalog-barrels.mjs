#!/usr/bin/env node
/**
 * check-i18n-catalog-barrels.mjs
 *
 * The two i18n barrels (`generated/index.ts`, `generated-locales/ko.ts`) are
 * tracked generator output. They are only safe while the committed bytes equal
 * what `scripts/i18n-build-catalog.mjs` writes; once they diverge, the next
 * person to add a fragment regenerates them and carries an unrelated
 * re-ordering diff on their pull request, and the one after that carries it
 * back. That oscillation is what this guard stops.
 *
 * It was reachable before because nothing ever re-ran the assembler:
 * `check:i18n-catalog` validates the *key set* of every locale, which is blind
 * to fragment ORDER, and `check-generated-assets.mjs` only covers the paths the
 * icon generator records in its own manifest. A hand edit to a file headed
 * "AUTO-GENERATED — do not edit by hand" therefore survived review and sat in
 * `main`.
 *
 * The comparison runs against the assembler's real output rather than a
 * re-implementation of its rules — see `i18n-catalog-artifacts.mjs`, which both
 * this and the writer import.
 *
 * Run standalone with `node scripts/check-i18n-catalog-barrels.mjs`.
 */
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildI18nCatalogArtifacts, MESSAGES_DIR } from "./i18n-catalog-artifacts.mjs";

const LABEL = "[i18n-barrels]";

/**
 * Compare each barrel on disk against what the assembler would write.
 *
 * @param {string} [messagesDir] Root of the message catalogs.
 * @returns {{ fragmentCount: number, checked: number, divergent: { path: string, reason: "content" | "line-endings" | "unreadable", detail?: string }[] }}
 */
export function findDivergentBarrels(messagesDir = MESSAGES_DIR) {
  const { fragments, artifacts } = buildI18nCatalogArtifacts(messagesDir);
  const divergent = [];

  for (const { path, content } of artifacts) {
    let actual;
    try {
      actual = readFileSync(path, "utf-8");
    } catch (err) {
      // Fail closed: a missing barrel is a divergence, not an absence of one.
      divergent.push({ path, reason: "unreadable", detail: err.message });
      continue;
    }
    if (actual === content) continue;
    divergent.push({
      path,
      // Separate the one difference that is an environment problem rather than
      // a content problem, so it does not read as a mystery.
      reason: actual.replace(/\r\n/g, "\n") === content ? "line-endings" : "content",
    });
  }

  return { fragmentCount: fragments.length, checked: artifacts.length, divergent };
}

const REASON_TEXT = {
  content: "committed bytes differ from the assembler's output",
  "line-endings": "differs only in line endings; the working tree should be LF (see .gitattributes)",
  unreadable: "cannot be read",
};

// Same entry-point guard as `check-source-text-safe.mjs`: without the
// `process.argv[1]` check, importing this module from a process that has no
// script path throws inside `resolve()`.
const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  let result;
  try {
    result = findDivergentBarrels();
  } catch (err) {
    // An unreadable fragment directory is an unanswered question, not a pass.
    console.error(`${LABEL} FAIL — cannot assemble the catalog barrels: ${err.message}`);
    process.exit(1);
  }

  if (result.divergent.length > 0) {
    for (const { path, reason, detail } of result.divergent) {
      console.error(
        `${LABEL} ${relative(process.cwd(), path)} — ${REASON_TEXT[reason]}${detail ? ` (${detail})` : ""}`,
      );
    }
    console.error(
      `${LABEL} FAIL — ${result.divergent.length} barrel(s) diverge from \`node scripts/i18n-build-catalog.mjs\`.`,
    );
    console.error(
      `${LABEL} These barrels are generated. Do not edit them by hand — add or remove a`,
    );
    console.error(
      `${LABEL} fragment under src/i18n/messages/generated/ and re-run the assembler.`,
    );
    process.exit(1);
  }

  console.log(`${LABEL} OK — ${result.checked} barrel(s) match ${result.fragmentCount} fragment(s)`);
}
