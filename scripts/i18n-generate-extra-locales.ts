import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { en as seedEn } from "../src/i18n/messages/en.js";
import { generatedEn } from "../src/i18n/messages/generated/index.js";

type LocaleSpec = {
  code: string;
  googleCode: string;
  exportName: string;
};

const LOCALES: LocaleSpec[] = [
  { code: "ja", googleCode: "ja", exportName: "jaMessages" },
  { code: "zh", googleCode: "zh-CN", exportName: "zhMessages" },
  { code: "es", googleCode: "es", exportName: "esMessages" },
  { code: "fr", googleCode: "fr", exportName: "frMessages" },
  { code: "de", googleCode: "de", exportName: "deMessages" },
];

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "..", "src", "i18n", "messages", "generated-locales");
const sourceMessages = { ...seedEn, ...generatedEn } as Record<string, string>;
const entries = Object.entries(sourceMessages).sort(([a], [b]) => a.localeCompare(b));
const concurrency = Number(process.env.LVIS_I18N_TRANSLATE_CONCURRENCY ?? "24");
const requestedLocales = new Set(
  (process.env.LVIS_I18N_TRANSLATE_LOCALES ?? "")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean),
);

const MANUAL_OVERRIDES: Record<string, Record<string, string>> = {
  zh: {
    "be_conversationLoop.cmdHelp": "LVIS 命令：\n/new — 开始新对话\n/sessions — 已保存会话列表\n/load <ID> — 恢复会话\n/compact — 压缩对话历史\n/remember <content> — 保存记忆\n/memory — 用户记忆列表\n/vendor — 当前供应商/令牌信息\n/tools — 已注册工具列表\n/permission — 当前权限模式\n/permission mode <strict|default|auto|allow> --durable — 更改权限模式\n/permission dir <list|allow|deny> [path] — 管理允许目录\n/permission reviewer <show|mode|fallback|interactive> [value] — 审核器设置\n/permission audit <show|verify> — 权限审计查询/验证\n/permission hooks <list|accept|disable|reject> [name] — 脚本钩子信任管理\n/help — 此帮助",
  },
  es: {
    "auditPanel.integrityChainBroken": "Cadena de auditoría rota: {file}{lineHint}",
    "be_conversationLoop.permissionDirError": "Error de permiso de directorio: {error}{warnings}{ack}",
    "be_conversationLoop.permissionModeChanged": "Modo de permisos cambiado: {previous} -> {mode}{durability}",
    "memorySearchPanel.minutesAgo": "hace {minutes} minutos",
    "memorySearchPanel.hoursAgo": "hace {hours} horas",
    "overlayCard.minutesAgo": "hace {count} min",
    "overlayCard.hoursAgo": "hace {count} h",
    "overlayCard.daysAgo": "hace {count} d",
  },
  fr: {
    "auditPanel.integrityChainBroken": "Chaine d'audit rompue : {file}{lineHint}",
    "be_conversationLoop.permissionDirError": "Erreur de permission de repertoire : {error}{warnings}{ack}",
    "be_conversationLoop.permissionModeChanged": "Mode d'autorisation modifie : {previous} -> {mode}{durability}",
    "memorySearchPanel.minutesAgo": "il y a {minutes} min",
    "memorySearchPanel.hoursAgo": "il y a {hours} h",
    "overlayCard.minutesAgo": "il y a {count} min",
    "overlayCard.hoursAgo": "il y a {count} h",
    "overlayCard.daysAgo": "il y a {count} j",
  },
  de: {
    "auditPanel.integrityChainBroken": "Audit-Kette unterbrochen: {file}{lineHint}",
    "be_conversationLoop.permissionDirError": "Verzeichnisberechtigungsfehler: {error}{warnings}{ack}",
    "be_conversationLoop.permissionModeChanged": "Berechtigungsmodus geandert: {previous} -> {mode}{durability}",
    "memorySearchPanel.minutesAgo": "vor {minutes} Minuten",
    "memorySearchPanel.hoursAgo": "vor {hours} Stunden",
    "overlayCard.minutesAgo": "vor {count} Min.",
    "overlayCard.hoursAgo": "vor {count} Std.",
    "overlayCard.daysAgo": "vor {count} Tg.",
  },
};

