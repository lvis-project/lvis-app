/**
 * MCP-app card location authority.
 *
 * A card has exactly ONE live mount at any moment — that invariant used to be kept
 * per-mount (McpAppView's own `detachedViewKey` state) because there were only ever
 * TWO possible mounts for a given card (its own home mount, and the single-instance
 * detached shell), and only the home mount could ever initiate a move between them.
 * `pip` breaks that assumption: it introduces a THIRD possible live mount (a pip
 * surface, rendered by a DIFFERENT component than the card's home mount) that can
 * ALSO initiate a move (e.g. pip → fullscreen), so "where is this card live" can no
 * longer be tracked as a boolean local to the mount that happened to start the move —
 * it has to be one shared fact every mount reads and writes atomically.
 *
 * This module IS that shared fact. It does not render anything and does not know
 * which component eventually presents `pip` (an in-page panel, an OS-level
 * always-on-top window, or some other future surface) — it only tracks, per card
 * instance, which of the three locations currently holds the live mount, and lets
 * every interested mount subscribe to changes.
 *
 * ─── Card identity ────────────────────────────────────────────────────────────
 * `cardId` here is NOT the per-mount `ui/update-model-context` id McpAppView mints on
 * every mount (that one is deliberately "once per mount" — see McpAppView's
 * `cardIdRef` — a fresh mount, including a fresh AWAY mount, gets a fresh
 * model-context slot). It is a SEPARATE id, minted ONCE by whichever mount is the
 * card's HOME (the transcript / preview-rail instance that owns the card for its
 * whole lifetime), and handed explicitly to any AWAY mount that renders on that
 * home's behalf, so a move made by the away mount lands on the SAME card the home
 * mount is dormant for.
 *
 * ─── The scope of "exactly one live mount" (a pre-existing wrinkle, not fixed here) ──
 * "A card has exactly ONE live mount" is a claim about ONE HOME MOUNT's card instance
 * — it is NOT a whole-app invariant. `ChatSidePanel`'s preview rail mounts its OWN,
 * fully independent `<McpAppView payload={target.payload} />` for the SAME logical
 * payload a transcript card already renders (see `ChatSidePanel.tsx`), with its own
 * `cardIdRef` (model-context identity) and, as of this module, its own separately
 * self-minted location-store id (`locationId` left undefined ⇒ each mints its own).
 * The two mounts share no state and never coordinate, so BOTH can be genuinely live
 * `<webview>`s for "the same card" at once — two bridges, both able to call tools and
 * post `ui/message` / `ui/update-model-context`, existed before `pip` and are
 * unaffected by it either way. This module keys strictly on the id it is given; it
 * makes no attempt to unify these two pre-existing independent mounts, and closing
 * that gap (if ever wanted) is a `ChatSidePanel` change, not a location-store one.
 *
 * ─── The revive guard (the pip→fullscreen hazard) ────────────────────────────
 * `reviveCardIfAt` is the ONE chokepoint that sends a card back to its home mount,
 * and it is GUARDED: it only applies if the card's location is STILL the expected
 * one at the moment it runs. Without that guard, a revive signal that names an OLD
 * location (e.g. "you left pip") arriving AFTER the card has already moved on again
 * (e.g. pip → fullscreen, now sitting in `detached`) would incorrectly send the home
 * mount live again — while the detached window is ALSO still live. Two live mounts
 * for one card is exactly what the whole display-mode-truthfulness design (see
 * `shared/mcp-app-display-mode.ts`) exists to prevent: two bridges means two apps
 * that can both call tools and post messages "as" the same card, and one of them is
 * lying about the mode it is in.
 */
import type { McpUiPayload } from "../../../mcp/types.js";

/** Where a card's ONE live mount currently is. */
export type McpAppCardLocation =
  | { readonly kind: "inline" }
  | { readonly kind: "pip" }
  | { readonly kind: "detached"; readonly viewKey: string };

/** The card's HOME location — the default for any id with no registry entry. */
const INLINE: McpAppCardLocation = { kind: "inline" };

/** What an AWAY mount (pip / a future surface) needs to render on the home's behalf. */
export interface McpAppPipOccupant {
  readonly cardId: string;
  readonly payload: McpUiPayload;
  readonly originSessionId: string;
}

interface CardRecord {
  location: McpAppCardLocation;
  payload: McpUiPayload;
  originSessionId: string;
}

// Module-level singletons — the whole point is that every mount (home + away) reads
// and writes the SAME map, never a per-mount copy.
const cards = new Map<string, CardRecord>();
const cardListeners = new Map<string, Set<() => void>>();
const pipListeners = new Set<() => void>();

