/**
 * AuditTab — the date picker and the row timestamps are HOST-LOCAL. The audit
 * store partitions by UTC day, and the picker used to seed its inputs from the
 * same UTC key, so a host east of UTC showed yesterday as "today" for the
 * first hours of every day.
 *
 * Every case pins `TZ`: CI runs UTC, where local and UTC days coincide and the
 * defect cannot show. Only `Date` is faked so testing-library's `waitFor` keeps
 * real timers.
 */
import "../../../../../test/renderer/setup.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { installMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";
import { formatMediumDateTime } from "../../../../shared/format-time.js";
import type { AuditEntry } from "../../../../audit/audit-logger.js";

vi.mock("../DiagnosticsSection.js", () => ({ DiagnosticsSection: () => null }));
vi.mock("../TelemetrySection.js", () => ({ TelemetrySection: () => null }));

import { AuditTab } from "../AuditTab.js";

/** 01:30 on the 16th in Seoul, 12:30 on the 15th in New York, 16:30 on the 15th in UTC. */
const SEOUL_SMALL_HOURS = Date.parse("2026-06-15T16:30:00.000Z");
/** 21:00 on the 15th in New York (EDT), already the 16th in UTC. */
const NEW_YORK_EVENING = Date.parse("2026-06-16T01:00:00.000Z");

let previousTz: string | undefined;

beforeEach(() => {
  previousTz = process.env.TZ;
});

afterEach(() => {
  vi.useRealTimers();
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

function installAuditApi(entries: AuditEntry[] = []) {
  const api = installMockLvisApi();
  const search = vi.fn(async (_filter: unknown) => ({ entries, total: entries.length }));
  const getStats = vi.fn(async () => ({ totalByType: {}, totalByDay: {}, sensitiveOps: 0 }));
  (api as Record<string, unknown>).audit = { search, getStats };
  return { search };
}

function renderAt(zone: string, now: number) {
  process.env.TZ = zone;
  vi.useFakeTimers({ toFake: ["Date"], now });
  const view = render(<AuditTab />);
  return {
    ...view,
    from: view.getByTestId("audit-date-from") as HTMLInputElement,
    to: view.getByTestId("audit-date-to") as HTMLInputElement,
  };
}

describe("AuditTab date picker", () => {
  it("seeds the picker with the host-local day on a Seoul host in the small hours", async () => {
    const { search } = installAuditApi();
    const { from, to } = renderAt("Asia/Seoul", SEOUL_SMALL_HOURS);
    expect(to.value).toBe("2026-06-16");
    expect(from.value).toBe("2026-06-09");
    await waitFor(() => expect(search).toHaveBeenCalled());
    expect(search.mock.calls[0][0]).toMatchObject({ dateFrom: "2026-06-09", dateTo: "2026-06-16" });
  });

  it("keeps a New York evening on its local day after UTC has rolled over", () => {
    installAuditApi();
    const { from, to } = renderAt("America/New_York", NEW_YORK_EVENING);
    expect(to.value).toBe("2026-06-15");
    expect(from.value).toBe("2026-06-08");
  });

  it("control: under UTC the seed is the UTC day", () => {
    installAuditApi();
    const { to } = renderAt("UTC", SEOUL_SMALL_HOURS);
    expect(to.value).toBe("2026-06-15");
  });
});

describe("AuditTab row timestamps", () => {
  it("renders each row's instant in the host zone rather than as the stored UTC string", async () => {
    const timestamp = "2026-06-15T16:30:00.000Z";
    installAuditApi([
      { timestamp, sessionId: "session-1", type: "turn", input: "hello", output: "world" },
    ]);
    process.env.TZ = "UTC";
    const utcLabel = formatMediumDateTime(timestamp);
    const { findByTestId } = renderAt("Asia/Seoul", SEOUL_SMALL_HOURS);
    const seoulLabel = formatMediumDateTime(timestamp);
    expect(seoulLabel).not.toBe(utcLabel);
    const cell = await findByTestId("audit-row-time");
    expect(cell.textContent).toBe(seoulLabel);
    expect(cell.textContent).not.toContain("2026-06-15T16:30");
  });
});
