/**
 * PluginShowcase (Z onboarding chain step 6) — installed-plugin tour.
 *
 * Mounted right after `SpotlightTour` completes (`tourCompleted=true`).
 * Surfaces a short carded explanation of every installed plugin so the
 * user understands what each plugin *does* before being dropped into
 * an empty chat surface. 2026-05-20 redesign — each card now has a
 * "펼쳐보기 ↓" toggle that *inline-expands* a short list of the plugin's
 * onboarding scenarios. The previous "둘러보기" button dispatched
 * `api.tour.start` (external navigation) and visibly retriggered the
 * SpotlightTour on top of the showcase — the new inline expansion path
 * removes that double-tour artefact.
 *
 * A separate "끝내기 →" footer button closes the entire showcase and
 * marks onboarding complete.
 *
 * Catalog model:
 *   - The component receives the installed-plugin id list as a prop and
 *     filters the static `PLUGIN_DESCRIPTIONS` table to the intersection.
 *     Plugins without an entry render a generic fallback card so the
 *     user is never shown an empty surface even on a non-standard install.
 *   - The static descriptions are intentionally short (1 sentence each)
 *     to fit the 460×840 narrow window without scroll-shenanigans.
 *
 * The component is presentational only — install/uninstall lifecycle is
 * not its concern; it just reflects the host's current pluginCards list.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { useTranslation } from "../../../i18n/react.js";

export interface PluginShowcaseApi {
  tour: {
    start: (scenarioId: string) => Promise<unknown> | unknown;
  };
}

export interface PluginShowcaseProps {
  open: boolean;
  /**
   * Installed plugin id list — typically `pluginCards.map(c => c.id)`
   * from App.tsx. Used to filter the static description catalog so the
   * showcase only mentions plugins the user actually has.
   */
  installedPluginIds: readonly string[];
  api: PluginShowcaseApi;
  /** Called when the user closes the showcase (끝내기 / skip / close). */
  onClose: () => void;
  /**
   * ScenarioShowcase carry (Option A) — when set, the matching plugin
   * is hoisted to the top of the showcase list so the user lands on
   * the same scenario they picked at the start of the chain. `null`
   * preserves the catalog order.
   *
   * Scenario id → plugin id map:
   *   meeting       → meeting
   *   docs          → local-indexer
   *   work          → work-assistant
   *   multi-agent   → agent-hub
   */
  prioritizedScenarioId?: string | null;
}

/**
 * ScenarioShowcase id → PluginShowcase plugin id. Pure for unit
 * testability. Unknown ids → null (caller treats as no-op).
 */
export function scenarioToPluginId(
  scenarioId: string | null | undefined,
): string | null {
  switch (scenarioId) {
    case "meeting":
      return "meeting";
    case "docs":
      return "local-indexer";
    case "work":
      return "work-assistant";
    case "multi-agent":
      return "agent-hub";
    default:
      return null;
  }
}

interface PluginDescription {
  /** Plugin id as it appears in pluginCards / manifests. */
  id: string;
  emoji: string;
  /** i18n key for the display name (short, ≤ 12 chars). */
  label: string;
  /** i18n key for the one-sentence description (~80 chars). */
  body: string;
  /** Spotlight tour id for the per-plugin walkthrough. */
  tourScenarioId: string;
  /**
   * Short list of i18n keys for onboarding scenarios the plugin can run.
   * Rendered inline inside the card when the user clicks the expand button.
   * Each key resolves to a 1-line phrase describing a concrete first task
   * the plugin supports — surfaces the plugin's value without an external
   * navigation.
   */
  scenarios: readonly string[];
}

/**
 * Static catalog — keyed by the canonical plugin id (NOT the marketplace
 * slug; the runtime PluginCard.id uses the bare manifest id).
 * Order is the intended introduction order: meeting → docs → work →
 * multi-agent → others. New plugins land at the bottom until a designer
 * decides where to slot them.
 */
