




import { t } from "../../../i18n/runtime.js";




export type CompletionTrigger =
  | { kind: "keypress"; combo: "⌘+K" | "⌘+?" | "⌘+Enter" }
  | { kind: "input"; selector: string }
  | { kind: "click"; selector: string }
  | { kind: "manual" };

export interface TourStep {
  /**
   * Stable CSS selector pinned to a `data-tour-anchor="…"` attribute on
   * the target DOM node. Selectors that match >1 element use the first
   * hit; if no element matches, the component falls back to centring the
   * card in the viewport so the tour never gets stuck (mockup contract
   * "tour must not block the chat surface").
   */
  anchorSelector: string;
  /** Short heading, displayed above the body copy. */
  title: string;
  /** Plain-text explanation. Do NOT include HTML / kbd glyphs here. */
  body: string;
  /**
   * Optional keyboard-shortcut hint rendered as `<kbd>` chips beside the
   * body. Each entry is a human-readable label (e.g. `"⌘+K"`, `"⌘+Enter"`).
   * The component renders these as <kbd> elements with an `aria-label` of
   * `"shortcut: <label>"` so screen-readers announce them properly.
   */
  keyHint?: string[];



  completionTrigger?: CompletionTrigger;
}

export interface TourScenario {
  /** Stable id persisted in `~/.lvis/onboarding/tour-state.json`. */
  id: string;
  /** Display title shown in the dot-pagination row (`step / total`). */
  title: string;
  /** Ordered steps. Must be non-empty. */
  steps: TourStep[];
}

/**
 * `first-boot-essentials` — the canonical first-login tour.
 *
 * The tour walks the user through the host UI so they land with a full
 * mental model: the composer, the input action bar, the command palette,
 * recent chat history, the Settings/menu entry, and the vendor/model
 * status-bar indicator. Plugins no longer have a dedicated step — the
 * input-area relayout folded plugin views into the command palette
 * (SlashPicker), so the palette step (anchor `command-palette-toggle`)
 * already covers how the user reaches plugins. Each anchor is pinned to a
 * `data-tour-anchor=` attribute on a production DOM element so renderer
 * refactors break the tour visibly (test in
 * `__tests__/tour-anchors-trigger.test.tsx`).
 */
function buildFirstBootEssentials(): TourScenario {
  return {
    id: "first-boot-essentials",
    title: t("defaultTourScenarios.firstBootTitle"),
    steps: [
      {
        anchorSelector: '[data-tour-anchor="composer-input"]',
        title: t("defaultTourScenarios.firstBootStep1Title"),
        body: t("defaultTourScenarios.firstBootStep1Body"),
        keyHint: ["⌘+Enter"],
        completionTrigger: {
          kind: "input",
          selector: '[data-tour-anchor="composer-input"]',
        },
      },
      {
        anchorSelector: '[data-tour-anchor="input-action-bar"]',
        title: t("defaultTourScenarios.firstBootStep2Title"),
        body: t("defaultTourScenarios.firstBootStep2Body"),
        completionTrigger: { kind: "manual" },
      },
      {
        anchorSelector: '[data-tour-anchor="command-palette-toggle"]',
        title: t("defaultTourScenarios.firstBootStep3Title"),
        body: t("defaultTourScenarios.firstBootStep3Body"),
        keyHint: ["⌘+K"],
        completionTrigger: { kind: "keypress", combo: "⌘+K" },
      },
      {
        anchorSelector: '[data-tour-anchor="chat-history"]',
        title: t("defaultTourScenarios.firstBootStep4Title"),
        body: t("defaultTourScenarios.firstBootStep4Body"),
        keyHint: ["⌘+F"],
        completionTrigger: { kind: "manual" },
      },
      {
        anchorSelector: '[data-tour-anchor="settings-entry"]',
        title: t("defaultTourScenarios.firstBootStep5Title"),
        body: t("defaultTourScenarios.firstBootStep5Body"),
        completionTrigger: { kind: "manual" },
      },
      {
        anchorSelector: '[data-tour-anchor="status-bar-vendor"]',
        title: t("defaultTourScenarios.firstBootStep6Title"),
        body: t("defaultTourScenarios.firstBootStep6Body"),
        completionTrigger: { kind: "manual" },
      },
    ],
  };
}

