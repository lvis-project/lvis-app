import "../../../../test/renderer/setup.js";
import { beforeEach, describe, it, expect } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { DayDivider } from "../components/DayDivider.js";
import { preloadCalendar } from "../components/LazyCalendar.js";

describe("DayDivider", () => {
  beforeEach(async () => {
    await preloadCalendar();
  });

  it("opens the calendar with the divider date selected", async () => {
    const { getByRole } = render(<DayDivider dateKey="2026-05-06" />);

    fireEvent.click(getByRole("button", { name: /2026-05-06/ }));

    await waitFor(() => {
      const selected = Array.from(document.querySelectorAll('[class*="bg-primary"]'))
        .find((el) => el.textContent?.trim() === "6");
      expect(selected?.textContent?.trim()).toBe("6");
    }, { timeout: 5_000 });
  });

  it("updates the selected calendar day when the divider date changes", async () => {
    const { getByRole, rerender } = render(<DayDivider dateKey="2026-05-06" />);

    rerender(<DayDivider dateKey="2026-05-07" />);
    fireEvent.click(getByRole("button", { name: /2026-05-07/ }));

    await waitFor(() => {
      const selected = Array.from(document.querySelectorAll('[class*="bg-primary"]'))
        .find((el) => el.textContent?.trim() === "7");
      expect(selected?.textContent?.trim()).toBe("7");
    }, { timeout: 5_000 });
  });

  it("uses the KST day key when filtering sessions around UTC boundaries", async () => {
    const { getByRole, findByText } = render(
      <DayDivider
        dateKey="2026-05-06"
        sessions={[
          {
            id: "session-kst",
            title: "자정 이후 KST 대화",
            modifiedAt: "2026-05-05T15:30:00.000Z",
          },
        ]}
      />,
    );

    fireEvent.click(getByRole("button", { name: /2026-05-06/ }));

    expect(await findByText("자정 이후 KST 대화")).toBeTruthy();
  });
});