const PLUGIN_DESCRIPTIONS: readonly PluginDescription[] = [
  {
    id: "meeting",
    emoji: "🎙️",
    label: "pluginShowcase.meetingLabel",
    body: "pluginShowcase.meetingBody",
    tourScenarioId: "meeting-walkthrough",
    scenarios: [
      "pluginShowcase.meetingScenario1",
      "pluginShowcase.meetingScenario2",
      "pluginShowcase.meetingScenario3",
      "pluginShowcase.meetingScenario4",
    ],
  },
  {
    id: "local-indexer",
    emoji: "📚",
    label: "pluginShowcase.localIndexerLabel",
    body: "pluginShowcase.localIndexerBody",
    tourScenarioId: "indexer-walkthrough",
    scenarios: [
      "pluginShowcase.localIndexerScenario1",
      "pluginShowcase.localIndexerScenario2",
      "pluginShowcase.localIndexerScenario3",
      "pluginShowcase.localIndexerScenario4",
    ],
  },
  {
    id: "work-assistant",
    emoji: "💼",
    label: "pluginShowcase.workAssistantLabel",
    body: "pluginShowcase.workAssistantBody",
    tourScenarioId: "work-assistant-walkthrough",
    scenarios: [
      "pluginShowcase.workAssistantScenario1",
      "pluginShowcase.workAssistantScenario2",
      "pluginShowcase.workAssistantScenario3",
      "pluginShowcase.workAssistantScenario4",
    ],
  },
  {
    id: "agent-hub",
    emoji: "🤖",
    label: "pluginShowcase.agentHubLabel",
    body: "pluginShowcase.agentHubBody",
    tourScenarioId: "multi-agent-tour",
    scenarios: [
      "pluginShowcase.agentHubScenario1",
      "pluginShowcase.agentHubScenario2",
      "pluginShowcase.agentHubScenario3",
      "pluginShowcase.agentHubScenario4",
    ],
  },
  {
    id: "ms-graph",
    emoji: "📅",
    label: "pluginShowcase.msGraphLabel",
    body: "pluginShowcase.msGraphBody",
    tourScenarioId: "first-boot-essentials",
    scenarios: [
      "pluginShowcase.msGraphScenario1",
      "pluginShowcase.msGraphScenario2",
      "pluginShowcase.msGraphScenario3",
    ],
  },
  {
    id: "internal-api",
    emoji: "🏢",
    label: "pluginShowcase.internalApiLabel",
    body: "pluginShowcase.internalApiBody",
    tourScenarioId: "first-boot-essentials",
    scenarios: [
      "pluginShowcase.internalApiScenario1",
      "pluginShowcase.internalApiScenario2",
      "pluginShowcase.internalApiScenario3",
    ],
  },
];

const PLUGIN_DESCRIPTION_BY_ID = new Map<string, PluginDescription>(
  PLUGIN_DESCRIPTIONS.map((entry) => [entry.id, entry] as const),
);

/**
 * Resolve the ordered list of cards to render. Installed plugins matching
 * the catalog come first (in catalog order); unknown installed plugins
 * append a generic fallback card so the user always sees something for
 * each installed plugin.
 *
 * When `prioritizedPluginId` is set the matching card is hoisted to the
 * top so a Showcase Option A user lands on the plugin they picked
 * earlier in the chain.
 *
 * Pure for unit-testability — caller passes the raw id list + optional
 * priority plugin id.
 */
export function resolveShowcaseCards(
  installedPluginIds: readonly string[],
  prioritizedPluginId: string | null = null,
): readonly PluginDescription[] {
  const installed = new Set(installedPluginIds);
  const known: PluginDescription[] = [];
  for (const entry of PLUGIN_DESCRIPTIONS) {
    if (installed.has(entry.id)) known.push(entry);
  }
  const unknown: PluginDescription[] = [];
  for (const id of installedPluginIds) {
    if (PLUGIN_DESCRIPTION_BY_ID.has(id)) continue;
    unknown.push({
      id,
      emoji: "🧩",
      label: id,
      body: "pluginShowcase.fallbackBody",
      tourScenarioId: "first-boot-essentials",
      scenarios: [
        "pluginShowcase.fallbackScenario1",
        "pluginShowcase.fallbackScenario2",
      ],
    });
  }
  const ordered = [...known, ...unknown];
  if (!prioritizedPluginId) return ordered;
  const idx = ordered.findIndex((card) => card.id === prioritizedPluginId);
  if (idx <= 0) return ordered;
  const head = ordered[idx];
  return [head, ...ordered.slice(0, idx), ...ordered.slice(idx + 1)];
}

function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduce(mq.matches);
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);
  return reduce;
}

