/**
 * AuditTab renderer tests — renders with mock data, stats, filter, pagination.
 */
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import React from "react";

afterEach(() => {
  vi.unstubAllGlobals();
});

const MOCK_STATS = {
  totalByType: { turn: 5, tool_call: 3, approval: 1 },
  totalByDay: { "2026-04-17": 4, "2026-04-18": 5 },
  sensitiveOps: 1,
};

const MOCK_ENTRIES = [
  {
    timestamp: "2026-04-18T10:00:00.000Z",
    sessionId: "sess-abc",
    type: "turn",
    input: "hello world",
    output: "response",
    route: "claude",
  },
  {
    timestamp: "2026-04-18T11:00:00.000Z",
    sessionId: "sess-abc",
    type: "tool_call",
    input: "read_file",
    output: "ok",
    route: "claude",
  },
  {
    timestamp: "2026-04-18T12:00:00.000Z",
    sessionId: "sess-abc",
    type: "approval",
    input: "approve action",
    output: "approved",
    route: "claude",
  },
];

function makeApi(overrides: {
  searchResult?: { entries: unknown[]; total: number };
  stats?: unknown;
} = {}) {
  return {
    audit: {
      search: vi.fn(async () => overrides.searchResult ?? { entries: MOCK_ENTRIES, total: MOCK_ENTRIES.length }),
      getStats: vi.fn(async () => overrides.stats ?? MOCK_STATS),
    },
  };
}

async function renderAuditTab(api = makeApi()) {
  vi.stubGlobal("lvisApi", api);
  (window as unknown as { lvisApi: typeof api }).lvisApi = api;

  const { AuditTab } = await import("../../src/ui/renderer/tabs/AuditTab.js");
  const result = render(<AuditTab />);
  return { ...result, api };
}

describe("AuditTab", () => {
  it("renders without crashing", async () => {
    const { container } = await renderAuditTab();
    await waitFor(() => expect(container).toBeTruthy());
  });

  it("calls audit.search and audit.getStats on mount", async () => {
    const api = makeApi();
    await renderAuditTab(api);
    await waitFor(() => {
      expect(api.audit.search).toHaveBeenCalledTimes(1);
      expect(api.audit.getStats).toHaveBeenCalledWith(7);
    });
  });

  it("displays stats: total count and sensitive ops", async () => {
    await renderAuditTab();
    await waitFor(() => {
      // total = 5+3+1=9
      const allText = document.body.textContent ?? "";
      expect(allText).toContain("9");
      // sensitive ops label is present
      expect(screen.getByText("민감 작업")).toBeTruthy();
    });
  });

  it("renders result rows for each entry", async () => {
    await renderAuditTab();
    await waitFor(() => {
      expect(screen.getByText("turn")).toBeTruthy();
      expect(screen.getByText("tool_call")).toBeTruthy();
      expect(screen.getByText("approval")).toBeTruthy();
    });
  });

  it("shows expanded JSON when row is clicked", async () => {
    await renderAuditTab();
    await waitFor(() => screen.getByText("turn"));
    // Click first row
    const rows = document.querySelectorAll("tbody tr");
    fireEvent.click(rows[0]);
    await waitFor(() => {
      // JSON expanded — should contain the sessionId in pre block
      const pres = document.querySelectorAll("pre");
      const found = Array.from(pres).some((p) => p.textContent?.includes("sess-abc"));
      expect(found).toBe(true);
    });
  });

  it("shows empty state when no entries", async () => {
    const api = makeApi({ searchResult: { entries: [], total: 0 }, stats: { totalByType: {}, totalByDay: {}, sensitiveOps: 0 } });
    await renderAuditTab(api);
    await waitFor(() => {
      expect(screen.getByText(/항목이 없습니다/)).toBeTruthy();
    });
  });

  it("shows pagination when total > PAGE_SIZE (50)", async () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({
      timestamp: "2026-04-18T10:00:00.000Z",
      sessionId: "sess",
      type: "turn",
      input: `msg${i}`,
      output: "ok",
      route: "claude",
    }));
    const api = makeApi({ searchResult: { entries, total: 120 } });
    await renderAuditTab(api);
    await waitFor(() => {
      // "1 / 3" pagination — total 120 / 50 = 3 pages
      expect(screen.getByText(/1 \/ 3/)).toBeTruthy();
    });
  });

  it("calls search again when 검색 button is clicked", async () => {
    const api = makeApi();
    await renderAuditTab(api);
    await waitFor(() => screen.getByText("검색"));
    const btn = screen.getByText("검색");
    fireEvent.click(btn);
    await waitFor(() => {
      expect(api.audit.search).toHaveBeenCalledTimes(2);
    });
  });
});
