import { describe, expect, it } from "vitest";
import {
  closeLeaf,
  countLeaves,
  layoutBoxes,
  layoutGutters,
  leaf,
  leafIds,
  minimumCanvasHeight,
  resizeGutter,
  splitLeaf,
  type PaneNode,
} from "../pane-tree.js";

const main = leaf("main");

describe("splitLeaf", () => {
  it("puts the new tile on the side it was dropped on", () => {
    const right = splitLeaf(main, "main", "right", "group-2");
    const left = splitLeaf(main, "main", "left", "group-2");

    expect(leafIds(right)).toEqual(["main", "group-2"]);
    expect(leafIds(left)).toEqual(["group-2", "main"]);
  });

  it("splits along the axis the edge implies", () => {
    const side = splitLeaf(main, "main", "right", "group-2") as Extract<PaneNode, { kind: "split" }>;
    const below = splitLeaf(main, "main", "bottom", "group-2") as Extract<PaneNode, { kind: "split" }>;

    expect(side.axis).toBe("row");
    expect(below.axis).toBe("column");
  });

  it("takes half of the dropped-on tile and nothing from the others", () => {
    // A drop should not resize a part of the screen the user was not pointing
    // at: A keeps its half, and B's half is what gets divided.
    const two = splitLeaf(main, "main", "right", "group-2");
    const three = splitLeaf(two, "group-2", "bottom", "group-3");

    const boxes = layoutBoxes(three);
    const byId = Object.fromEntries(boxes.map((b) => [b.chatGroupId, b]));
    expect(byId["main"]).toMatchObject({ left: 0, top: 0, width: 50, height: 100 });
    expect(byId["group-2"]).toMatchObject({ left: 50, top: 0, width: 50, height: 50 });
    expect(byId["group-3"]).toMatchObject({ left: 50, top: 50, width: 50, height: 50 });
  });

  it("flattens a same-axis split so one shape has one representation", () => {
    // Splitting right twice is three columns, not a column holding two.
    const two = splitLeaf(main, "main", "right", "group-2");
    const three = splitLeaf(two, "group-2", "right", "group-3") as Extract<PaneNode, { kind: "split" }>;

    expect(three.kind).toBe("split");
    expect(three.children.every((child) => child.kind === "leaf")).toBe(true);
    expect(leafIds(three)).toEqual(["main", "group-2", "group-3"]);
  });

  it("leaves the tree alone when the target is not in it", () => {
    expect(splitLeaf(main, "group-9", "right", "group-2")).toEqual(main);
  });

  it("reaches a 2x2 whose four tiles each take a quarter", () => {
    let tree: PaneNode = splitLeaf(main, "main", "right", "group-2");
    tree = splitLeaf(tree, "main", "bottom", "group-3");
    tree = splitLeaf(tree, "group-2", "bottom", "group-4");

    expect(countLeaves(tree)).toBe(4);
    for (const box of layoutBoxes(tree)) {
      expect(box.width).toBe(50);
      expect(box.height).toBe(50);
    }
  });
});

describe("closeLeaf", () => {
  it("gives the closed tile's space back to its siblings", () => {
    const two = splitLeaf(main, "main", "right", "group-2");
    const three = splitLeaf(two, "group-2", "bottom", "group-3");

    const closed = closeLeaf(three, "group-3");

    expect(leafIds(closed)).toEqual(["main", "group-2"]);
    const byId = Object.fromEntries(layoutBoxes(closed).map((b) => [b.chatGroupId, b]));
    // group-2 gets its parent's whole half back, not a quarter of the screen.
    expect(byId["group-2"]).toMatchObject({ width: 50, height: 100 });
  });

  it("collapses a split left holding one child", () => {
    const two = splitLeaf(main, "main", "right", "group-2");
    expect(closeLeaf(two, "group-2")).toEqual(main);
  });

  it("refuses to empty the main area", () => {
    // Zero tiles is not a state the rest of the app can render.
    expect(closeLeaf(main, "main")).toEqual(main);
  });

  it("leaves the tree alone when the id is not in it", () => {
    const two = splitLeaf(main, "main", "right", "group-2");
    expect(closeLeaf(two, "group-9")).toEqual(two);
  });
});

describe("layoutBoxes", () => {
  it("tiles the whole area with no gap and no overlap", () => {
    let tree: PaneNode = splitLeaf(main, "main", "right", "group-2");
    tree = splitLeaf(tree, "main", "bottom", "group-3");

    const area = layoutBoxes(tree).reduce((sum, b) => sum + b.width * b.height, 0);
    expect(area).toBeCloseTo(100 * 100, 6);
  });
});

