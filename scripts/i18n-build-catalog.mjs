#!/usr/bin/env node
/**
 * i18n catalog assembler — the writing half.
 *
 * Regenerates the barrels from the per-surface translation fragments
 * (`src/i18n/messages/generated/<namespace>.ts`, each exporting `en` and `ko`
 * objects):
 *   - `generated/index.ts` with the English default catalog only
 *   - `generated-locales/ko.ts` with the Korean language-pack catalog
 *
 * The contents come from `i18n-catalog-artifacts.mjs`; this file only decides
 * where they land. Idempotent and deterministic (fragments sorted by name), so
 * re-running after more fragments land just extends the barrel. Run after
 * adding a fragment:
 *   node scripts/i18n-build-catalog.mjs
 *
 * `check-i18n-catalog-barrels.mjs` fails the build when the committed barrels
 * disagree with what this writes.
 */
import { writeFileSync } from "node:fs";
import { buildI18nCatalogArtifacts } from "./i18n-catalog-artifacts.mjs";

const { fragments, artifacts } = buildI18nCatalogArtifacts();
for (const { path, content } of artifacts) {
  writeFileSync(path, content, "utf-8");
}
console.log(`[i18n] assembled ${fragments.length} fragment(s) into generated/index.ts + generated-locales/ko.ts`);
