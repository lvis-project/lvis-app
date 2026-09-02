import { describe, expect, it } from "vitest";
import { dropIndicatorStyle, dropTargetAt } from "../pane-drop.js";

const tile = { left: 100, top: 100, width: 400, height: 300 };

describe("dropTargetAt", () => {
  it("reads each edge band as that edge", () => {
    expect(dropTargetAt(tile, { x: 110, y: 250 })).toBe("left");
    expect(dropTargetAt(tile, { x: 490, y: 250 })).toBe("right");
    expect(dropTargetAt(tile, { x: 300, y: 110 })).toBe("top");
    expect(dropTargetAt(tile, { x: 300, y: 390 })).toBe("bottom");
  });

  it("reads the middle as a replace", () => {
    expect(dropTargetAt(tile, { x: 300, y: 250 })).toBe("center");
  });

  it("resolves a corner to one edge instead of flickering between two", () => {
    // Nearest wins: 5px from the left, 10px from the top.
    expect(dropTargetAt(tile, { x: 105, y: 110 })).toBe("left");
    expect(dropTargetAt(tile, { x: 110, y: 105 })).toBe("top");
  });

  it("keeps a middle on a tile too small for a fixed band", () => {
    // A fixed 40px band on a 100px tile would leave 20px of middle; on
    // anything narrower it would vanish, making "replace" unhittable.
    const small = { left: 0, top: 0, width: 100, height: 100 };
    expect(dropTargetAt(small, { x: 50, y: 50 })).toBe("center");
    expect(dropTargetAt(small, { x: 5, y: 50 })).toBe("left");
  });

  it("treats the exact border as an edge, not the middle", () => {
    expect(dropTargetAt(tile, { x: 100, y: 250 })).toBe("left");
  });
});

describe("dropIndicatorStyle", () => {
  it("covers the half the new tile would take", () => {
    expect(dropIndicatorStyle("right")).toMatchObject({ left: "50%", width: "50%" });
    expect(dropIndicatorStyle("bottom")).toMatchObject({ top: "50%", height: "50%" });
  });

  it("covers the whole tile for a replace", () => {
    expect(dropIndicatorStyle("center")).toMatchObject({ width: "100%", height: "100%" });
  });
});
