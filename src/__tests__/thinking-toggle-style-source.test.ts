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

  it("defines one fill token per depth rung", () => {
    // The gauge reads `var(--reasoning-fill-N)` for the level it is drawing.
    // An undefined custom property is not an error: the fill resolves to
    // nothing and the bulb renders unlit, which is the same picture as
    // thinking being OFF. Every renderer test still passes, so the ladder has
    // to be checked against the stylesheet that has to grow with it.
    const ladder = readRepoFile("src/ui/renderer/constants.ts");
    const styles = readRepoFile("src/styles.css");

    const rungs = ladder.match(/^\s*\{ key: "\w+",.*budget: [\d_]+ \},$/gmu) ?? [];
    expect(rungs).toHaveLength(5);
    for (let n = 1; n <= rungs.length; n += 1) {
      expect(styles).toContain(`--reasoning-fill-${n}:`);
    }
    expect(styles).not.toContain(`--reasoning-fill-${rungs.length + 1}:`);
  });

  it("keeps the depth ramp inside the yellow window it documents", () => {
    // The ramp's own comment says a step past hue 42 lands in orange, which is
    // what `--warning` means elsewhere. The rung added for `max` has to darken
    // without drifting out of that window, so the hue is asserted, not the
    // lightness.
    const styles = readRepoFile("src/styles.css");
    const ramp = ["100", "200", "400", "600", "700"].map((step) => {
      const m = styles.match(new RegExp(`--p-yellow-${step}:\\s*(\\d+)`, "u"));
      return m ? Number(m[1]) : NaN;
    });
    expect(ramp.every((hue) => hue >= 42 && hue <= 48)).toBe(true);
  });
});
