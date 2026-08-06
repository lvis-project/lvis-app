// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { UserMessageEditor } from "../UserMessageEditor.js";

function renderEditor() {
  const onCancel = vi.fn();
  const onSave = vi.fn();
  const { container } = render(
    <UserMessageEditor
      initialText="ep 세션 유지 시간 확인할 수 있나?"
      onCancel={onCancel}
      onSave={onSave}
      busy={false}
    />,
  );
  return { container, onCancel, onSave };
}

describe("UserMessageEditor frame", () => {
  // The bubble is the input frame. The Textarea inside used to keep the shared
  // primitive's `border border-input` plus its own focus ring, which drew a
  // second rounded box inside the bubble.
  it("draws exactly one frame — the bubble, not a box inside a box", () => {
    const { container } = renderEditor();
    const bubble = container.firstElementChild as HTMLElement;
    const textarea = screen.getByRole("textbox");

    expect(bubble.className).toMatch(/(?:^|\s)border(?:\s|$)/);
    expect(bubble.className).toContain("border-message-user-border");

    // The inner control contributes no border WIDTH (tailwind-merge keeps the
    // inert `border-input` colour, which paints nothing at zero width) and no
    // second focus ring.
    expect(textarea.className).toContain("border-0");
    expect(textarea.className).not.toMatch(/(?:^|\s)border(?:\s|$)/);
    expect(textarea.className).toContain("focus-visible:ring-0");
    expect(textarea.className).toContain("bg-transparent");
  });

  it("moves the focus affordance to the bubble so focus is still visible", () => {
    const { container } = renderEditor();
    const bubble = container.firstElementChild as HTMLElement;
    expect(bubble.className).toContain("focus-within:ring-1");
    expect(bubble.className).toContain("focus-within:border-message-user-action");
  });
});
