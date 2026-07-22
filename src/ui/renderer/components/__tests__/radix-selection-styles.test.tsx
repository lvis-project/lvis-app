// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Checkbox } from "../../../../components/ui/checkbox.js";
import { RadioGroup, RadioGroupItem } from "../../../../components/ui/radio-group.js";
import { Switch } from "../../../../components/ui/switch.js";

describe("Radix selection styles", () => {
  it("aligns Switch classes with the data-state emitted by Radix", () => {
    const { container } = render(<Switch aria-label="Enabled" />);
    const root = container.querySelector<HTMLElement>('[data-slot="switch"]');
    const thumb = container.querySelector<HTMLElement>('[data-slot="switch-thumb"]');

    expect(root).toHaveAttribute("data-state", "unchecked");
    expect(root?.className).toContain("data-[state=checked]:bg-primary");
    expect(root?.className).toContain("data-[state=unchecked]:bg-input");
    expect(thumb?.className).toContain(
      "group-data-[state=checked]/switch:translate-x-[calc(100%-2px)]"
    );

    fireEvent.click(root!);
    expect(root).toHaveAttribute("data-state", "checked");
  });

  it("aligns RadioGroup classes with the checked item state", () => {
    const { getByRole } = render(
      <RadioGroup defaultValue="first">
        <RadioGroupItem value="first" aria-label="First" />
        <RadioGroupItem value="second" aria-label="Second" />
      </RadioGroup>
    );
    const first = getByRole("radio", { name: "First" });
    const second = getByRole("radio", { name: "Second" });

    expect(first).toHaveAttribute("data-state", "checked");
    expect(first.className).toContain("data-[state=checked]:border-primary");
    fireEvent.click(second);
    expect(first).toHaveAttribute("data-state", "unchecked");
    expect(second).toHaveAttribute("data-state", "checked");
  });

  it("aligns Checkbox classes with checked and unchecked states", () => {
    const { getByRole } = render(<Checkbox aria-label="Thinking" />);
    const checkbox = getByRole("checkbox", { name: "Thinking" });

    expect(checkbox).toHaveAttribute("data-state", "unchecked");
    expect(checkbox.className).toContain("data-[state=checked]:bg-primary");
    fireEvent.click(checkbox);
    expect(checkbox).toHaveAttribute("data-state", "checked");
  });
});
