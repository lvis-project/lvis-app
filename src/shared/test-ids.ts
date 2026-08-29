/**
 * DOM contracts with two readers: production code that must react to a surface
 * being on screen, and the tests that pin where such a surface may appear.
 * One definition keeps the two from drifting apart — the tour and the tile
 * tests must agree on what counts as a surface that takes over a composer.
 */

/**
 * Every surface that takes over the composer of the scope it is drawn in: a
 * tool-approval card (the ask an `agent_spawn` raises is one of these), a
 * user-question card, and an open modal dialog. The onboarding tour keeps its
 * backdrop off such a surface; the tile tests prove a card raised by one tile
 * leaves every other tile with none.
 */
export const BLOCKING_SURFACE_SELECTOR = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[data-testid="approval-dock"]',
  '[data-testid="question-overlay"]',
].join(", ");
