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
 * the `--chrome-*` tokens in `src/styles.css` carry, and `SHELL_GUTTER` /
 * `CHROME_GAP_TIGHT` below are those tokens' values for the arithmetic that
 * happens in TypeScript rather than in CSS.
 */

/**
 * The main window's own size, in px.
 *
 * `WIDTH` / `HEIGHT` are what the shell OPENS at; `MIN_*` are what it may be
 * dragged down to. Width's two values are the same number today — the shell
 * opens at a single chat column with nothing to give back — but they answer
 * different questions and must stay separately settable: a wider default must
 * not widen the minimum.
 *
 * These live here rather than in `main/main-window-bounds.ts`, which owns
 * where the window GOES given a work area, because the renderer reasons about
 * them too: the breadcrumb collapses below the width the chat band opens at,
 * and the side-panel docking threshold has to stay under it. A renderer module
 * reaching into `main/` for a number is a layering leak; the number itself is
 * shell geometry, which is what this file is.
 */
export const MAIN_WINDOW_WIDTH = 460;
export const MAIN_WINDOW_HEIGHT = 840;
export const MAIN_WINDOW_MIN_WIDTH = 460;
export const MAIN_WINDOW_MIN_HEIGHT = 640;

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
const TRAFFIC_LIGHT_RIGHT_EDGE = TRAFFIC_LIGHT_POSITION.x + TRAFFIC_LIGHT_CLUSTER_RUN;

/** px value of `--chrome-gap-tight` in src/styles.css. */
export const CHROME_GAP_TIGHT = 4;

/**
 * The air between the window edge and a floating card, and between that card
 * and the content beside it — one gutter, not two numbers. This is also the px
 * value of `--chrome-gap`, mirrored in CSS as `--shell-card-inset` (defined as
 * `var(--chrome-gap)`) so the pixel count still has a single home there too.
 */
export const SHELL_GUTTER = 8;

/**
 * The band's own edge gutter: its leading pad where there are no traffic
 * lights to clear, and its trailing pad on the two platforms whose bands carry
 * one. The win/linux band sets no trailing pad — its minimise / maximise /
 * close cluster runs flush to the window's corner, so a gutter there would
 * float the controls off the edge they belong to.
 */
export const BAND_EDGE_PAD = 12;

/**
 * The band's leading pad on darwin, measured from the WINDOW edge: past the
 * lights with a tight gap, so the first band control never hover-overlaps
 * them.
 */
export const BAND_LEAD_PAD_DARWIN = TRAFFIC_LIGHT_RIGHT_EDGE + CHROME_GAP_TIGHT;

/**
 * How far the sidebar card's own left edge sits from the window's. Equal to
 * `SHELL_GUTTER` — the card is inset by one gutter — but a distinct fact from
 * the gap between two things, and the arithmetic below subtracts THIS one.
 * Mirrored in CSS as `--shell-card-inset`, which is why that token is one of
 * the pairs `check-shell-geometry-tokens.mjs` holds together: change the
 * card's inset on either side alone and the cluster strip stops clearing the
 * lights.
 */
const CARD_LEFT_INSET = SHELL_GUTTER;

/**
 * The sidebar cluster strip's leading pad on darwin, measured from the CARD's
 * left edge rather than the window's — which is the whole reason it is not the
 * same number as `BAND_LEAD_PAD_DARWIN`. The first button wants to start a
 * full gap past the lights; the card already starts `CARD_LEFT_INSET` in, so
 * the pad it needs is that target minus the card's own offset. The two terms
 * cancel numerically today; they are written out because they are different
 * facts, and a change to either one has to move this pad.
 *
 * The card surface still paints behind the lights. The OS draws them ON TOP of
 * the webview, so that is cosmetic backing, not a collision.
 */
const CLUSTER_FIRST_BUTTON_X = TRAFFIC_LIGHT_RIGHT_EDGE + SHELL_GUTTER;
export const CLUSTER_LEAD_PAD_DARWIN = CLUSTER_FIRST_BUTTON_X - CARD_LEFT_INSET;

/** px value of `--chrome-icon-button` in src/styles.css: the square every control on the band line is. */
export const CHROME_ICON_BUTTON = 24;

/** px value of `--chrome-gap-hair` in src/styles.css: the gap between those squares. */
export const CHROME_GAP_HAIR = 2;

