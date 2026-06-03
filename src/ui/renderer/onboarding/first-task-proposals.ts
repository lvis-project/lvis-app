/**
 * Tutorial-X5 — Post-tour First Task Proposal catalog.
 *
 * After the SpotlightTour finishes, we want to bridge the user from
 * "I just saw a tutorial" → "I just achieved my first real value with
 * LVIS" without a dead-end transition. This module is the catalog of
 * first-task proposals keyed by *installed plugin id* — the
 * PostTourFirstTask component looks up the user's installed plugins
 * and surfaces the highest-priority proposal whose plugin is present.
 *
 * Each proposal has:
 *   - `pluginId` (matches the marketplace slug)
 *   - `priority` (lower number wins — the order of "real first value")
 *   - `headlineKo` (the offer card title)
 *   - `bodyKo` (1–2 sentence description)
 *   - `ctaKo` (button label)
 *   - `composerSeed` (the message text that auto-fills the composer when
 *     the user accepts — this is what triggers the *real* plugin tool
 *     via the natural conversation path, no hidden IPC)
 *
 * Design rationale:
 *   - Pre-seeding the composer (instead of dispatching a hidden tool
 *     call) keeps the user in control and matches LVIS's tool-approval
 *     contract. The user sees the prompt that will run.
 *   - The catalog is plugin-keyed so Memory Seed chip clicks and direct
 *     marketplace installs converge on the same proposal.
 */

import { t } from "../../../i18n/runtime.js";

export interface FirstTaskProposal {
  pluginId: string;
  priority: number;
  headlineKo: string;
  bodyKo: string;
  ctaKo: string;
  /**
   * Composer pre-fill text. The PostTourFirstTask card dispatches this
   * via `api.chatSubmit?.(composerSeed)` (or a composer-set IPC) so the
   * user is *one click* away from a real plugin invocation — every step
   * after is the canonical chat-tool-approval loop, not a tutorial fork.
   */
  composerSeed: string;
}

/**
 * Build the first-task proposal catalog with the current active locale.
 * Called at runtime so t() resolves against the active locale at the
 * time of the call rather than at module-init time.
 */
function getFirstTaskProposals(): readonly FirstTaskProposal[] {
  return [
    {
      pluginId: "lvis-plugin-meeting",
      priority: 10,
      headlineKo: t("firstTaskProposals.meetingHeadline"),
      bodyKo: t("firstTaskProposals.meetingBody"),
      ctaKo: t("firstTaskProposals.meetingCta"),
      composerSeed: t("firstTaskProposals.meetingComposerSeed"),
    },
    {
      pluginId: "lvis-plugin-local-indexer",
      priority: 20,
      headlineKo: t("firstTaskProposals.indexerHeadline"),
      bodyKo: t("firstTaskProposals.indexerBody"),
      ctaKo: t("firstTaskProposals.indexerCta"),
      composerSeed: t("firstTaskProposals.indexerComposerSeed"),
    },
    {
      // The marketplace package slug is `lvis-plugin-work-assistant`
      // (the published repo name); the user-facing brand is 업무 도우미.
      // The pluginId field here matches the marketplace slug so the
      // installed-plugin map lookup succeeds.
      pluginId: "lvis-plugin-work-assistant",
      priority: 30,
      headlineKo: t("firstTaskProposals.workAssistantHeadline"),
      bodyKo: t("firstTaskProposals.workAssistantBody"),
      ctaKo: t("firstTaskProposals.workAssistantCta"),
      composerSeed: t("firstTaskProposals.workAssistantComposerSeed"),
    },
    {
      pluginId: "lvis-plugin-agent-hub",
      priority: 40,
      headlineKo: t("firstTaskProposals.agentHubHeadline"),
      bodyKo: t("firstTaskProposals.agentHubBody"),
      ctaKo: t("firstTaskProposals.agentHubCta"),
      composerSeed: t("firstTaskProposals.agentHubComposerSeed"),
    },
  ];
}

/**
 * Pick the highest-priority proposal whose plugin is installed. Returns
 * `null` when no installed plugin has a registered proposal — the
 * PostTourFirstTask card then doesn't render and the user lands on the
 * normal chat surface (already a valid end state).
 */
export function pickFirstTaskProposal(
  installedPluginIds: readonly string[],
): FirstTaskProposal | null {
  const installedSet = new Set(installedPluginIds);
  const candidates = getFirstTaskProposals().filter((p) =>
    installedSet.has(p.pluginId),
  );
  if (candidates.length === 0) return null;
  // Sort by priority ascending — lowest number is the user's first
  // recommended action.
  candidates.sort((a, b) => a.priority - b.priority);
  return candidates[0];
}
