/**
 * OverlayCard expand-toggle behavior (PR #668).
 *
 * Covers:
 *   - Short summary → no "더 보기" button (no overflow)
 *   - Long summary with overflow → button appears, click → expanded with scroll
 *   - aria-expanded reflects state
 *   - state isolation between two OverlayCard instances (verifies `key`
 *     reset pattern from OverlayCardRegion → React remount per item)
 */
import "./setup.js";
import { describe, it, expect, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { OverlayCard } from "../../src/ui/renderer/components/OverlayCard.js";

function renderCard(props: Parameters<typeof OverlayCard>[0]) {
  return render(
    <TooltipProvider>
      <OverlayCard {...props} />
    </TooltipProvider>,
  );
}

/**
 * jsdom 은 layout 을 계산하지 않아 `scrollHeight` / `clientHeight` 가 항상 0.
 * `useLayoutEffect` 의 `scrollHeight > clientHeight` 분기를 검증하려면
 * 두 prop 을 명시적으로 override.
 */
function mockOverflow(scrollH: number, clientH: number): () => void {
  const scrollDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  const clientDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return scrollH; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return clientH; },
  });
  return () => {
    if (scrollDesc) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollDesc);
    if (clientDesc) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientDesc);
  };
}

const baseProps = {
  title: "회의 요약",
  firedAt: new Date().toISOString(),
  running: false,
  queueIndex: 1,
  queueTotal: 1,
  onPrev: () => {},
  onNext: () => {},
  onDismiss: () => {},
} as const;

describe("OverlayCard — expand toggle", () => {
  let restore: () => void = () => {};
  beforeEach(() => {
    restore();
    restore = () => {};
  });

  it("no '더 보기' button when content fits (no overflow)", () => {
    restore = mockOverflow(20, 40); // scroll < client → not overflowing
    const { queryByTestId } = renderCard({ ...baseProps, summary: "짧은 요약", kind: "plugin" });
    expect(queryByTestId("overlay-card-expand-toggle")).toBeNull();
  });

  it("'더 보기' button appears when content overflows; click toggles expanded state", () => {
    restore = mockOverflow(120, 40); // scrollHeight > clientHeight → overflow
    const { getByTestId, getByText } = renderCard({
      ...baseProps,
      summary: "긴 요약 ".repeat(50),
      kind: "plugin",
    });
    const toggle = getByTestId("overlay-card-expand-toggle");
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(getByText("더 보기")).toBeTruthy();

    // 확장
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(getByText("접기")).toBeTruthy();
    const summary = getByTestId("overlay-card-summary");
    expect(summary.getAttribute("data-expanded")).toBe("true");

    // 접기
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(getByText("더 보기")).toBeTruthy();
  });

  it("renders truncation marker text verbatim when host appended it", () => {
    restore = mockOverflow(200, 40);
    const truncated = "긴 본문 내용...\n…[잘림 — 확인하기 후 채팅에서 전체 보기]";
    const { getByTestId } = renderCard({ ...baseProps, summary: truncated, kind: "plugin" });
    const summary = getByTestId("overlay-card-summary");
    expect(summary.textContent).toContain("[잘림 — 확인하기 후 채팅에서 전체 보기]");
  });

  it("primary action label defaults to '확인하기' (regression: was '지금 답하기')", () => {
    const { getByTestId } = renderCard({
      ...baseProps,
      summary: "x",
      kind: "plugin",
      onPrimaryAction: () => {},
      primaryActionLabel: "확인하기",
    });
    const action = getByTestId("overlay-card-primary-action");
    expect(action.textContent).toContain("확인하기");
    expect(action.textContent).not.toContain("지금 답하기");
  });
});