/**
 * The sidebar cluster strip: collapse toggle, search, back, forward — four
 * `CHROME_ICON_BUTTON` squares with `CHROME_GAP_HAIR` between them
 * (`Sidebar.tsx`'s `ClusterStrip`, whose history half is `ViewPathNav.tsx`'s
 * `ViewHistoryNav`). The run is the strip's width past its first button.
 */
const CLUSTER_STRIP_CONTROLS = 4;
const CLUSTER_STRIP_RUN = CLUSTER_STRIP_CONTROLS * CHROME_ICON_BUTTON + (CLUSTER_STRIP_CONTROLS - 1) * CHROME_GAP_HAIR;

/**
 * Where the band's content starts while the sidebar is a collapsed rail.
 *
 * The cluster strip does not retract with the card: it stands bare on the
 * band line, ending `CLUSTER_STRIP_RUN` past its first button — on darwin
 * `CLUSTER_FIRST_BUTTON_X`, elsewhere the card's inset plus the strip's own
 * tight pad. The path used to start `CONTENT_TITLE_INSET` past
 * `COLLAPSED_RAIL_RESERVE`, which on darwin is the lights' line itself, so
 * it rendered under the toggle and the history buttons. The band clears the
 * strip by one gutter — the same gap it keeps from the expanded card.
 */
export function collapsedBandLeadClearance(isDarwin: boolean): number {
  const firstButtonX = isDarwin ? CLUSTER_FIRST_BUTTON_X : CARD_LEFT_INSET + CHROME_GAP_TIGHT;
  return firstButtonX + CLUSTER_STRIP_RUN + SHELL_GUTTER;
}

/**
 * Card edge -> where a content title starts.
 *
 * The main surface sits one gutter past the sidebar card and carries another of
 * its own leading padding, so every view's title — a plugin's name, the chat
 * group's conversation title — begins two gutters in. The band's path is the
 * same label one row up, and a path that stopped at the card edge read as
 * belonging to the sidebar rather than to the thing it names.
 */
export const CONTENT_TITLE_INSET = SHELL_GUTTER * 2;

/**
 * What `<main>` reserves on its leading edge while the sidebar is a collapsed
 * icon rail — in px, like everything else on the lights' line. Mirrored in CSS
 * as `--shell-collapsed-rail-reserve` (a pair `check-shell-geometry-tokens.mjs`
 * holds together): the content surface pads by the token, and everything in
 * flow inside it — the window's notice strip included — starts past it.
 *
 * The number is pinned by the traffic lights, not by the rail. On darwin the
 * band's content can start no further left than `BAND_LEAD_PAD_DARWIN`, and
 * the collapsed title sits `CONTENT_TITLE_INSET` past the reserve, so the
 * title lands on that lead line only when the reserve is exactly the
 * difference. (The band's own path starts further right, past the bare
 * cluster strip — `collapsedBandLeadClearance`.) It is
 * written as a literal because the CSS mirror gate reads this module as source
 * text; `__tests__/shell-geometry.test.ts` holds the identity.
 *
 * The rail card's own width is derived from this in CSS
 * (`--shell-collapsed-rail-width` = reserve − card inset − one gutter), so the
 * rail ends a gutter before the content at every type scale rather than only
 * at the one the app ships with.
 *
 * On win/linux nothing external pins this reserve — there are no traffic
 * lights to clear on those platforms — but the band still claims the same
 * `leadClearance` there as on darwin, so one number serves the collapsed
 * reserve on all three platforms rather than a per-platform pair.
 */
export const COLLAPSED_RAIL_RESERVE = 64;

/**
 * The widest control the collapsed icon rail renders, in rem: Tailwind's
 * `h-9`/`w-9` (9 × its 0.25rem step). Both the rail's own square nav buttons
 * (`Sidebar.tsx`'s `NavItem`) and its "new chat" button size to this, so it is
 * the control `COLLAPSED_RAIL_RESERVE` has to leave room for at the user's
 * largest font scale — `__tests__/shell-geometry.test.ts` asserts the fit
 * against `appearance-font.ts`'s `FONT_SIZE_SCALE_VALUES`.
 */
export const RAIL_CONTROL_REM = 2.25;

/**
 * The literal Tailwind class pair for `RAIL_CONTROL_REM`, imported into
 * `Sidebar.tsx` rather than restated there — a plain `"h-9 w-9"` string
 * so Tailwind's content scanner (`@source` in `src/styles.css` covers this
 * `.ts` file too) still finds the class as source text.
 */
export const RAIL_CONTROL_SIZE_CLASS = "h-9 w-9";
