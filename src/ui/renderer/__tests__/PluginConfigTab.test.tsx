import "../../../../test/renderer/setup.js";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { PluginConfigTab } from "../tabs/PluginConfigTab.js";

const mockCards = vi.fn(async () => [
  {
    id: "meeting",
    name: "Meeting",
    description: "Meeting plugin",
    sampleTools: [],
    capabilities: [],
    tools: [],
    loadStatus: "loaded" as const,
  },
]);
const mockGet = vi.fn(async () => ({ ok: true as const, config: { apiKey: "abc" } }));
const mockSet = vi.fn(async () => ({
  ok: false as const,
  error: "unauthorized-frame",
  message: "권한이 없는 프레임입니다.",
}));
const mockUninstall = vi.fn(async () => ({
  ok: false as const,
  error: "unauthorized-frame",
  message: "제거 권한이 없습니다.",
}));

beforeEach(() => {
  Object.defineProperty(window, "lvis", {
    value: {
      plugins: {
        cards: mockCards,
      },
      pluginConfig: {
        get: mockGet,
        set: mockSet,
      },
    },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, "lvisHost", {
    value: {
      takePluginMarketplaceApi: () => ({
        installMarketplacePlugin: vi.fn(),
        uninstallMarketplacePlugin: mockUninstall,
      }),
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.clearAllMocks();
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

describe("PluginConfigTab", () => {
  it("shows uninstall failure instead of success when IPC returns ok=false", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PluginConfigTab />);

    await waitFor(() => {
      expect(mockCards).toHaveBeenCalledOnce();
      expect(mockGet).toHaveBeenCalledWith("meeting");
    });

    fireEvent.click(screen.getByRole("button", { name: "제거" }));

    await waitFor(() => {
      expect(mockUninstall).toHaveBeenCalledWith("meeting");
      expect(screen.getByText("제거 권한이 없습니다.")).toBeInTheDocument();
    });

    expect(screen.queryByText("Meeting 제거 완료")).toBeNull();
    confirmSpy.mockRestore();
  });

  it("shows save failure instead of success when IPC returns ok=false", async () => {
    render(<PluginConfigTab />);

    await waitFor(() => {
      expect(mockCards).toHaveBeenCalledOnce();
      expect(mockGet).toHaveBeenCalledWith("meeting");
    });

    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(mockSet).toHaveBeenCalledOnce();
      expect(screen.getByText("권한이 없는 프레임입니다.")).toBeInTheDocument();
    });

    expect(screen.queryByText("설정이 저장되었습니다.")).toBeNull();
  });
});
