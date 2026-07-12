/**
 * MCP Apps card size — the host's BOUNDS for an app-reported content size.
 *
 * `ui/notifications/size-changed` (and the `_meta.ui.height` seed on a tool result)
 * are UNTRUSTED numbers: the app measures its own content and asks the host to grow
 * the card. Nothing in the spec bounds them, and CSS cannot: the card's containing
 * block has an INDEFINITE height, so a percentage `max-height` resolves to `none`
 * and caps nothing. A card that reports `height: 5_000_000` would push the rest of
 * the transcript out of reach.
 *
 * So the bound is arithmetic and lives here as NAMED constants, the same convention
 * the feature's other untrusted-input caps follow (`MCP_APP_DOWNLOAD_MAX_BYTES` = 25 MB,
 * `MCP_APP_MESSAGE_MAX_CHARS` = 4096) rather than as magic numbers at a call site.
 * {@link clampMcpAppCardSize} is applied at the ONE sink that turns those numbers into
 * pixels (McpAppView's `handleResize`), and {@link mcpAppCardSeedHeight} at the one sink
 * that reads the payload's `height` seed.
 *
 * Kept React-free so the renderer, the bridge handlers and the e2e page bundle all
 * read the same fact.
 */

/** Height a card gets when the tool result declares none (or declares a bad one). */
export const MCP_APP_CARD_DEFAULT_HEIGHT_PX = 300;

/** Below this a card cannot render its own chrome; treat it as a floor, not an error. */
export const MCP_APP_CARD_MIN_HEIGHT_PX = 40;

/**
 * The tallest a card may make itself. Chosen to exceed the usable height of the
 * common desktop displays (so a legitimately tall card is never truncated in the
 * detached/fullscreen shell) while keeping an inline transcript card scroll-reachable.
 */
export const MCP_APP_CARD_MAX_HEIGHT_PX = 1600;

/** Width floor — narrower than this is a rendering artifact, not an intent. */
export const MCP_APP_CARD_MIN_WIDTH_PX = 120;

/**
 * Width ceiling. CSS `max-width: 100%` already bounds the card visually (the parent
 * width IS definite, unlike its height), but an absurd px width still lands in the
 * style attribute and in layout — so it is bounded here too, at the same sink.
 */
export const MCP_APP_CARD_MAX_WIDTH_PX = 3840;

/** The live card dimensions McpAppView holds in state. `width` unset ⇒ responsive 100%. */
export interface McpAppCardSize {
  width?: number;
  height: number;
}

/**
 * Bound ONE dimension. Returns `null` for anything that is not a usable pixel count —
 * `NaN` / `Infinity` / non-numbers / zero / negatives — so the caller can keep the
 * previous value rather than apply a poisoned one.
 */
function clampDimension(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(Math.min(max, Math.max(min, value)));
}

/**
 * Apply an app-reported size change on top of the card's current size.
 *
 * · An OMITTED dimension keeps the current one (a height-only notification must not
 *   drop a width the app declared earlier) — the spec's partial-update semantics.
 * · A REJECTED dimension (non-finite / ≤ 0) also keeps the current one: a hostile or
 *   buggy notification can never move the card, and never throws.
 * · Everything else is clamped into the bounds above.
 */
export function clampMcpAppCardSize(
  next: { width?: number; height?: number },
  prev: McpAppCardSize,
): McpAppCardSize {
  const width =
    next.width === undefined
      ? prev.width
      : (clampDimension(next.width, MCP_APP_CARD_MIN_WIDTH_PX, MCP_APP_CARD_MAX_WIDTH_PX) ?? prev.width);
  const height =
    next.height === undefined
      ? prev.height
      : (clampDimension(next.height, MCP_APP_CARD_MIN_HEIGHT_PX, MCP_APP_CARD_MAX_HEIGHT_PX) ?? prev.height);
  return { width, height };
}

/**
 * The card's INITIAL height, from the server-declared `_meta.ui.height` seed. Same
 * bounds as a live resize (the seed is the same untrusted number, just delivered on
 * the tool result), falling back to {@link MCP_APP_CARD_DEFAULT_HEIGHT_PX}.
 */
export function mcpAppCardSeedHeight(value: unknown): number {
  return (
    clampDimension(value, MCP_APP_CARD_MIN_HEIGHT_PX, MCP_APP_CARD_MAX_HEIGHT_PX) ??
    MCP_APP_CARD_DEFAULT_HEIGHT_PX
  );
}
