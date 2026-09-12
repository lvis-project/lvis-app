import { describe, expect, it } from "vitest";
import { getLlmThinkingBudgetRungs } from "../shared/llm-vendor-defaults.js";
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
    // thinking being OFF. Check the complete preset ladder, including depths
    // hidden by the default output ceiling, against the actual stylesheet.
    const rungs = getLlmThinkingBudgetRungs(Number.MAX_SAFE_INTEGER);
    const styles = readRepoFile("src/styles.css");

    const fills = Array.from(styles.matchAll(/^\s*(--reasoning-fill-\d+):/gmu), (match) => match[1]);
    expect(rungs.length).toBeGreaterThan(0);
    expect(fills).toEqual(rungs.map((_, index) => `--reasoning-fill-${index + 1}`));
  });

  it("keeps the depth ramp inside the yellow window it documents", () => {
    // The ramp's own comment says a step past hue 42 lands in orange, which is
    // what `--warning` means elsewhere. Every used colour must stay in that
    // window, so assert its hue rather than its lightness.
    const styles = readRepoFile("src/styles.css");
    const ramp = Array.from(styles.matchAll(/--reasoning-fill-\d+:\s*hsl\(var\((--p-yellow-\d+)\)\);/gu), (match) => {
      const m = styles.match(new RegExp(`${match[1]}:\\s*(\\d+)`, "u"));
      return m ? Number(m[1]) : NaN;
    });
    expect(ramp).toHaveLength(getLlmThinkingBudgetRungs(Number.MAX_SAFE_INTEGER).length);
    expect(ramp.every((hue) => hue >= 42 && hue <= 48)).toBe(true);
  });
});
