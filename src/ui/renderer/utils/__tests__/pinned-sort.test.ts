import { describe, expect, it } from "vitest";
import { sortWithPinnedFirst } from "../pinned-sort.js";

describe("sortWithPinnedFirst", () => {
  it("moves pinned items to the front, preserving their relative order", () => {
    const items = ["a", "b-pinned", "c", "d-pinned", "e"];
    const isPinned = (item: string) => item.endsWith("-pinned");

    expect(sortWithPinnedFirst(items, isPinned)).toEqual([
      "b-pinned",
      "d-pinned",
      "a",
      "c",
      "e",
    ]);
  });

  it("preserves the existing (recency) order within the unpinned group when nothing is pinned", () => {
    const items = [3, 1, 2];
    expect(sortWithPinnedFirst(items, () => false)).toEqual([3, 1, 2]);
  });

  it("keeps the full recency order when everything is pinned", () => {
    const items = ["x", "y", "z"];
    expect(sortWithPinnedFirst(items, () => true)).toEqual(["x", "y", "z"]);
  });

  it("returns unpinned items unmoved relative to each other after unpinning (order reverts)", () => {
    // Simulates: item was pinned (sorted to front), then unpinned — a
    // re-sort with the updated isPinned predicate must return it to its
    // original recency-order position among the (now all-unpinned) items.
    const items = ["first", "second", "third"];
    const pinnedState = new Set(["second"]);

    const withPin = sortWithPinnedFirst(items, (i) => pinnedState.has(i));
    expect(withPin).toEqual(["second", "first", "third"]);

    pinnedState.delete("second");
    const afterUnpin = sortWithPinnedFirst(items, (i) => pinnedState.has(i));
    expect(afterUnpin).toEqual(["first", "second", "third"]);
  });

  it("does not mutate the input array", () => {
    const items = [1, 2, 3];
    const result = sortWithPinnedFirst(items, (n) => n === 3);
    expect(items).toEqual([1, 2, 3]);
    expect(result).not.toBe(items);
  });

  it("handles an empty list", () => {
    expect(sortWithPinnedFirst([], () => true)).toEqual([]);
  });
});
