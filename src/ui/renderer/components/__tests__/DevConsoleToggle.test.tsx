// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DevConsoleToggle } from "../DevConsoleToggle.js";

const init = vi.fn();
const show = vi.fn();
const hide = vi.fn();

vi.mock("eruda", () => ({
  default: { init, show, hide },
}));

describe("DevConsoleToggle", () => {
  beforeEach(() => {
    init.mockClear();
    show.mockClear();
    hide.mockClear();
    window.lvis = {
      ...(window.lvis ?? {}),
      env: { isDev: true, enableDevConsole: true },
    };
  });

  it("renders nothing when dev console is disabled", () => {
    window.lvis = {
      ...(window.lvis ?? {}),
      env: { isDev: true, enableDevConsole: false },
    };
    const { container } = render(<DevConsoleToggle />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a floating button and toggles eruda on click", async () => {
    render(<DevConsoleToggle />);

    const button = screen.getByRole("button", { name: "개발 콘솔 열기" });
    fireEvent.click(button);

    await waitFor(() => {
      expect(init).toHaveBeenCalledTimes(1);
      expect(show).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "개발 콘솔 숨기기" }));

    await waitFor(() => {
      expect(hide).toHaveBeenCalled();
    });
  });
});