export function PluginShowcase({
  open,
  installedPluginIds,
  api: _api,
  onClose,
  prioritizedScenarioId = null,
}: PluginShowcaseProps) {
  // `api` was previously used to fire `api.tour.start` from the
  // "둘러보기 →" button. 2026-05-20 redesign — that path is removed in
  // favour of inline scenario expansion (no external navigation), so
  // the prop is intentionally unused. Kept on the public interface so
  // existing call sites compile without changes.
  void _api;
  const { t } = useTranslation();
  const reduceMotion = usePrefersReducedMotion();
  const prioritizedPluginId = useMemo(
    () => scenarioToPluginId(prioritizedScenarioId),
    [prioritizedScenarioId],
  );
  const cards = useMemo(
    () => resolveShowcaseCards(installedPluginIds, prioritizedPluginId),
    [installedPluginIds, prioritizedPluginId],
  );

  // 2026-05-20: inline scenario expansion. Each card has a "펼쳐보기 ↓"
  // toggle; the expanded set lives in local state so toggling one card
  // doesn't affect the others. Closing the showcase resets the set.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!open) setExpandedIds(new Set());
  }, [open]);

  const handleToggleExpand = useCallback((cardId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) {
        next.delete(cardId);
      } else {
        next.add(cardId);
      }
      return next;
    });
  }, []);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) handleClose(); }}>
      <DialogContent
        size="sm"
        data-testid="plugin-showcase"
        data-reduce-motion={reduceMotion ? "true" : "false"}
        className="p-0 overflow-hidden"
      >
        <DialogHeader className="px-6 pt-6 pb-3 space-y-0">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="grid h-7 w-7 place-items-center rounded-md text-[11px] text-primary-foreground"
              style={{
                background:
                  "linear-gradient(135deg, hsl(var(--p-purple-500)), hsl(var(--p-blue-500)))",
              }}
            >
              ✦
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-sm font-medium">
                {t("pluginShowcase.dialogTitle")}
              </DialogTitle>
              <DialogDescription className="text-[11px]">
                {t("pluginShowcase.dialogDescription")}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="px-6 pb-6 space-y-3">
          {cards.length === 0 ? (
            <p
              data-testid="plugin-showcase:empty"
              className="rounded-lg bg-[hsl(var(--muted))] px-3 py-3 text-[12.5px] leading-relaxed text-muted-foreground"
            >
              {t("pluginShowcase.emptyState")}
            </p>
          ) : (
            <div
              data-testid="plugin-showcase:list"
              className="space-y-2 max-h-[420px] overflow-y-auto pr-1"
            >
              {cards.map((card) => {
                const expanded = expandedIds.has(card.id);
                return (
                  <div
                    key={card.id}
                    data-testid={`plugin-showcase:card:${card.id}`}
                    data-expanded={expanded ? "true" : "false"}
                    className="rounded-lg border border-border/(--opacity-stronger) bg-[hsl(var(--muted))] px-3 py-3"
                  >
                    <div className="flex items-start gap-2">
                      <span className="text-base leading-none" aria-hidden="true">
                        {card.emoji}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[12.5px] font-medium">{t(card.label)}</div>
                        <div className="mt-1 text-[10.5px] leading-snug text-muted-foreground">
                          {t(card.body)}
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            className="h-6 px-2 text-[10.5px]"
                            data-testid={`plugin-showcase:card:${card.id}:expand`}
                            aria-expanded={expanded}
                            onClick={() => handleToggleExpand(card.id)}
                          >
                            {expanded ? t("pluginShowcase.collapseButton") : t("pluginShowcase.expandButton")}
                          </Button>
                        </div>
                        {expanded && (
                          <ul
                            data-testid={`plugin-showcase:card:${card.id}:scenarios`}
                            className="mt-2 space-y-1 rounded-md bg-background/(--opacity-medium) px-2 py-2 text-[10.5px] leading-snug text-muted-foreground"
                          >
                            {card.scenarios.map((scenario) => (
                              <li
                                key={scenario}
                                className="flex items-start gap-1.5"
                              >
                                <span
                                  aria-hidden="true"
                                  style={{ color: "hsl(var(--p-purple-500))" }}
                                >
                                  •
                                </span>
                                <span>{t(scenario)}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <Button
            type="button"
            data-testid="plugin-showcase:close"
            onClick={handleClose}
            className="w-full text-primary-foreground"
            style={{
              background:
                "linear-gradient(135deg, hsl(var(--p-purple-500)), hsl(var(--p-blue-500)))",
            }}
          >
            {t("pluginShowcase.closeButton")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
