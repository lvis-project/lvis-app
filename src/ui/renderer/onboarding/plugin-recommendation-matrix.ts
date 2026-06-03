/**
 * Memory Seed Onboarding (O-X2) — static keyword → plugin matrix.
 *
 * The MemorySeedDialog renders a "✨ 분석 결과" recommendation chip strip
 * driven by the user's one-line self-introduction. v1 is intentionally
 * static (zero LLM calls, zero IPC): a deterministic keyword sweep keeps
 * the first-boot path fast, offline-safe, and unit-testable.
 *
 * Matrix maintenance notes:
 *   - Korean stems are preferred (실제 입력 패턴) but a few English keywords
 *     are kept for bilingual users.
 *   - Each plugin entry is matched at most once — duplicate hits collapse.
 *   - When no keyword matches we surface `chat-basics` so the chip strip is
 *     never empty (UX requirement: 추천 카드가 비어있으면 분석 결과 카드
 *     자체의 의미가 사라짐).
 */

import { t } from "../../../i18n/runtime.js";

export interface PluginRecommendation {
  /** Stable identifier — matches plugin id where applicable, or `chat-basics` for the fallback. */
  pluginId: string;
  /** Korean label shown in the chip body (emoji는 별도 필드). */
  label: string;
  /** Leading emoji in the chip. */
  emoji: string;
  /**
   * Marketplace package slug for `lvis:plugins:install`. `null` for the
   * `chat-basics` fallback (a meta recommendation that has no installable
   * plugin). When set, clicking the chip in the MemorySeedDialog triggers
   * the canonical plugin-install pipeline.
   */
  marketplaceSlug: string | null;
}

interface MatrixRow {
  pluginId: string;
  /** Plain label string for entries with an English label, or omit in favour of labelKey. */
  label: string;
  /** i18n key to resolve at call time (used when the label requires translation). */
  labelKey?: string;
  emoji: string;
  keywords: string[];
  marketplaceSlug: string | null;
}

/**
 * Order matters — earlier rows win priority when an intro hits multiple
 * categories so the chip strip stays narrative-aligned (회의 → 문서 →
 * 업무 → 에이전트).
 */
const MATRIX: MatrixRow[] = [
  {
    pluginId: "meeting",
    label: "meeting",
    emoji: "🎙️",
    keywords: ["회의", "미팅", "녹음", "회의록", "stt", "meeting"],
    marketplaceSlug: "lvis-plugin-meeting",
  },
  {
    pluginId: "local-indexer",
    label: "local-indexer",
    emoji: "🔍",
    keywords: ["문서", "검색", "pdf", "파일", "인덱스", "indexer", "document"],
    marketplaceSlug: "lvis-plugin-local-indexer",
  },
  {
    // Manifest id is `work-assistant` (per plugin manifest); the canonical
    // marketplace slug is `lvis-plugin-work-assistant`. Display label is
    // the user-facing 업무 도우미 brand.
    pluginId: "work-assistant",
    label: "work assistant",
    labelKey: "pluginRecommendationMatrix.workAssistantLabel",
    emoji: "💼",
    keywords: ["업무", "할일", "todo", "task", "proactive", "assistant", "일정"],
    marketplaceSlug: "lvis-plugin-work-assistant",
  },
  {
    pluginId: "ms-graph",
    label: "calendar (MS Graph)",
    emoji: "📅",
    keywords: ["일정", "이메일", "메일", "캘린더", "calendar", "outlook", "email", "ms graph", "msgraph"],
    marketplaceSlug: "lvis-plugin-ms-graph",
  },
  {
    pluginId: "agent-hub",
    label: "agent-hub",
    emoji: "🤖",
    keywords: ["에이전트", "오케스트", "agent", "orchestr"],
    marketplaceSlug: "lvis-plugin-agent-hub",
  },
];

/** Returns the fallback chip at call time so the label resolves through the active locale. */
function getFallback(): PluginRecommendation {
  return {
    pluginId: "chat-basics",
    label: t("pluginRecommendationMatrix.chatBasicsLabel"),
    emoji: "💬",
    marketplaceSlug: null,
  };
}

/**
 * Infer recommended plugins from a free-form Korean (or mixed) self-intro.
 * Empty/whitespace input → single fallback chip so the gradient card never
 * shows an empty list.
 */
export function inferRecommendedPlugins(intro: string): PluginRecommendation[] {
  const normalized = intro.toLowerCase();
  if (normalized.trim().length === 0) return [getFallback()];

  const hits: PluginRecommendation[] = [];
  const seen = new Set<string>();
  for (const row of MATRIX) {
    if (row.keywords.some((kw) => normalized.includes(kw))) {
      if (seen.has(row.pluginId)) continue;
      seen.add(row.pluginId);
      hits.push({
        pluginId: row.pluginId,
        label: row.labelKey ? t(row.labelKey) : row.label,
        emoji: row.emoji,
        marketplaceSlug: row.marketplaceSlug,
      });
    }
  }

  return hits.length > 0 ? hits : [getFallback()];
}
