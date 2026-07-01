/**
 * Build-time i18n catalog validation.
 *
 * Lazy generated locale chunks must still be complete before a build ships.
 * This script eagerly loads every supported catalog and fails on key drift,
 * placeholder/tag/slash-command drift, or generated sentinel leakage.
 */
import { SUPPORTED_LOCALES } from "../src/i18n/locale.js";
import { loadAllLocaleMessages } from "../src/i18n/messages/index.js";

const PLACEHOLDER_RE = /\{[A-Za-z0-9_.-]+\}/g;
const TAG_RE = /<\/?[A-Za-z][A-Za-z0-9_-]*(?:\s+[^<>]*)?>/g;
const SLASH_COMMAND_RE = /\/(?:new|sessions|load|compact|remember|memory|vendor|tools|permission|help|clear|command)\b/g;
const SENTINEL_LEAK_RE = /LVISKEEP\s*\d+/i;

function sortedMatches(value: string, pattern: RegExp): string[] {
  return value.match(pattern)?.sort() ?? [];
}

const catalogs = await loadAllLocaleMessages();
const englishKeys = Object.keys(catalogs.en).sort();
const failures: string[] = [];

for (const locale of SUPPORTED_LOCALES) {
  const keys = Object.keys(catalogs[locale]).sort();
  if (JSON.stringify(keys) !== JSON.stringify(englishKeys)) {
    failures.push(`${locale}: key set does not match English catalog`);
    continue;
  }

  for (const [key, english] of Object.entries(catalogs.en)) {
    const value = catalogs[locale][key] ?? "";
    if (JSON.stringify(sortedMatches(value, PLACEHOLDER_RE)) !== JSON.stringify(sortedMatches(english, PLACEHOLDER_RE))) {
      failures.push(`${locale}:${key}: placeholder drift`);
    }
    if (JSON.stringify(sortedMatches(value, TAG_RE)) !== JSON.stringify(sortedMatches(english, TAG_RE))) {
      failures.push(`${locale}:${key}: tag drift`);
    }
    if (JSON.stringify(sortedMatches(value, SLASH_COMMAND_RE)) !== JSON.stringify(sortedMatches(english, SLASH_COMMAND_RE))) {
      failures.push(`${locale}:${key}: slash-command drift`);
    }
    if (SENTINEL_LEAK_RE.test(value)) {
      failures.push(`${locale}:${key}: generated sentinel leaked`);
    }
  }
}

if (failures.length > 0) {
  console.error(`[i18n] catalog validation failed (${failures.length})`);
  for (const failure of failures.slice(0, 50)) {
    console.error(`- ${failure}`);
  }
  if (failures.length > 50) {
    console.error(`... ${failures.length - 50} more`);
  }
  process.exit(1);
}

console.log(`[i18n] catalog validation OK locales=${SUPPORTED_LOCALES.length} keys=${englishKeys.length}`);
