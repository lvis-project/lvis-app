import { describe, expect, it } from "vitest";
import { readRepoFile } from "./test-helpers.js";

describe("chat Thinking toggle styles", () => {
  it("is the reasoning range control, with no trace of the legacy inline checkbox", () => {
    // Thinking on/off and depth are one range control (level 0 = off) in the
    // composer's model card; the inline checkbox it replaced styled itself
    // with hand-rolled `thinking-toggle-*` classes and a hard-coded white.
    const component = readRepoFile("src/ui/renderer/components/ReasoningSlider.tsx");
    const styles = readRepoFile("src/styles.css");

    expect(component).toContain('type="range"');
    expect(component).toContain("accent-primary");
    expect(component).not.toContain("bg-white");
    expect(component).not.toContain("thinking-toggle-input");
    expect(component).not.toContain("thinking-toggle-box");
    expect(component).not.toContain("checked:appearance-auto");

    expect(styles).not.toContain(".thinking-toggle-input");
    expect(styles).not.toContain(".thinking-toggle-box");
  });
});
