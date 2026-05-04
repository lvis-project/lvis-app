import { describe, expect, it } from "vitest";
import { getDetachedMainClassName, getDetachedShellClassName } from "../DetachedView.js";

describe("DetachedView layout contract", () => {
  it("renders plugin detached views full-bleed without host padding", () => {
    const className = getDetachedMainClassName("plugin:agent-hub:agent-hub-panel");

    expect(className).toContain("overflow-hidden");
    expect(className).not.toMatch(/\bp-4\b/);
    expect(className).not.toMatch(/\bbg-background\b/);
    expect(getDetachedShellClassName("plugin:agent-hub:agent-hub-panel")).not.toMatch(
      /\bbg-background\b/,
    );
  });

  it("keeps host detached views padded and on host background", () => {
    expect(getDetachedMainClassName("tasks")).toMatch(/\bp-4\b/);
    expect(getDetachedShellClassName("tasks")).toMatch(/\bbg-background\b/);
  });
});
