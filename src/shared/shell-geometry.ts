/**
 * Single source of truth for the window shell's device-pixel geometry: where
 * macOS draws the traffic lights, and the leading clearances every surface
 * that shares their line derives from them.
 *
 * The numbers cross the process boundary. The main process hands
 * `TRAFFIC_LIGHT_POSITION` to every BrowserWindow (`main/window-chrome.ts`),
 * and in the renderer both the title band (`CustomTitleBar`) and the floating
 * sidebar card (`Sidebar`) have to begin past the lights the OS then draws on
 * top of the webview. Each side used to restate the position from memory, and
 * a restatement cannot be nudged: moving the lights by a pixel left every
 * control that is supposed to clear them overlapping, with three comments
 * still describing the old spot.
 *
 * px, never rem — the OS draws the lights in device pixels, so nothing that
 * lines up with them may follow the user's type scale. That is the same rule
 * the `--chrome-*` tokens in `src/styles.css` carry, and `CHROME_GAP` /
 * `CHROME_GAP_TIGHT` below are those tokens' values for the arithmetic that
 * happens in TypeScript rather than in CSS.
 */

/**
 * Where macOS positions the traffic-light cluster inside the `hiddenInset`
 * title bar, in window coordinates.
 *
 * `y` pairs with the 36px band (`--chrome-band-height`): 12 plus the ~12px
 * light puts the lights' centre on y=18, which is also where the band centres
 * a `--chrome-control-height` (28px) control. Change one without the other and
 * every chrome row sits off the lights' line.
 */
export const TRAFFIC_LIGHT_POSITION = { x: 18, y: 12 } as const;

/** How far the three lights run from `TRAFFIC_LIGHT_POSITION.x`. */
const TRAFFIC_LIGHT_CLUSTER_RUN = 58;

/**
 * The x the lights end at. Everything that must not overlap them — the band's
 * content, the sidebar card's cluster strip — measures its clearance from
 * here rather than from a copy of the number.
 */
export const TRAFFIC_LIGHT_RIGHT_EDGE = TRAFFIC_LIGHT_POSITION.x + TRAFFIC_LIGHT_CLUSTER_RUN;

/** px value of `--chrome-gap` in src/styles.css. */
export const CHROME_GAP = 8;
/** px value of `--chrome-gap-tight` in src/styles.css. */
export const CHROME_GAP_TIGHT = 4;

/**
 * The air between the window edge and a floating card, and between that card
 * and the content beside it — one gutter, not two numbers. Mirrored in CSS as
 * `--shell-gutter` / `--shell-card-inset`, both defined as `var(--chrome-gap)`
 * so the pixel count still has a single home.
 */
export const SHELL_GUTTER = CHROME_GAP;

/**
 * The band's own edge gutter: its trailing pad on every platform, and its
 * leading pad where there are no traffic lights to clear.
 */
export const BAND_EDGE_PAD = 12;

/**
 * The band's leading pad on darwin, measured from the WINDOW edge: past the
 * lights with a tight gap, so the first band control never hover-overlaps
 * them.
 */
export const BAND_LEAD_PAD_DARWIN = TRAFFIC_LIGHT_RIGHT_EDGE + CHROME_GAP_TIGHT;

/**
 * The sidebar cluster strip's leading pad on darwin, measured from the CARD's
 * left edge rather than the window's — which is the whole reason it is not the
 * same number as `BAND_LEAD_PAD_DARWIN`. The first button wants to start a
 * full gap past the lights; the card already starts one gutter in, so the pad
 * it needs is that target minus the card's own offset.
 *
 * The card surface still paints behind the lights. The OS draws them ON TOP of
 * the webview, so that is cosmetic backing, not a collision.
 */
export const CLUSTER_LEAD_PAD_DARWIN = TRAFFIC_LIGHT_RIGHT_EDGE + CHROME_GAP - SHELL_GUTTER;
