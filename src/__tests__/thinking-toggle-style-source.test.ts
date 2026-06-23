import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

describe("chat Thinking toggle styles", () => {
  it("uses the shadcn/Radix checkbox component with a semantic unchecked square", () => {
    // Thinking moved out of the inline InputActionBar checkbox into the
    // dedicated ThinkingButton popover (toggle + depth) before Send.
    const component = readRepoFile("src/ui/renderer/components/ThinkingButton.tsx");
    const styles = readRepoFile("src/styles.css");
    const checkbox = readRepoFile("src/components/ui/checkbox.tsx");

    expect(component).toContain('import { Checkbox } from "../../../components/ui/checkbox.js"');
    expect(component).not.toContain("bg-white");
    expect(component).not.toContain("thinking-toggle-input");
    expect(component).not.toContain("thinking-toggle-box");
    expect(component).not.toContain("checked:appearance-auto");
    expect(component).not.toContain("bg-muted checked:");
    // shadcn v4 Checkbox uses rounded-[4px] + data-checked:* state attrs.
    expect(checkbox).toContain("rounded-[4px]");
    expect(checkbox).toContain("data-checked:bg-primary");

    expect(styles).not.toContain(".thinking-toggle-input");
    expect(styles).not.toContain(".thinking-toggle-box");
    expect(checkbox).toContain('from "radix-ui"');
    expect(checkbox).toContain("CheckboxPrimitive.Root");
  });
});