/**
 * Plugin-specific scenario tours. These can be launched directly by an
 * onboarding surface or via `lvis:tour:start`; when plugin-specific anchors
 * are not mounted yet, `readRect` returns null and the SpotlightTour centres
 * the card so the user still sees the narrative.
 */
function buildMeetingSummaryTour(): TourScenario {
  return {
    id: "meeting-summary-tour",
    title: t("defaultTourScenarios.meetingSummaryTitle"),
    steps: [
      {
        anchorSelector: '[data-tour-anchor="meeting-start"]',
        title: t("defaultTourScenarios.meetingSummaryStep1Title"),
        body: t("defaultTourScenarios.meetingSummaryStep1Body"),
      },
      {
        anchorSelector: '[data-tour-anchor="meeting-stop"]',
        title: t("defaultTourScenarios.meetingSummaryStep2Title"),
        body: t("defaultTourScenarios.meetingSummaryStep2Body"),
      },
      {
        anchorSelector: '[data-tour-anchor="meeting-summary-panel"]',
        title: t("defaultTourScenarios.meetingSummaryStep3Title"),
        body: t("defaultTourScenarios.meetingSummaryStep3Body"),
      },
      {
        anchorSelector: '[data-tour-anchor="composer-input"]',
        title: t("defaultTourScenarios.meetingSummaryStep4Title"),
        body: t("defaultTourScenarios.meetingSummaryStep4Body"),
        keyHint: ["⌘+?"],
      },
    ],
  };
}

function buildDocSearchTour(): TourScenario {
  return {
    id: "doc-search-tour",
    title: t("defaultTourScenarios.docSearchTitle"),
    steps: [
      {
        anchorSelector: '[data-tour-anchor="indexer-folder-picker"]',
        title: t("defaultTourScenarios.docSearchStep1Title"),
        body: t("defaultTourScenarios.docSearchStep1Body"),
      },
      {
        anchorSelector: '[data-tour-anchor="indexer-progress"]',
        title: t("defaultTourScenarios.docSearchStep2Title"),
        body: t("defaultTourScenarios.docSearchStep2Body"),
      },
      {
        anchorSelector: '[data-tour-anchor="composer-input"]',
        title: t("defaultTourScenarios.docSearchStep3Title"),
        body: t("defaultTourScenarios.docSearchStep3Body"),
      },
      {
        anchorSelector: '[data-tour-anchor="composer-input"]',
        title: t("defaultTourScenarios.docSearchStep4Title"),
        body: t("defaultTourScenarios.docSearchStep4Body"),
        keyHint: ["⌘+?"],
      },
    ],
  };
}

function buildWorkAssistantTour(): TourScenario {
  // Renamed from `proactive-work-tour` to align with the canonical

  // (package repo) and use the manifest id (work-assistant) on their DOM
  // attributes — the test/e2e fixture pins `manifest.id="work-assistant"`.
  return {
    id: "work-assistant-tour",
    title: t("defaultTourScenarios.workAssistantTitle"),
    steps: [
      {
        anchorSelector: '[data-tour-anchor="work-assistant-connect"]',
        title: t("defaultTourScenarios.workAssistantStep1Title"),
        body: t("defaultTourScenarios.workAssistantStep1Body"),
      },
      {
        anchorSelector: '[data-tour-anchor="work-assistant-scan"]',
        title: t("defaultTourScenarios.workAssistantStep2Title"),
        body: t("defaultTourScenarios.workAssistantStep2Body"),
      },
      {
        anchorSelector: '[data-tour-anchor="work-assistant-overlay"]',
        title: t("defaultTourScenarios.workAssistantStep3Title"),
        body: t("defaultTourScenarios.workAssistantStep3Body"),
      },
      {
        anchorSelector: '[data-tour-anchor="composer-input"]',
        title: t("defaultTourScenarios.workAssistantStep4Title"),
        body: t("defaultTourScenarios.workAssistantStep4Body"),
        keyHint: ["⌘+?"],
      },
    ],
  };
}