/**
 * The pip occupant, CACHED. `useSyncExternalStore` requires `getSnapshot` to return a
 * referentially STABLE value when nothing changed, or React re-renders in an infinite
 * loop (a fresh `{ ... }` literal built on every call — even a structurally identical
 * one — reads as "changed" every time). So the occupant is computed exactly once per
 * actual pip-occupancy change (here, at every site that mutates `cards` in a way that
 * could affect it), not on every `getPipOccupant()` read.
 */
let pipOccupantCache: McpAppPipOccupant | null = null;

function recomputePipOccupantCache(): void {
  for (const [cardId, record] of cards) {
    if (record.location.kind === "pip") {
      pipOccupantCache = { cardId, payload: record.payload, originSessionId: record.originSessionId };
      return;
    }
  }
  pipOccupantCache = null;
}

function notifyCard(cardId: string): void {
  for (const listener of cardListeners.get(cardId) ?? []) listener();
}

function notifyPip(): void {
  recomputePipOccupantCache();
  for (const listener of pipListeners) listener();
}

function sameLocation(a: McpAppCardLocation, b: McpAppCardLocation): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "detached" && b.kind === "detached") return a.viewKey === b.viewKey;
  return true;
}

/** Absent from the registry ⇒ `inline` — a card that has never left its home mount. */
export function getCardLocation(cardId: string): McpAppCardLocation {
  return cards.get(cardId)?.location ?? INLINE;
}

/** Subscribe to ONE card's location changes (a home mount's `useSyncExternalStore` source). */
export function subscribeCardLocation(cardId: string, listener: () => void): () => void {
  let set = cardListeners.get(cardId);
  if (!set) {
    set = new Set();
    cardListeners.set(cardId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) cardListeners.delete(cardId);
  };
}

/**
 * Who currently occupies the pip slot, or `null` if nobody does. Single-slot by
 * design. Returns the CACHED value (see `pipOccupantCache` above) — referentially
 * stable across calls until an actual pip-occupancy change, which
 * `useSyncExternalStore` requires of a `getSnapshot` function.
 */
export function getPipOccupant(): McpAppPipOccupant | null {
  return pipOccupantCache;
}

/** Subscribe to "who occupies pip" changes (the pip surface's ONE source, whatever it turns out to be). */
export function subscribePipOccupant(listener: () => void): () => void {
  pipListeners.add(listener);
  return () => pipListeners.delete(listener);
}

/**
 * Move a card AWAY from its home mount. Only ever called by the card's CURRENTLY LIVE
 * mount — a dormant mount renders no `<webview>`, so it never gets an `AppBridge` and
 * can never call this. That is what keeps "at most one card claims `pip`" and "at most
 * one card claims a given `viewKey`" true by construction, not by a check here.
 *
 * Single-slot `pip`: claiming it EVICTS whichever OTHER card currently holds it —
 * mirroring `WindowManager`'s single-instance detached shell, where opening a second
 * view NAVIGATES the existing window rather than requiring two to coexist. The
 * evicted card's location reverts to `inline` and ITS listeners fire, so its home
 * mount comes back to life instead of being silently stranded in a location nothing
 * renders anymore.
 */
export function moveCard(
  cardId: string,
  next: Exclude<McpAppCardLocation, { kind: "inline" }>,
  content: { payload: McpUiPayload; originSessionId: string },
): void {
  const prevKind = cards.get(cardId)?.location.kind;
  let pipChanged = prevKind === "pip" || next.kind === "pip";

  if (next.kind === "pip") {
    for (const [otherId, record] of cards) {
      if (otherId !== cardId && record.location.kind === "pip") {
        cards.delete(otherId);
        notifyCard(otherId);
      }
    }
  }

  cards.set(cardId, { location: next, payload: content.payload, originSessionId: content.originSessionId });
  notifyCard(cardId);
  if (pipChanged) notifyPip();
}

/**
 * Send a card back to its home mount — GUARDED on `expected` (see the module doc for
 * why: this is what prevents the pip→fullscreen hazard). Returns whether the revive
 * actually applied; a caller that gets `false` must NOT assume its home mount is live
 * — the card is genuinely somewhere else now.
 */
export function reviveCardIfAt(
  cardId: string,
  expected: Exclude<McpAppCardLocation, { kind: "inline" }>,
): boolean {
  const current = cards.get(cardId)?.location ?? INLINE;
  if (!sameLocation(current, expected)) return false;
  const wasPip = current.kind === "pip";
  cards.delete(cardId);
  notifyCard(cardId);
  if (wasPip) notifyPip();
  return true;
}

/** Test-only: clear the module-level singletons so tests never leak into each other. */
export function __resetMcpAppCardLocationStoreForTests(): void {
  cards.clear();
  cardListeners.clear();
  pipListeners.clear();
  pipOccupantCache = null;
}
