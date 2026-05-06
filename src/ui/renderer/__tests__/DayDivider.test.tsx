import "../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { DayDivider } from "../components/DayDivider.js";

describe("DayDivider", () => {
  it("opens the calendar with the divider date selected", async () => {
    const { getByRole } = render(<DayDivider dateKey="2026-05-06" />);

    fireEvent.click(getByRole("button", { name: /2026-05-06/ }));

    await waitFor(() => {
      const selected = Array.from(document.querySelectorAll('[class*="bg-primary"]'))
        .find((el) => el.textContent?.trim() === "6");
      expect(selected?.textContent?.trim()).toBe("6");
    });
  });
});
