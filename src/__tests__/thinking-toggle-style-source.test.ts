import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

describe("chat Thinking toggle styles", () => {
  it("uses the shadcn/Radix checkbox component with a white unchecked square", () => {
    const component = readRepoFile("src/ui/renderer/components/InputActionBar.tsx");
    const styles = readRepoFile("src/styles.css");
    const checkbox = readRepoFile("src/components/ui/checkbox.tsx");

    expect(component).toContain('import { Checkbox } from "../../../components/ui/checkbox.js"');
    expect(component).toContain("data-[state=unchecked]:bg-white");
    expect(component).toContain("rounded-[2px]");
    expect(component).not.toContain("thinking-toggle-input");
    expect(component).not.toContain("thinking-toggle-box");
    expect(component).not.toContain("checked:appearance-auto");
    expect(component).not.toContain("bg-muted checked:");

    expect(styles).not.toContain(".thinking-toggle-input");
    expect(styles).not.toContain(".thinking-toggle-box");
    expect(checkbox).toContain('@radix-ui/react-checkbox');
    expect(checkbox).toContain("CheckboxPrimitive.Root");
  });
});
