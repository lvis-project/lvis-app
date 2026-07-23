import type { PluginFirstTaskCopy } from "../../../plugins/types.js";
import type { PluginCardSummary } from "../types.js";

const DEFAULT_PRIORITY = 100;

export interface FirstTaskProposal extends PluginFirstTaskCopy {
  pluginId: string;
  priority: number;
}

function normalizeLocaleTag(locale: string): string {
  return locale.trim().toLowerCase().replaceAll("_", "-");
}

function resolveCopy(
  locales: Record<string, PluginFirstTaskCopy>,
  locale: string,
): PluginFirstTaskCopy {
  const normalized = normalizeLocaleTag(locale);
  const primary = normalized.split("-")[0];
  return locales[normalized] ?? locales[primary] ?? locales.en;
}

/**
 * Select declarative first-run guidance from plugins that are actually usable.
 * The metadata can only prefill the visible composer; it carries no tool,
 * channel, arguments, or auto-submit behavior.
 */
export function pickFirstTaskProposal(
  pluginCards: readonly PluginCardSummary[],
  locale: string,
): FirstTaskProposal | null {
  const candidates = pluginCards
    .filter((card) =>
      card.loadStatus === "loaded"
      && card.active === true
      && card.onboarding?.firstTask !== undefined)
    .sort((left, right) => {
      const leftPriority = left.onboarding?.firstTask?.priority ?? DEFAULT_PRIORITY;
      const rightPriority = right.onboarding?.firstTask?.priority ?? DEFAULT_PRIORITY;
      return leftPriority - rightPriority || left.id.localeCompare(right.id);
    });

  const card = candidates[0];
  const firstTask = card?.onboarding?.firstTask;
  if (!card || !firstTask) return null;

  return {
    pluginId: card.id,
    priority: firstTask.priority ?? DEFAULT_PRIORITY,
    ...resolveCopy(firstTask.locales, locale),
  };
}
