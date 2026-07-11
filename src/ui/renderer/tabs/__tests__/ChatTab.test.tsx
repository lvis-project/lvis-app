import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatTab } from "../ChatTab.js";

function renderChatTab(overrides: Partial<Parameters<typeof ChatTab>[0]> = {}) {
  const setSubAgentAutonomousWake = vi.fn();
  render(
    <ChatTab
      autoCompact
      setAutoCompact={vi.fn()}
      streamSmoothing="none"
      setStreamSmoothing={vi.fn()}
      idlePreferenceRefresh
      setIdlePreferenceRefresh={vi.fn()}
      subAgentAutonomousWake={false}
      setSubAgentAutonomousWake={setSubAgentAutonomousWake}
      piiRedactEnabled={false}
      onPiiRedactToggle={vi.fn()}
      settingsLoaded
      {...overrides}
    />,
  );
  return { setSubAgentAutonomousWake };
}

describe("ChatTab autonomous sub-agent wake", () => {
  it("renders default-off guidance and persists only an explicit opt-in", () => {
    const { setSubAgentAutonomousWake } = renderChatTab();
    const toggle = screen.getByTestId("subagent-autonomous-wake-toggle");

    expect(toggle.getAttribute("data-state")).toBe("unchecked");
    expect(screen.getByText("서브에이전트 메시지로 부모 자동 깨우기")).toBeTruthy();
    expect(screen.getByText(/유휴 부모가 백그라운드 서브에이전트 메시지를 받으면/)).toBeTruthy();

    fireEvent.click(toggle);
    expect(setSubAgentAutonomousWake).toHaveBeenCalledWith(true);
  });
});