function buildMultiAgentTour(): TourScenario {
  return {
    id: "multi-agent-tour",
    title: t("defaultTourScenarios.multiAgentTitle"),
    steps: [
      {
        anchorSelector: '[data-tour-anchor="agent-hub-list"]',
        title: t("defaultTourScenarios.multiAgentStep1Title"),
        body: t("defaultTourScenarios.multiAgentStep1Body"),
      },
      {
        anchorSelector: '[data-tour-anchor="agent-hub-dispatch"]',
        title: t("defaultTourScenarios.multiAgentStep2Title"),
        body: t("defaultTourScenarios.multiAgentStep2Body"),
      },
      {
        anchorSelector: '[data-tour-anchor="agent-hub-monitor"]',
        title: t("defaultTourScenarios.multiAgentStep3Title"),
        body: t("defaultTourScenarios.multiAgentStep3Body"),
      },
      {
        anchorSelector: '[data-tour-anchor="composer-input"]',
        title: t("defaultTourScenarios.multiAgentStep4Title"),
        body: t("defaultTourScenarios.multiAgentStep4Body"),
        keyHint: ["⌘+?"],
      },
    ],
  };
}

/**
 * Tutorial-X3 — per-plugin walkthrough scenarios. Each scenario spotlights
 * the *real* DOM anchors a plugin shell exposes (data-tour-anchor) so the
 * user sees the plugin's UI rather than a generic placeholder. Anchors
 * use `[data-tour-anchor="plugin-shell:<id>"]` so the plugin webview
 * shell can declare them once and every scenario reuses the selector.
 *
 * The 4th step in each scenario points at the composer so the tour ends
 * with the user back on the chat surface — preventing the user from
 * being stranded inside a plugin UI without a path back to chat.
 */
function buildMeetingWalkthrough(): TourScenario {
  return {
    id: "meeting-walkthrough",
    title: t("defaultTourScenarios.meetingWalkthroughTitle"),
    steps: [
      {
        anchorSelector: '[data-tour-anchor="plugin-shell:meeting-record"]',
        title: t("defaultTourScenarios.meetingWalkthroughStep1Title"),
        body: t("defaultTourScenarios.meetingWalkthroughStep1Body"),
      },
      {
        anchorSelector: '[data-tour-anchor="plugin-shell:meeting-history"]',
        title: t("defaultTourScenarios.meetingWalkthroughStep2Title"),
        body: t("defaultTourScenarios.meetingWalkthroughStep2Body"),
      },
      {
        anchorSelector: '[data-tour-anchor="plugin-shell:meeting-actions"]',
        title: t("defaultTourScenarios.meetingWalkthroughStep3Title"),
        body: t("defaultTourScenarios.meetingWalkthroughStep3Body"),
      },
      {
        anchorSelector: '[data-tour-anchor="composer-input"]',
        title: t("defaultTourScenarios.meetingWalkthroughStep4Title"),
        body: t("defaultTourScenarios.meetingWalkthroughStep4Body"),
      },
    ],
  };
}

