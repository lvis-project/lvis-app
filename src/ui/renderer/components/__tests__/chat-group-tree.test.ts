import { describe, expect, it } from "vitest";
import {
  closeLeaf,
  countLeaves,
  layoutBoxes,
  leaf,
  leafIds,
  splitLeaf,
  type ChatGroupNode,
} from "../chat-group-tree.js";

const main = leaf("main");

describe("splitLeaf", () => {
  it("puts the new tile on the side it was dropped on", () => {
    const right = splitLeaf(main, "main", "right", "group-2");
    const left = splitLeaf(main, "main", "left", "group-2");

    expect(leafIds(right)).toEqual(["main", "group-2"]);
    expect(leafIds(left)).toEqual(["group-2", "main"]);
  });

  it("splits along the axis the edge implies", () => {
    const side = splitLeaf(main, "main", "right", "group-2") as Extract<ChatGroupNode, { kind: "split" }>;
    const below = splitLeaf(main, "main", "bottom", "group-2") as Extract<ChatGroupNode, { kind: "split" }>;

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
    const three = splitLeaf(two, "group-2", "right", "group-3") as Extract<ChatGroupNode, { kind: "split" }>;

    expect(three.kind).toBe("split");
    expect(three.children.every((child) => child.kind === "leaf")).toBe(true);
    expect(leafIds(three)).toEqual(["main", "group-2", "group-3"]);
  });

  it("leaves the tree alone when the target is not in it", () => {
    expect(splitLeaf(main, "group-9", "right", "group-2")).toEqual(main);
  });

  it("reaches a 2x2 whose four tiles each take a quarter", () => {
    let tree: ChatGroupNode = splitLeaf(main, "main", "right", "group-2");
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
    let tree: ChatGroupNode = splitLeaf(main, "main", "right", "group-2");
    tree = splitLeaf(tree, "main", "bottom", "group-3");

    const area = layoutBoxes(tree).reduce((sum, b) => sum + b.width * b.height, 0);
    expect(area).toBeCloseTo(100 * 100, 6);
  });
});