const PLACEHOLDER_RE = /\{[A-Za-z0-9_.-]+\}/g;
const TAG_RE = /<\/?[A-Za-z][A-Za-z0-9_-]*(?:\s+[^<>]*)?>/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const FENCED_CODE_RE = /```[\s\S]*?```/g;
const URL_RE = /https?:\/\/[^\s"'<>]+/g;
const SLASH_COMMAND_RE = /(?<![A-Za-z0-9])\/[A-Za-z][A-Za-z0-9_-]*/g;
const ENV_RE = /\$[A-Za-z_][A-Za-z0-9_]*/g;
const WINDOWS_PATH_RE = /[A-Za-z]:\\[^\s"'<>]+/g;
const TOKEN_RE = /__LVISKEEP(\d+)__/g;
const DAMAGED_TOKEN_RE = /_*\s*LVISKEEP\s*(\d+)\s*_*/gi;
const SENTINEL_LEAK_RE = /LVISKEEP\s*\d+/i;

function protect(text: string): { text: string; values: string[] } {
  const values: string[] = [];
  let protectedText = text;
  const patterns = [
    FENCED_CODE_RE,
    INLINE_CODE_RE,
    URL_RE,
    SLASH_COMMAND_RE,
    WINDOWS_PATH_RE,
    PLACEHOLDER_RE,
    TAG_RE,
    ENV_RE,
  ];
  for (const pattern of patterns) {
    protectedText = protectedText.replace(pattern, (match) => {
      const token = `__LVISKEEP${values.length}__`;
      values.push(match);
      return token;
    });
  }
  return { text: protectedText, values };
}

function restore(text: string, values: string[]): string {
  return text
    .replace(DAMAGED_TOKEN_RE, (_match, index) => `__LVISKEEP${index}__`)
    .replace(TOKEN_RE, (_match, index) => values[Number(index)] ?? _match);
}

function normalizeTranslated(text: string): string {
  return text
    .replace(/\s+([,.!?;:%)\]\}])/g, "$1")
    .replace(/([(\[\{])\s+/g, "$1")
    .replace(/\u00a0/g, " ")
    .trim();
}

async function translateText(text: string, target: string): Promise<string> {
  if (text.trim().length === 0) return text;
  const protectedText = protect(text);
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", "en");
  url.searchParams.set("tl", target);
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", protectedText.text);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url);
    } catch (err) {
      if (attempt < 4) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * (attempt + 1)));
        continue;
      }
      throw err;
    }
    if (response.ok) {
      const json = await response.json() as unknown;
      const translated = Array.isArray(json)
        ? (json[0] as unknown[])
            .map((part) => Array.isArray(part) ? String(part[0] ?? "") : "")
            .join("")
        : "";
      return normalizeTranslated(restore(translated, protectedText.values));
    }
    if (response.status === 429 || response.status >= 500) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * (attempt + 1)));
      continue;
    }
    throw new Error(`translate failed ${response.status}: ${await response.text()}`);
  }
  throw new Error(`translate failed after retries for target=${target}`);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function placeholders(value: string): string[] {
  return value.match(PLACEHOLDER_RE)?.sort() ?? [];
}

function repairPlaceholderNames(source: string, target: string): string {
  const sourcePlaceholders = source.match(PLACEHOLDER_RE) ?? [];
  const targetPlaceholders = target.match(PLACEHOLDER_RE) ?? [];
  if (sourcePlaceholders.length === 0 || sourcePlaceholders.join("\u0000") === targetPlaceholders.join("\u0000")) {
    return target;
  }
  if (sourcePlaceholders.length === targetPlaceholders.length) {
    let repaired = target;
    for (let i = 0; i < targetPlaceholders.length; i += 1) {
      repaired = repaired.replace(targetPlaceholders[i]!, sourcePlaceholders[i]!);
    }
    return repaired;
  }
  return target;
}

function xmlTags(value: string): string[] {
  return value.match(TAG_RE)?.sort() ?? [];
}

function validate(locale: string, translated: Record<string, string>): void {
  const missing = entries.map(([key]) => key).filter((key) => !(key in translated));
  if (missing.length > 0) {
    throw new Error(`${locale}: missing ${missing.length} key(s): ${missing.slice(0, 5).join(", ")}`);
  }
  const placeholderMismatches: string[] = [];
  const tagMismatches: string[] = [];
  const sentinelLeaks: string[] = [];
  for (const [key, source] of entries) {
    const target = translated[key] ?? "";
    if (SENTINEL_LEAK_RE.test(target)) {
      sentinelLeaks.push(key);
    }
    if (JSON.stringify(placeholders(source)) !== JSON.stringify(placeholders(target))) {
      placeholderMismatches.push(key);
    }
    if (JSON.stringify(xmlTags(source)) !== JSON.stringify(xmlTags(target))) {
      tagMismatches.push(key);
    }
  }
  if (placeholderMismatches.length > 0) {
    throw new Error(`${locale}: placeholder mismatch in ${placeholderMismatches.slice(0, 10).join(", ")}`);
  }
  if (tagMismatches.length > 0) {
    throw new Error(`${locale}: tag mismatch in ${tagMismatches.slice(0, 10).join(", ")}`);
  }
  if (sentinelLeaks.length > 0) {
    throw new Error(`${locale}: leaked protected token in ${sentinelLeaks.slice(0, 10).join(", ")}`);
  }
}

async function generateLocale(spec: LocaleSpec): Promise<void> {
  console.log(`[i18n] ${spec.code}: translating ${entries.length} key(s) with concurrency=${concurrency}`);
  let completed = 0;
  const translatedEntries = await mapWithConcurrency(entries, concurrency, async ([key, source]) => {
    const override = MANUAL_OVERRIDES[spec.code]?.[key];
    const value = override ?? repairPlaceholderNames(source, await translateText(source, spec.googleCode));
    completed += 1;
    if (completed % 100 === 0 || completed === entries.length) {
      console.log(`[i18n] ${spec.code}: ${completed}/${entries.length}`);
    }
    return [key, value] as const;
  });
  const translated = Object.fromEntries(translatedEntries);
  validate(spec.code, translated);
  const lines = [
    "/** AUTO-GENERATED by scripts/i18n-generate-extra-locales.ts. */",
    `export const ${spec.exportName}: Record<string, string> = {`,
    ...entries.map(([key]) => `  ${quote(key)}: ${quote(translated[key]!)},`),
    "};",
    "",
  ];
  await writeFile(resolve(OUT_DIR, `${spec.code}.ts`), lines.join("\n"), "utf-8");
  console.log(`[i18n] wrote ${spec.code}`);
}

await mkdir(OUT_DIR, { recursive: true });
for (const spec of LOCALES.filter((item) => requestedLocales.size === 0 || requestedLocales.has(item.code))) {
  await generateLocale(spec);
}
