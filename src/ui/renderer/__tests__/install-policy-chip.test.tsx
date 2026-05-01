/**
 * US-P7: install_policy chip rendering in PluginConfigTab.
 *
 * Verifies:
 *   - admin policy → "관리자 전용" chip with tooltip
 *   - user policy  → "사용자 설치 가능" chip with tooltip
 *   - missing installPolicy field (legacy) → no chip (graceful fallback)
 */
import "../../../../test/renderer/setup.js";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PluginConfigTab } from "../tabs/PluginConfigTab.js";

const mockGet = vi.fn(async () => ({ ok: true as const, config: {} }));
const mockSet = vi.fn(async () => ({ ok: true as const, config: {} }));

function setupLvis(cards: unknown[]) {
  Object.defineProperty(window, "lvis", {
    value: {
      plugins: { cards: vi.fn(async () => cards) },
      pluginConfig: { get: mockGet, set: mockSet },
    },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, "lvisHost", {
    value: { takePluginMarketplaceApi: () => null },
    writable: true,
    configurable: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  Object.defineProperty(window, "lvis", {
    value: undefined,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, "lvisHost", {
    value: undefined,
    writable: true,
    configurable: true,
  });
});

describe("PluginConfigTab — install_policy chip", () => {
  it("renders 관리자 전용 chip when installPolicy is admin", async () => {
    setupLvis([
      {
        id: "meeting",
        name: "Meeting",
        description: "Meeting plugin",
        publisher: "Test fixture",
        sampleTools: [],
        capabilities: [],
        tools: [],
        loadStatus: "loaded" as const,
        installPolicy: "admin",
      },
    ]);

    render(<PluginConfigTab />);

    await waitFor(() => {
      expect(screen.getByTitle("관리자만 설치할 수 있는 플러그인입니다")).toBeInTheDocument();
    });

    const chip = screen.getByTitle("관리자만 설치할 수 있는 플러그인입니다");
    expect(chip).toHaveTextContent("관리자 전용");
    expect(chip).toHaveAttribute("aria-label", "관리자 전용 플러그인");
  });

  it("renders 사용자 설치 가능 chip when installPolicy is user", async () => {
    setupLvis([
      {
        id: "email",
        name: "Email",
        description: "Email plugin",
        publisher: "Test fixture",
        sampleTools: [],
        capabilities: [],
        tools: [],
        loadStatus: "loaded" as const,
        installPolicy: "user",
      },
    ]);

    render(<PluginConfigTab />);

    await waitFor(() => {
      expect(screen.getByTitle("모든 사용자가 설치할 수 있는 플러그인입니다")).toBeInTheDocument();
    });

    const chip = screen.getByTitle("모든 사용자가 설치할 수 있는 플러그인입니다");
    expect(chip).toHaveTextContent("사용자 설치 가능");
    expect(chip).toHaveAttribute("aria-label", "사용자 설치 가능 플러그인");
  });

  it("does not render a policy chip when installPolicy is absent (legacy plugin)", async () => {
    setupLvis([
      {
        id: "calendar",
        name: "Calendar",
        description: "Calendar plugin",
        publisher: "Test fixture",
        sampleTools: [],
        capabilities: [],
        tools: [],
        loadStatus: "loaded" as const,
        // intentionally no installPolicy field — simulates pre-policy legacy plugin
      },
    ]);

    render(<PluginConfigTab />);

    await waitFor(() => {
      // "Calendar" appears in both sidebar list and detail header — use the h3
      expect(screen.getAllByText("Calendar").length).toBeGreaterThan(0);
    });

    expect(
      screen.queryByTitle("관리자만 설치할 수 있는 플러그인입니다"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTitle("모든 사용자가 설치할 수 있는 플러그인입니다"),
    ).not.toBeInTheDocument();
  });
});
