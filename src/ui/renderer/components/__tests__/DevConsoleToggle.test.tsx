// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { DevConsoleToggle } from "../DevConsoleToggle.js";

const init = vi.fn();

vi.mock("eruda", () => ({
  default: { init },
}));

describe("DevConsoleToggle", () => {
  beforeEach(() => {
    init.mockClear();
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

  it("boots eruda when dev console is enabled without rendering a custom button", async () => {
    const { container } = render(<DevConsoleToggle />);
    expect(container).toBeEmptyDOMElement();

    await waitFor(() => {
      expect(init).toHaveBeenCalledTimes(1);
    });
  });
});
