import "../../../../test/renderer/setup.js";
import { beforeAll, describe, it, expect, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { SessionDateNavigator } from "../components/SessionDateNavigator.js";
import { preloadCalendar } from "../components/LazyCalendar.js";

describe("SessionDateNavigator", () => {
  beforeAll(async () => {
    await preloadCalendar();
  }, 30_000);

  it("opens the calendar with the divider date selected", async () => {
    const { findByText, getByRole } = render(<SessionDateNavigator dateKey="2026-05-06" />);

    fireEvent.click(getByRole("button", { name: /2026-05-06/ }));

    expect(await findByText("2026-05-06 대화", {}, { timeout: 5_000 })).toBeTruthy();
  });

  it("updates the selected calendar day when the divider date changes", async () => {
    const { findByText, getByRole, rerender } = render(<SessionDateNavigator dateKey="2026-05-06" />);

    rerender(<SessionDateNavigator dateKey="2026-05-07" />);
    fireEvent.click(getByRole("button", { name: /2026-05-07/ }));

    expect(await findByText("2026-05-07 대화", {}, { timeout: 5_000 })).toBeTruthy();
  });

  it("uses the KST day key when filtering sessions around UTC boundaries", async () => {
    const { getByRole, findByText } = render(
      <SessionDateNavigator
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

  it("notifies session selection even for the current session", async () => {
    const onLoadSession = vi.fn();
    const { getByRole, findByText } = render(
      <SessionDateNavigator
        dateKey="2026-05-06"
        currentSessionId="current-session"
        onLoadSession={onLoadSession}
        sessions={[
          {
            id: "current-session",
            title: "현재 대화",
            modifiedAt: "2026-05-06T01:00:00.000Z",
          },
        ]}
      />,
    );

    fireEvent.click(getByRole("button", { name: /2026-05-06/ }));
    fireEvent.click(await findByText("현재 대화"));

    expect(onLoadSession).toHaveBeenCalledWith("current-session");
  });
});
