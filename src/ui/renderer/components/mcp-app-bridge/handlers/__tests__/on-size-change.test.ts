import { describe, it, expect, vi } from "vitest";
import { createOnSizeChange } from "../on-size-change.js";

describe("createOnSizeChange", () => {
  it("forwards both dimensions to the injected onResize sink", () => {
    const onResize = vi.fn();
    const handler = createOnSizeChange({ onResize });

    handler({ width: 640, height: 480 });

    expect(onResize).toHaveBeenCalledWith({ width: 640, height: 480 });
  });

  it("forwards a height-only notification (width undefined) verbatim", () => {
    const onResize = vi.fn();
    const handler = createOnSizeChange({ onResize });

    handler({ height: 512 });

    expect(onResize).toHaveBeenCalledWith({ width: undefined, height: 512 });
  });
});
