/**
 * The card-size bounds SoT. `ui/notifications/size-changed` and the tool result's
 * `_meta.ui.height` are UNTRUSTED numbers, and CSS cannot bound them (the card's
 * containing block has an indefinite height, so `max-height: 100%` resolves to `none`).
 * These are the arithmetic bounds that actually hold.
 */
import { describe, it, expect } from "vitest";
import {
  clampMcpAppCardSize,
  mcpAppCardSeedHeight,
  MCP_APP_CARD_DEFAULT_HEIGHT_PX,
  MCP_APP_CARD_MAX_HEIGHT_PX,
  MCP_APP_CARD_MAX_WIDTH_PX,
  MCP_APP_CARD_MIN_HEIGHT_PX,
  MCP_APP_CARD_MIN_WIDTH_PX,
} from "../mcp-app-card-size.js";

const prev = { height: 300 } as const;

describe("clampMcpAppCardSize", () => {
  it("applies a reasonable content-driven size unchanged", () => {
    expect(clampMcpAppCardSize({ width: 640, height: 480 }, prev)).toEqual({ width: 640, height: 480 });
  });

  it("CLAMPS an absurd height instead of applying it (the transcript stays reachable)", () => {
    expect(clampMcpAppCardSize({ height: 10_000_000 }, prev)).toEqual({
      width: undefined,
      height: MCP_APP_CARD_MAX_HEIGHT_PX,
    });
  });

  it("clamps an absurd width and a sub-minimal size", () => {
    expect(clampMcpAppCardSize({ width: 10_000_000, height: 1 }, prev)).toEqual({
      width: MCP_APP_CARD_MAX_WIDTH_PX,
      height: MCP_APP_CARD_MIN_HEIGHT_PX,
    });
    expect(clampMcpAppCardSize({ width: 2 }, prev)).toEqual({
      width: MCP_APP_CARD_MIN_WIDTH_PX,
      height: 300,
    });
  });

  it("REFUSES non-finite / non-positive / non-numeric values — the card keeps its size", () => {
    const current = { width: 500, height: 400 };
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, "600" as unknown as number]) {
      expect(clampMcpAppCardSize({ height: bad }, current), `height=${String(bad)}`).toEqual(current);
      expect(clampMcpAppCardSize({ width: bad }, current), `width=${String(bad)}`).toEqual(current);
    }
  });

  it("keeps the dimension a partial notification omitted", () => {
    expect(clampMcpAppCardSize({ height: 512 }, { width: 500, height: 400 })).toEqual({ width: 500, height: 512 });
    expect(clampMcpAppCardSize({ width: 640 }, { width: 500, height: 400 })).toEqual({ width: 640, height: 400 });
    expect(clampMcpAppCardSize({}, { width: 500, height: 400 })).toEqual({ width: 500, height: 400 });
  });

  it("rounds to whole pixels", () => {
    expect(clampMcpAppCardSize({ height: 480.6 }, prev).height).toBe(481);
  });
});

describe("mcpAppCardSeedHeight", () => {
  it("bounds the SERVER-declared seed with the same rule as a live resize", () => {
    expect(mcpAppCardSeedHeight(10_000_000)).toBe(MCP_APP_CARD_MAX_HEIGHT_PX);
    expect(mcpAppCardSeedHeight(1)).toBe(MCP_APP_CARD_MIN_HEIGHT_PX);
    expect(mcpAppCardSeedHeight(420)).toBe(420);
  });

  it("falls back to the default for a missing or unusable seed", () => {
    expect(mcpAppCardSeedHeight(undefined)).toBe(MCP_APP_CARD_DEFAULT_HEIGHT_PX);
    expect(mcpAppCardSeedHeight(Number.NaN)).toBe(MCP_APP_CARD_DEFAULT_HEIGHT_PX);
    expect(mcpAppCardSeedHeight(-10)).toBe(MCP_APP_CARD_DEFAULT_HEIGHT_PX);
    expect(mcpAppCardSeedHeight("300")).toBe(MCP_APP_CARD_DEFAULT_HEIGHT_PX);
  });
});
