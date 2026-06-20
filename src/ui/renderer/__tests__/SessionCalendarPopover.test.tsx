/**
 * SessionCalendarPopover — Step 1..6 enhancement coverage.
 *
 * Each describe block maps to one of the 6 implementation steps the user
 * specified (`데이디바이더 8단계 케이스를 커버할 수 있도록 6단계 구현`).
 *
 * The popover renders inside a Radix Popover; tests must open it (controlled
 * via the `open` prop) and assert against the rendered DOM.
 */
import "../../../../test/renderer/setup.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { Popover, PopoverTrigger } from "../../../components/ui/popover.js";
import {
  SessionCalendarPopover,
  type SessionCalendarPopoverProps,
} from "../components/SessionCalendarPopover.js";
import { preloadCalendar } from "../components/LazyCalendar.js";

async function renderOpenPopover(props: Partial<SessionCalendarPopoverProps> = {}) {
  // Radix Popover requires an explicit click in jsdom — `defaultOpen` alone
  // doesn't reliably mount the content portal. Provide onLoadSession by default
  // so session buttons aren't disabled by the !onLoadSession guard in tests
  // that don't override it.
  const filled = { onLoadSession: () => {}, ...props };
  const utils = render(
    <Popover>
      <PopoverTrigger>open</PopoverTrigger>
      <SessionCalendarPopover {...filled} />
    </Popover>,
  );
  fireEvent.click(utils.getByText("open"));
  // Wait for the calendar inside the popover to land in the DOM.
  await utils.findByRole("grid", {}, { timeout: 5_000 });
  return utils;
}

