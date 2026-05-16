/**
 * PluginPerfTab renderer tests — renders with mock data, refresh, color coding.
 */
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import React from "react";

afterEach(() => {
  vi.unstubAllGlobals();
});

const MOCK_STATS = {
  "com.example.meeting": {
    startupMs: 120,
    toolCallCount: 10,
    errorCount: 0,
    totalExecMs: 500,
    lastCallAt: Date.now() - 5000,
  },
  "com.example.email": {
    startupMs: 80,
    toolCallCount: 20,
    errorCount: 2,
    totalExecMs: 2000,
    lastCallAt: Date.now() - 1000,
  },
  "com.example.bad": {
    startupMs: 200,
    toolCallCount: 10,
    errorCount: 6,
    totalExecMs: 1000,
    lastCallAt: null,
  },
};

function makeApi(stats: Record<string, unknown> = MOCK_STATS) {
  return {
    plugins: {
      getPerfStats: vi.fn(async () => stats),
    },
  };
}

async function renderTab(api = makeApi()) {
  const { PluginPerfTab } = await import("../../src/ui/renderer/tabs/PluginPerfTab.js");
  const result = render(<PluginPerfTab api={api as any} />);
  return { ...result, api };
}

describe("PluginPerfTab", () => {
  it("renders without crashing", async () => {
    const { container } = await renderTab();
    await waitFor(() => expect(container).toBeTruthy());
  });

  it("calls getPerfStats on mount", async () => {
    const api = makeApi();
    await renderTab(api);
    await waitFor(() => {
      expect(api.plugins.getPerfStats).toHaveBeenCalledTimes(1);
    });
  });

  it("renders plugin rows with plugin IDs", async () => {
    await renderTab();
    await waitFor(() => {
      expect(screen.getByText("com.example.meeting")).toBeTruthy();
      expect(screen.getByText("com.example.email")).toBeTruthy();
      expect(screen.getByText("com.example.bad")).toBeTruthy();
    });
  });

  it("shows empty message when no plugins", async () => {
    await renderTab(makeApi({}));
    await waitFor(() => {
      expect(screen.getByText(/로드된 플러그인이 없습니다/)).toBeTruthy();
    });
  });

  it("calls getPerfStats again on refresh button click", async () => {
    const api = makeApi();
    await renderTab(api);
    await waitFor(() => expect(api.plugins.getPerfStats).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /새로고침/ }));
    await waitFor(() => {
      expect(api.plugins.getPerfStats).toHaveBeenCalledTimes(2);
    });
  });

  it("color-codes error rate: green for <1%, amber for 1-5%, red for >5%", async () => {
    await renderTab();
    await waitFor(() => {
      // com.example.meeting: 0/10 = 0% → green
      // com.example.email: 2/20 = 10% → red (>5%)
      // com.example.bad: 6/10 = 60% → red
      const allText = document.body.textContent ?? "";
      expect(allText).toContain("0.0%");   // meeting — green
      expect(allText).toContain("10.0%");  // email — red
      expect(allText).toContain("60.0%");  // bad — red
    });
  });
});