describe("layoutGutters", () => {
  it("puts one gutter on every boundary between siblings, on the split's own axis", () => {
    let tree: PaneNode = splitLeaf(main, "main", "right", "group-2");
    tree = splitLeaf(tree, "main", "bottom", "group-3");

    const gutters = layoutGutters(tree);
    expect(gutters.map((g) => [g.axis, g.left, g.top, g.width, g.height])).toEqual([
      ["column", 0, 50, 50, 0],   // main | group-3, inside the left column
      ["row", 50, 0, 0, 100],     // left column | group-2
    ]);
  });

  it("reports both sides' extents so a caller can turn a pixel floor into a share", () => {
    const tree = splitLeaf(main, "main", "right", "group-2");
    const [gutter] = layoutGutters(tree);
    expect(gutter).toMatchObject({ leading: 50, trailing: 50, path: [], index: 0 });
  });

  it("keeps a gutter's key across a resize, since the shape did not change", () => {
    const tree = splitLeaf(main, "main", "right", "group-2");
    const [before] = layoutGutters(tree);
    const [after] = layoutGutters(resizeGutter(tree, before!, 0.7));
    expect(after!.key).toBe(before!.key);
  });
});

describe("resizeGutter", () => {
  it("moves only the boundary that was held", () => {
    let tree: PaneNode = splitLeaf(main, "main", "right", "group-2");
    tree = splitLeaf(tree, "main", "bottom", "group-3");
    const inner = layoutGutters(tree).find((g) => g.axis === "column")!;

    const resized = resizeGutter(tree, inner, 0.25);

    const box = (id: string) => layoutBoxes(resized).find((b) => b.chatGroupId === id)!;
    expect(box("main").height).toBeCloseTo(25);
    expect(box("group-3").height).toBeCloseTo(75);
    expect(box("group-2")).toMatchObject({ left: 50, width: 50, height: 100 });
  });

  it("leaves the tree alone when the gutter is not in it", () => {
    const tree = splitLeaf(main, "main", "right", "group-2");
    expect(resizeGutter(tree, { path: [3], index: 0 }, 0.3)).toBe(tree);
    expect(resizeGutter(tree, { path: [], index: 5 }, 0.3)).toBe(tree);
  });

  it("clamps the share so neither side goes negative", () => {
    const tree = splitLeaf(main, "main", "right", "group-2");
    const boxes = layoutBoxes(resizeGutter(tree, { path: [], index: 0 }, 1.4));
    expect(boxes.find((b) => b.chatGroupId === "main")!.width).toBeCloseTo(100);
    expect(boxes.find((b) => b.chatGroupId === "group-2")!.width).toBeCloseTo(0);
  });
});

describe("minimumCanvasHeight", () => {
  // Boxes carry PERCENTAGES, the same numbers `areaStyle` writes into the DOM.
  const box = (chatGroupId: string, top: number, height: number) => ({
    chatGroupId,
    left: 0,
    top,
    width: 100,
    height,
  });

  it("is the tile floor itself when one tile has the whole canvas", () => {
    expect(minimumCanvasHeight([box("main", 0, 100)], 250)).toBe(250);
  });

  it("reads the layout in percentages, not fractions", () => {
    // The units are the trap: a fold seeded with 1 would answer 250 for every
    // shape, which is the whole cap silently doing nothing.
    expect(minimumCanvasHeight(layoutBoxes(splitLeaf(main, "main", "bottom", "group-2")), 250)).toBe(500);
  });

  it("multiplies by the rows an even split makes", () => {
    expect(minimumCanvasHeight([box("main", 0, 50), box("group-2", 50, 50)], 250)).toBe(500);
    expect(
      minimumCanvasHeight(
        [box("main", 0, 100 / 3), box("group-2", 100 / 3, 100 / 3), box("group-3", 200 / 3, 100 / 3)],
        250,
      ),
    ).toBe(750);
  });

  it("takes the SHORTEST tile, not the count — an uneven split needs more", () => {
    // A 70/30 drag leaves the short tile binding: 250 / 0.3, not 2 * 250.
    expect(minimumCanvasHeight([box("main", 0, 70), box("group-2", 70, 30)], 250)).toBe(834);
  });

  it("ignores tiles side by side — they share one row's height", () => {
    // A row split gives both children the full height of their row.
    expect(
      minimumCanvasHeight(
        [box("main", 0, 50), box("group-2", 50, 50), box("group-3", 50, 50)],
        250,
      ),
    ).toBe(500);
  });

  it("falls to one tile's floor when there are no boxes at all", () => {
    expect(minimumCanvasHeight([], 250)).toBe(250);
  });
});
