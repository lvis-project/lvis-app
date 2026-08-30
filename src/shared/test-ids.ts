/**
 * The `data-testid` values that more than one surface reads.
 *
 * Renderer components declare them, renderer suites query them, Playwright
 * specs under `test/e2e` query them, and a few components use them as DOM
 * selectors to find a sibling surface (the approval dock looks for the
 * question overlay; the plugin grid finds the composer). Those four readers
 * cannot import each other, so the value lives here — a `shared/` leaf with
 * no imports — and nothing else spells it out.
 *
 * Only ids read from several files belong here. A test id used by one
 * component and its own suite stays a literal in that component.
 */
export const TEST_IDS = {
  allowAlwaysButton: "allow-always-button",
  approvalDock: "approval-dock",
  approvalDockQueueDepth: "approval-dock-queue-depth",
  approvalReviewDetails: "approval-review-details",
  approveButton: "approve-button",
  chatGroupPanelToggle: "chat-group-panel-toggle",
  chatSidePanel: "chat-side-panel",
  chatViewRoot: "chat-view-root",
  commandPopoverTrigger: "command-popover-trigger",
  composer: "composer",
  composerInputBar: "composer-input-bar",
  composerTextarea: "composer-textarea",
  denyButton: "deny-button",
  llmModelSelect: "llm-model-select",
  openPermanentDenySettings: "open-permanent-deny-settings",
  pluginInstallNetworkAccess: "plugin-install-network-access",
  questionOverlay: "question-overlay",
  reviewerPromptPanel: "reviewer-prompt-panel",
  routeCanvas: "route-canvas",
  settingsMobileBack: "settings-mobile-back",
  settingsPageTitle: "settings-page-title",
  tokenCostBadge: "token-cost-badge",
  viewPathBack: "view-path-back",
  windowApprovalScope: "window-approval-scope",
} as const;

export type TestId = (typeof TEST_IDS)[keyof typeof TEST_IDS];

/** The launcher button for one side-panel `kind` (`file-browser`, `activity`, …). */
export function chatSidePanelLauncherTestId(kind: string): string {
  return `chat-side-panel-launcher-${kind}`;
}

/** The execution-mode radio for one mode value (`auto`, `strict`, …). */
export function execModeTestId(mode: string): string {
  return `exec-mode-${mode}`;
}

/** A CSS attribute selector for a test id, for the components that locate a sibling surface by it. */
export function testIdSelector(id: TestId): string {
  return `[data-testid="${id}"]`;
}

/** An open modal dialog. Portaled to the body, so it is window-wide by construction. */
export const MODAL_DIALOG_SELECTOR =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';

/**
 * Any open dialog, the approval dock, or a user-question card: the surfaces
 * that make the rest of the route inert. Message queueing, the onboarding tour
 * and the spotlight all pause while one is on screen.
 *
 * The question card is in the set for the same reason the approval dock is:
 * both are a turn waiting on an answer, and a tour backdrop painted over
 * either one hides the thing the user has to act on before anything moves.
 *
 * An approval or question card is scoped to the surface it is drawn in —
 * readers that answer for ONE composer ask `blockingSurfaceCovers`
 * (permissions/ApprovalDock) rather than the whole document.
 */
export const BLOCKING_SURFACE_SELECTOR =
  `${MODAL_DIALOG_SELECTOR}, ${testIdSelector(TEST_IDS.approvalDock)}, ${testIdSelector(TEST_IDS.questionOverlay)}`;
