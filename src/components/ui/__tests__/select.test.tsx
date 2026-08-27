// @vitest-environment jsdom
/**
 * The select popup's default placement.
 *
 * Radix's own default is `position="item-aligned"`: the popup sizes itself to
 * its widest row and anchors the SELECTED row over the trigger, so the control
 * vanishes behind its own menu and the panel's edges do not line up with the
 * field. Two settings tabs each hit that and wrote their own
 * `position="popper"` + `w-(--radix-select-trigger-width)` override with nearly
 * the same comment — the signature of a wrong default. It is the default here
 * now, and these assertions are what stops it from drifting back.
 */
import "../../../../test/renderer/setup.js";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../select.js";

function renderOpen(contentClassName?: string) {
  return render(
    <Select open defaultValue="a">
      <SelectTrigger className="w-full text-[11px]" data-testid="trigger">
        <SelectValue />
      </SelectTrigger>
      <SelectContent {...(contentClassName ? { className: contentClassName } : {})}>
        <SelectItem value="a" data-testid="item-a">아이템 A</SelectItem>
        <SelectItem value="b">아이템 B</SelectItem>
      </SelectContent>
    </Select>,
  );
}

describe("SelectContent placement", () => {
  it("hangs under the trigger at the trigger's width, instead of covering it", () => {
    renderOpen();
    const content = document.querySelector('[data-slot="select-content"]')!;
    expect(content).toBeTruthy();
    // `popper` is what puts the panel BELOW the control rather than over it.
    expect(content.getAttribute("data-align-trigger")).toBe("false");
    expect(content.className).toContain("w-(--radix-select-trigger-width)");
  });

  it("insets its rows, so a highlighted row does not collide with the panel's corner", () => {
    renderOpen();
    const content = document.querySelector('[data-slot="select-content"]')!;
    expect(content.className).toContain("p-1");
  });

  it("lets rows follow the panel's text size rather than pinning their own", () => {
    // A dense settings field is 11px; a menu that opens from it reading 14px is
    // the panel disagreeing with the control it belongs to.
    renderOpen("text-[11px]");
    const item = screen.getByTestId("item-a");
    expect(item.className).toContain("text-inherit");
    expect(item.className).not.toContain("text-sm");
    expect(document.querySelector('[data-slot="select-content"]')!.className).toContain("text-[11px]");
  });

  it("still lets a caller ask for the trigger-covering placement", () => {
    render(
      <Select open defaultValue="a">
        <SelectTrigger data-testid="trigger"><SelectValue /></SelectTrigger>
        <SelectContent position="item-aligned">
          <SelectItem value="a">아이템 A</SelectItem>
        </SelectContent>
      </Select>,
    );
    const content = document.querySelector('[data-slot="select-content"]')!;
    expect(content.getAttribute("data-align-trigger")).toBe("true");
  });
});
