/**
 * mcp-app-card-location-store — the renderer-side authority for "which mount is a
 * card's ONE live surface right now" (inline home / pip / a specific detached window).
 *
 * The load-bearing case is `reviveCardIfAt`'s guard: a revive signal that names a
 * location the card has since LEFT must be a no-op, or two mounts end up live for the
 * same card at once (the pip→fullscreen hazard — see the module doc).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpUiPayload } from "../../../../mcp/types.js";
import {
  __resetMcpAppCardLocationStoreForTests,
  getCardLocation,
  getPipOccupant,
  moveCard,
  reviveCardIfAt,
  subscribeCardLocation,
  subscribePipOccupant,
} from "../mcp-app-card-location-store.js";

const content = (serverId = "github"): { payload: McpUiPayload; originSessionId: string } => ({
  payload: { serverId, resourceUri: "ui://card/1" },
  originSessionId: "sess-1",
});

beforeEach(() => {
  __resetMcpAppCardLocationStoreForTests();
});

describe("default location", () => {
  it("a card with no registry entry is inline, and nobody occupies pip", () => {
    expect(getCardLocation("never-seen")).toEqual({ kind: "inline" });
    expect(getPipOccupant()).toBeNull();
  });
});

describe("moveCard", () => {
  it("moves a card to pip and exposes it as the pip occupant", () => {
    moveCard("c1", { kind: "pip" }, content("github"));

    expect(getCardLocation("c1")).toEqual({ kind: "pip" });
    expect(getPipOccupant()).toEqual({
      cardId: "c1",
      payload: { serverId: "github", resourceUri: "ui://card/1" },
      originSessionId: "sess-1",
    });
  });

  it("moves a card to a specific detached viewKey", () => {
    moveCard("c1", { kind: "detached", viewKey: "vk-1" }, content());

    expect(getCardLocation("c1")).toEqual({ kind: "detached", viewKey: "vk-1" });
    expect(getPipOccupant()).toBeNull();
  });

  it("moving the SAME card from pip to detached vacates the pip slot", () => {
    moveCard("c1", { kind: "pip" }, content());
    moveCard("c1", { kind: "detached", viewKey: "vk-1" }, content());

    expect(getCardLocation("c1")).toEqual({ kind: "detached", viewKey: "vk-1" });
    expect(getPipOccupant()).toBeNull();
  });

  it("single-slot: claiming pip evicts whichever OTHER card currently holds it, reverting it to inline", () => {
    moveCard("card-A", { kind: "pip" }, content("a"));
    const evictedListener = vi.fn();
    const unsubscribe = subscribeCardLocation("card-A", evictedListener);

    moveCard("card-B", { kind: "pip" }, content("b"));

    expect(getCardLocation("card-A")).toEqual({ kind: "inline" }); // evicted back home
    expect(getCardLocation("card-B")).toEqual({ kind: "pip" });
    expect(getPipOccupant()?.cardId).toBe("card-B");
    // card-A's home mount is told to come back to life.
    expect(evictedListener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

describe("reviveCardIfAt — the guarded chokepoint", () => {
  it("revives a card FROM the exact expected location", () => {
    moveCard("c1", { kind: "pip" }, content());

    expect(reviveCardIfAt("c1", { kind: "pip" })).toBe(true);
    expect(getCardLocation("c1")).toEqual({ kind: "inline" });
  });

  it("revives a card FROM a specific detached viewKey", () => {
    moveCard("c1", { kind: "detached", viewKey: "vk-1" }, content());

    expect(reviveCardIfAt("c1", { kind: "detached", viewKey: "vk-1" })).toBe(true);
    expect(getCardLocation("c1")).toEqual({ kind: "inline" });
  });

  it("a close signal for a DIFFERENT viewKey does not revive this card (existing inline<->detached invariant, now store-enforced)", () => {
    moveCard("c1", { kind: "detached", viewKey: "vk-1" }, content());

    expect(reviveCardIfAt("c1", { kind: "detached", viewKey: "vk-OTHER" })).toBe(false);
    expect(getCardLocation("c1")).toEqual({ kind: "detached", viewKey: "vk-1" });
  });

  it("a revive naming a location this card was never in is a no-op", () => {
    expect(reviveCardIfAt("never-moved", { kind: "pip" })).toBe(false);
    expect(getCardLocation("never-moved")).toEqual({ kind: "inline" });
  });

  it("PIP -> FULLSCREEN HAZARD: a stale revive naming the card's OLD location (pip) must not clobber the location it has since moved to (detached) — this is the guard that prevents two live bridges for one card", () => {
    // The pip mount itself requests fullscreen: the card moves on to `detached`
    // before any stale "you left pip" signal is processed.
    moveCard("c1", { kind: "pip" }, content());
    moveCard("c1", { kind: "detached", viewKey: "vk-1" }, content());

    // A revive signal that still names the OLD location (pip) arrives late — it MUST
    // be a no-op. Reviving here would send the home mount live again while the
    // detached window is ALSO still live: two live bridges for the same card, one of
    // them lying about the mode it is in.
    const applied = reviveCardIfAt("c1", { kind: "pip" });

    expect(applied).toBe(false);
    expect(getCardLocation("c1")).toEqual({ kind: "detached", viewKey: "vk-1" });
  });
});

describe("subscribeCardLocation", () => {
  it("notifies a card's own listeners on move and on revive, and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCardLocation("c1", listener);

    moveCard("c1", { kind: "pip" }, content());
    expect(listener).toHaveBeenCalledTimes(1);

    reviveCardIfAt("c1", { kind: "pip" });
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    moveCard("c1", { kind: "pip" }, content());
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("never notifies a DIFFERENT card's listeners", () => {
    const listener = vi.fn();
    subscribeCardLocation("card-A", listener);

    moveCard("card-B", { kind: "pip" }, content());

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("subscribePipOccupant", () => {
  it("fires when a card enters pip, and when it leaves pip", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePipOccupant(listener);

    moveCard("c1", { kind: "pip" }, content());
    expect(listener).toHaveBeenCalledTimes(1);

    moveCard("c1", { kind: "detached", viewKey: "vk-1" }, content());
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it("does NOT fire for a move that never touches pip", () => {
    const listener = vi.fn();
    subscribePipOccupant(listener);

    moveCard("c1", { kind: "detached", viewKey: "vk-1" }, content());

    expect(listener).not.toHaveBeenCalled();
  });
});