describe("SessionCalendarPopover", () => {
  beforeAll(async () => {
    // Calendar is lazy-loaded; tests need it resolved before assertions.
    await preloadCalendar();
  }, 30_000);

  describe("Step 3 — legacy session warning", () => {
    it("renders the warning when entries exist but none carry createdAt", async () => {
      const { findByText } = await renderOpenPopover({
        currentSessionEntries: [{ idx: 0 }, { idx: 1 }, { idx: 2 }],
      });
      expect(await findByText(/시각 정보가 없어 날짜별 점프 불가/)).toBeTruthy();
    });

    it("suppresses the warning when at least one entry has createdAt", async () => {
      // renderOpenPopover already awaits grid mount; the popover content
      // (including warning region) is in the DOM by the time it resolves.
      const { queryByText } = await renderOpenPopover({
        currentSessionEntries: [{ idx: 0, createdAt: Date.now() }, { idx: 1 }],
      });
      expect(queryByText(/시각 정보가 없어 날짜별 점프 불가/)).toBeNull();
    });

    it("suppresses the warning when there are no entries at all", async () => {
      const { queryByText } = await renderOpenPopover({
        currentSessionEntries: [],
      });
      expect(queryByText(/시각 정보가 없어 날짜별 점프 불가/)).toBeNull();
    });
  });

  describe("Step 4 — multi-day jump button + cycle", () => {
    function makeKstNoonMs(yyyyMmDd: string): number {
      // KST noon for a given YYYY-MM-DD avoids edge issues at midnight.
      const [y, m, d] = yyyyMmDd.split("-").map(Number);
      // KST = UTC+9 ⇒ KST noon == UTC 03:00 of the same date.
      return Date.UTC(y!, m! - 1, d!, 3, 0, 0);
    }

    it("renders the jump button when current-session messages exist on the selected date", async () => {
      const dateMs = makeKstNoonMs("2026-05-15");
      const { findByText } = await renderOpenPopover({
        initialDate: new Date(dateMs),
        currentSessionEntries: [
          { idx: 4, createdAt: dateMs },
          { idx: 5, createdAt: dateMs + 60_000 },
        ],
        onJumpToEntry: vi.fn(),
      });
      expect(await findByText(/현재 대화의 2개 메시지로 이동/)).toBeTruthy();
    });

    it("invokes onJumpToEntry with the FIRST matching entry index on initial click", async () => {
      const dateMs = makeKstNoonMs("2026-05-15");
      const onJumpToEntry = vi.fn();
      const { findByText } = await renderOpenPopover({
        initialDate: new Date(dateMs),
        currentSessionEntries: [
          { idx: 7, createdAt: dateMs },
          { idx: 9, createdAt: dateMs + 30_000 },
        ],
        onJumpToEntry,
      });
      const btn = await findByText(/현재 대화의 2개 메시지로 이동/);
      fireEvent.click(btn);
      expect(onJumpToEntry).toHaveBeenCalledWith(7);
    });

    it("cycles to the next matching entry on re-click", async () => {
      const dateMs = makeKstNoonMs("2026-05-15");
      const onJumpToEntry = vi.fn();
      const { findByText } = await renderOpenPopover({
        // Popover stays open so the user can re-click. Don't pass onOpenChange.
        initialDate: new Date(dateMs),
        currentSessionEntries: [
          { idx: 11, createdAt: dateMs },
          { idx: 12, createdAt: dateMs + 30_000 },
          { idx: 13, createdAt: dateMs + 60_000 },
        ],
        onJumpToEntry,
      });
      const btn = await findByText(/현재 대화의 3개 메시지로 이동/);
      fireEvent.click(btn);
      fireEvent.click(btn);
      fireEvent.click(btn);
      expect(onJumpToEntry).toHaveBeenNthCalledWith(1, 11);
      expect(onJumpToEntry).toHaveBeenNthCalledWith(2, 12);
      expect(onJumpToEntry).toHaveBeenNthCalledWith(3, 13);
    });

    it("suppresses the jump button when no current-session messages exist on the date", async () => {
      const dateMs = makeKstNoonMs("2026-05-15");
      const otherDayMs = makeKstNoonMs("2026-05-14");
      const { findByText, queryByText } = await renderOpenPopover({
        initialDate: new Date(dateMs),
        currentSessionEntries: [{ idx: 0, createdAt: otherDayMs }],
        onJumpToEntry: vi.fn(),
      });
      await findByText(/2026-05-15 대화/);
      expect(queryByText(/현재 대화의/)).toBeNull();
    });

    it("suppresses the jump button when onJumpToEntry callback is not provided", async () => {
      const dateMs = makeKstNoonMs("2026-05-15");
      const { findByText, queryByText } = await renderOpenPopover({
        initialDate: new Date(dateMs),
        currentSessionEntries: [{ idx: 0, createdAt: dateMs }],
        // onJumpToEntry intentionally omitted
      });
      await findByText(/2026-05-15 대화/);
      expect(queryByText(/현재 대화의/)).toBeNull();
    });

    it("suppresses the jump button for legacy sessions even when entries match the date", async () => {
      const dateMs = makeKstNoonMs("2026-05-15");
      const { findByText, queryByText } = await renderOpenPopover({
        initialDate: new Date(dateMs),
        // All entries have no createdAt → isLegacySession === true → no jump.
        currentSessionEntries: [{ idx: 0 }, { idx: 1 }],
        onJumpToEntry: vi.fn(),
      });
      await findByText(/시각 정보가 없어 날짜별 점프 불가/);
      expect(queryByText(/현재 대화의/)).toBeNull();
    });
  });

  describe("Step 5 — primary-tone visual for current session", () => {
    it("applies bg-primary/(--opacity-soft) + ring to the row whose id matches currentSessionId", async () => {
      const sessions = [
        { id: "session-a", title: "다른 대화", modifiedAt: "2026-05-15T03:00:00.000Z" },
        { id: "current-session", title: "현재 대화", modifiedAt: "2026-05-15T03:30:00.000Z" },
      ];
      const { findByText } = await renderOpenPopover({
        sessions,
        currentSessionId: "current-session",
        initialDate: new Date(Date.UTC(2026, 4, 15, 3)), // 2026-05-15 KST
      });
      const currentBtn = (await findByText("현재 대화")).closest("button");
      const otherBtn = (await findByText("다른 대화")).closest("button");
      expect(currentBtn?.className).toMatch(/bg-primary\/\(--opacity-soft\)/);
      expect(currentBtn?.className).toMatch(/ring-1/);
      expect(otherBtn?.className).not.toMatch(/bg-primary\/\(--opacity-soft\)/);
    });
  });

  describe("Step 6 — verified existing helpers", () => {
    it("disables future dates (Step 2 / edge case 1)", async () => {
      // A date in the far future should be marked disabled in the calendar.
      const { findAllByRole } = await renderOpenPopover({});
      const dayButtons = await findAllByRole("gridcell");
      // react-day-picker renders disabled days with `aria-disabled="true"` OR
      // a `disabled` attribute on the inner button. Check both.
      const futureMarker = dayButtons.find((cell) => {
        const inner = cell.querySelector("button");
        return inner?.hasAttribute("disabled") || cell.getAttribute("aria-disabled") === "true";
      });
      // There's always at least one disabled future day visible (calendar month grid).
      expect(futureMarker).toBeDefined();
    });

    it("uses streaming guard to disable OTHER-session buttons (edge case 5)", async () => {
      const sessions = [
        { id: "current-session", title: "현재 대화", modifiedAt: "2026-05-15T03:00:00.000Z" },
        { id: "other-session", title: "다른 대화", modifiedAt: "2026-05-15T03:00:00.000Z" },
      ];
      const { findByText } = await renderOpenPopover({
        sessions,
        currentSessionId: "current-session",
        streaming: true,
        initialDate: new Date(Date.UTC(2026, 4, 15, 3)),
      });
      const currentBtn = (await findByText("현재 대화")).closest("button");
      const otherBtn = (await findByText("다른 대화")).closest("button");
      // Current session button stays enabled even while streaming
      // (jumping within the same session is allowed).
      expect(currentBtn).not.toHaveAttribute("disabled");
      // Other session is blocked.
      expect(otherBtn).toHaveAttribute("disabled");
    });
  });
});
