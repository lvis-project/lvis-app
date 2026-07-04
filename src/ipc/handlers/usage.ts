/**
 * usage.ts (handlers) — transport-agnostic PUBLIC usage handler logic (#1409 C10).
 *
 * Pure `handle*` functions behind the PUBLIC usage channels (`usage summary`,
 * `usage range`). They import NOTHING from the electron transport; the
 * `ipcMain.handle` wrapper + sender guard (on `usage range`) stay in
 * `domains/usage.ts`. The engine `usage-stats` module is lazily imported here
 * exactly as before to keep it out of the boot-time graph.
 */
import { redactForLLM } from "../../audit/dlp-filter.js";

/** PUBLIC `lvis:usage:summary` — rolling usage summary over `days` (default 60). */
export async function handleUsageSummary(days?: number) {
  const { getUsageSummary } = await import("../../engine/usage-stats.js");
  return getUsageSummary(typeof days === "number" ? days : 60);
}

/** PUBLIC `lvis:usage:range` — usage aggregated over an explicit date range. */
export async function handleUsageRange(opts: { dateFrom: string; dateTo: string }) {
  const { getUsageRange } = await import("../../engine/usage-stats.js");
  return getUsageRange(opts);
}

export interface UsageDailySummaryItem {
  title?: string;
  preview?: string;
  text?: string;
  role?: string;
  projectName?: string;
}

export interface UsageDailySummaryInput {
  date: string;
  locale?: string;
  sessions?: UsageDailySummaryItem[];
  starred?: UsageDailySummaryItem[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cost?: number;
  } | null;
}

export type UsageDailySummaryResult =
  | { ok: true; summary: string; generatedAt: string }
  | { ok: false; error: string };

const MAX_SUMMARY_ITEMS = 12;
const MAX_FIELD_CHARS = 240;
const MAX_SUMMARY_CHARS = 900;

function cleanText(value: unknown, max = MAX_FIELD_CHARS): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  const redacted = redactForLLM(trimmed, "insights-daily-summary").redacted.trim();
  return redacted ? redacted.slice(0, max) : undefined;
}

function cleanItems(items: unknown): UsageDailySummaryItem[] {
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_SUMMARY_ITEMS).map((item) => {
    const raw = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const title = cleanText(raw.title);
    const preview = cleanText(raw.preview);
    const text = cleanText(raw.text);
    const role = cleanText(raw.role, 48);
    const projectName = cleanText(raw.projectName, 80);
    return {
      ...(title ? { title } : {}),
      ...(preview ? { preview } : {}),
      ...(text ? { text } : {}),
      ...(role ? { role } : {}),
      ...(projectName ? { projectName } : {}),
    };
  }).filter((item) => item.title || item.preview || item.text);
}

function cleanNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizeDailySummaryInput(input: unknown): UsageDailySummaryInput {
  if (!input || typeof input !== "object") return { date: "unknown" };
  const raw = input as Record<string, unknown>;
  return {
    date: typeof raw.date === "string" ? raw.date : "unknown",
    ...(typeof raw.locale === "string" ? { locale: raw.locale } : {}),
    ...(Array.isArray(raw.sessions) ? { sessions: raw.sessions as UsageDailySummaryItem[] } : {}),
    ...(Array.isArray(raw.starred) ? { starred: raw.starred as UsageDailySummaryItem[] } : {}),
    ...(raw.usage && typeof raw.usage === "object" ? { usage: raw.usage as UsageDailySummaryInput["usage"] } : {}),
  };
}

function buildDailySummaryPrompt(input: unknown): string {
  const normalized = normalizeDailySummaryInput(input);
  const sessions = cleanItems(normalized.sessions);
  const starred = cleanItems(normalized.starred);
  const usage = normalized.usage && typeof normalized.usage === "object" ? normalized.usage : {};
  const payload = {
    date: /^\d{4}-\d{2}-\d{2}$/.test(normalized.date) ? normalized.date : "unknown",
    locale: cleanText(normalized.locale, 32) ?? "ko-KR",
    sessions,
    starred,
    usage: {
      inputTokens: cleanNumber(usage.inputTokens),
      outputTokens: cleanNumber(usage.outputTokens),
      totalTokens: cleanNumber(usage.totalTokens),
      cost: cleanNumber(usage.cost),
    },
  };
  return [
    "Summarize this LVIS daily work insight payload for the user.",
    "Rules: respond in the requested locale, write 1-2 concise sentences, no markdown, no bullet list, no invented facts.",
    "Mention the day's work signal, starred items, and token usage when present.",
    JSON.stringify(payload),
  ].join("\n");
}

export async function handleUsageDailySummary(
  conversationLoop: { generateText: (prompt: string, systemPrompt?: string, abortSignal?: AbortSignal) => Promise<string> },
  input: unknown,
): Promise<UsageDailySummaryResult> {
  try {
    const prompt = buildDailySummaryPrompt(input);
    const summary = (await conversationLoop.generateText(
      prompt,
      "You are LVIS Insights. Produce a concise, factual daily work summary from structured app telemetry only.",
    )).replace(/\s+/g, " ").trim().slice(0, MAX_SUMMARY_CHARS);
    if (!summary) return { ok: false, error: "empty-summary" };
    return { ok: true, summary, generatedAt: new Date().toISOString() };
  } catch (error) {
    const message = error instanceof Error ? error.message : "summary-failed";
    return { ok: false, error: message };
  }
}