function buildIndexerWalkthrough(): TourScenario {
  return {
    id: "indexer-walkthrough",
    title: t("defaultTourScenarios.indexerWalkthroughTitle"),
    steps: [
      {
        anchorSelector: '[data-tour-anchor="plugin-shell:indexer-add-folder"]',
        title: t("defaultTourScenarios.indexerWalkthroughStep1Title"),
        body: t("defaultTourScenarios.indexerWalkthroughStep1Body"),
      },
      {
        anchorSelector: '[data-tour-anchor="plugin-shell:indexer-status"]',
        title: t("defaultTourScenarios.indexerWalkthroughStep2Title"),
        body: t("defaultTourScenarios.indexerWalkthroughStep2Body"),
      },
      {
        anchorSelector: '[data-tour-anchor="plugin-shell:indexer-search"]',
        title: t("defaultTourScenarios.indexerWalkthroughStep3Title"),
        body: t("defaultTourScenarios.indexerWalkthroughStep3Body"),
      },
      {
        anchorSelector: '[data-tour-anchor="composer-input"]',
        title: t("defaultTourScenarios.indexerWalkthroughStep4Title"),
        body: t("defaultTourScenarios.indexerWalkthroughStep4Body"),
      },
    ],
  };
}

function buildWorkAssistantWalkthrough(): TourScenario {
  // Renamed from `proactive-walkthrough`. Discovery card
  // `work-assistant.spotlightScenarioId` dispatches into this scenario id.
  return {
    id: "work-assistant-walkthrough",
    title: t("defaultTourScenarios.workAssistantWalkthroughTitle"),
    steps: [
      {
        anchorSelector: '[data-tour-anchor="plugin-shell:work-assistant-inbox"]',
        title: t("defaultTourScenarios.workAssistantWalkthroughStep1Title"),
        body: t("defaultTourScenarios.workAssistantWalkthroughStep1Body"),
      },
      {
        anchorSelector: '[data-tour-anchor="plugin-shell:work-assistant-actions"]',
        title: t("defaultTourScenarios.workAssistantWalkthroughStep2Title"),
        body: t("defaultTourScenarios.workAssistantWalkthroughStep2Body"),
      },
      {
        anchorSelector: '[data-tour-anchor="plugin-shell:work-assistant-rules"]',
        title: t("defaultTourScenarios.workAssistantWalkthroughStep3Title"),
        body: t("defaultTourScenarios.workAssistantWalkthroughStep3Body"),
      },
      {
        anchorSelector: '[data-tour-anchor="composer-input"]',
        title: t("defaultTourScenarios.workAssistantWalkthroughStep4Title"),
        body: t("defaultTourScenarios.workAssistantWalkthroughStep4Body"),
      },
    ],
  };
}

/**
 * Registry — `SpotlightTour` consumes this map to resolve `scenarioId`
 * payloads received over `lvis:tour:start`. New scenarios are added here;
 * the host-side store is unaware of the contents.
 *
 * Plugin-specific tours degrade gracefully when the owning plugin is not
 * installed: `readRect` returns null for the missing anchor and
 * `SpotlightTour.cardPlacement` centres the step card so the narrative is
 * still legible.
 *
 * Each property is a getter so scenario objects (with their translated
 * strings) are built lazily at access time, ensuring t() reads the current
 * locale rather than the locale at module initialisation.
 */
export const DEFAULT_TOUR_SCENARIOS: Readonly<Record<string, TourScenario>> = Object.freeze(
  Object.defineProperties({} as Record<string, TourScenario>, {
    "first-boot-essentials": { get: buildFirstBootEssentials, enumerable: true, configurable: false },
    "meeting-walkthrough": { get: buildMeetingWalkthrough, enumerable: true, configurable: false },
    "indexer-walkthrough": { get: buildIndexerWalkthrough, enumerable: true, configurable: false },
    "work-assistant-walkthrough": { get: buildWorkAssistantWalkthrough, enumerable: true, configurable: false },
    "meeting-summary-tour": { get: buildMeetingSummaryTour, enumerable: true, configurable: false },
    "doc-search-tour": { get: buildDocSearchTour, enumerable: true, configurable: false },
    "work-assistant-tour": { get: buildWorkAssistantTour, enumerable: true, configurable: false },
    "multi-agent-tour": { get: buildMultiAgentTour, enumerable: true, configurable: false },
  }),
);

export function getTourScenario(id: string): TourScenario | undefined {
  return DEFAULT_TOUR_SCENARIOS[id];
}
