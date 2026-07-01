/**
 * Dump the assembled i18n catalog to JSON for tooling/verification.
 *
 * Emits `.omc/i18n/maps.json` with:
 *   - enByKey:  key → English text
 *   - koByKey:  key → Korean text
 *   - koToEn:   Korean text → English text (exact-string lookup)
 *
 * Run after `scripts/i18n-build-catalog.mjs`:  bunx tsx scripts/i18n-dump-maps.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadAllLocaleMessages } from "../src/i18n/messages/index.js";

const messages = await loadAllLocaleMessages();
const en = messages.en;
const ko = messages.ko;

const koToEn: Record<string, string> = {};
for (const key of Object.keys(en)) {
  const e = en[key];
  const k = ko[key];
  if (k && e && !(k in koToEn)) koToEn[k] = e;
}

mkdirSync(".omc/i18n", { recursive: true });
writeFileSync(
  ".omc/i18n/maps.json",
  JSON.stringify({ enByKey: en, koByKey: ko, koToEn }, null, 0),
  "utf-8",
);
console.log(
  `[i18n] keys=${Object.keys(en).length} koToEn=${Object.keys(koToEn).length} -> .omc/i18n/maps.json`,
);
