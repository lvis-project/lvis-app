import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatTab } from "../ChatTab.js";

function renderChatTab(overrides: Partial<Parameters<typeof ChatTab>[0]> = {}) {
  const setSubAgentAutonomousWake = vi.fn();
  const setIdleMemoryConsolidation = vi.fn();
  const setMemoryCaptureMode = vi.fn();
  render(
    <ChatTab
      autoCompact
      setAutoCompact={vi.fn()}
      streamSmoothing="none"
      setStreamSmoothing={vi.fn()}
      idlePreferenceRefresh
      setIdlePreferenceRefresh={vi.fn()}
      idleMemoryConsolidation={false}
      setIdleMemoryConsolidation={setIdleMemoryConsolidation}
      memoryCaptureMode="off"
      setMemoryCaptureMode={setMemoryCaptureMode}
      subAgentAutonomousWake={false}
      setSubAgentAutonomousWake={setSubAgentAutonomousWake}
      piiRedactEnabled={false}
      onPiiRedactToggle={vi.fn()}
      settingsLoaded
      {...overrides}
    />,
  );
  return { setSubAgentAutonomousWake, setIdleMemoryConsolidation, setMemoryCaptureMode };
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

describe("ChatTab idle long-term-memory consolidation", () => {
  it("defaults off and makes the idle-only, manual-Roles behavior explicit", () => {
    const { setIdleMemoryConsolidation } = renderChatTab();
    const toggle = screen.getByTestId("idle-memory-consolidation-toggle");

    expect(toggle.getAttribute("data-state")).toBe("unchecked");
    expect(screen.getByText("유휴 상태에서 장기 기억 통합")).toBeTruthy();
    expect(screen.getByText(/현재 프로젝트 원본 기억을 구성된 LLM에 전송/)).toBeTruthy();
    expect(screen.getByText(/Roles의 수동 통합은 계속 사용할 수 있습니다/)).toBeTruthy();

    fireEvent.click(toggle);
    expect(setIdleMemoryConsolidation).toHaveBeenCalledWith(true);
  });
});

describe("ChatTab model-reviewed memory capture", () => {
  it("defaults off and makes review versus automatic storage explicit", () => {
    const { setMemoryCaptureMode } = renderChatTab();
    const mode = screen.getByTestId("memory-capture-mode");

    expect(screen.getByText("기억 자동 캡처")).toBeTruthy();
    expect(screen.getByText(/원본 대화 내용은 기억에 그대로 복사되지 않습니다/)).toBeTruthy();
    expect(screen.getByText(/명시적으로 저장하는 기억은 계속 사용할 수 있으며, 저장 전에도 검토·정제됩니다/)).toBeTruthy();
    expect(screen.getByText("검토 후 저장")).toBeTruthy();
    expect(screen.getByText(/승인하기 전에는 프롬프트에 사용되지 않습니다/)).toBeTruthy();
    expect(screen.getByText("검토 후 자동 저장")).toBeTruthy();
    expect(screen.getByText(/호스트 검증을 통과한 제안만 활성 기억으로 저장합니다/)).toBeTruthy();
    expect(screen.getByRole("radio", { name: /끔/ }).getAttribute("data-state")).toBe("checked");

    fireEvent.click(screen.getByRole("radio", { name: /검토 후 저장/ }));
    fireEvent.click(screen.getByRole("radio", { name: /검토 후 자동 저장/ }));

    expect(mode).toBeTruthy();
    expect(setMemoryCaptureMode).toHaveBeenNthCalledWith(1, "review");
    expect(setMemoryCaptureMode).toHaveBeenNthCalledWith(2, "auto");
  });
});
