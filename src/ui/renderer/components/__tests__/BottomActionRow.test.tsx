// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { BottomActionRow } from "../BottomActionRow.js";

const getSettings = vi.fn();
const updateSettings = vi.fn();

// ThinkingButton (child) reads its depth from the renderer api on mount.
vi.mock("../../api-client.js", () => ({
  getApi: () => ({ getSettings, updateSettings }),
}));

function renderRow(overrides: Partial<Parameters<typeof BottomActionRow>[0]> = {}) {
  const props: Parameters<typeof BottomActionRow>[0] = {
    isBusy: false,
    isSendDisabled: false,
    onSend: vi.fn(),
    onCancel: vi.fn(),
    enableThinkingChat: false,
    onToggleThinking: vi.fn(),
    ...overrides,
  };
  return render(
    <TooltipProvider>
      <BottomActionRow {...props} />
    </TooltipProvider>,
  );
}

describe("BottomActionRow", () => {
  beforeEach(() => {
    getSettings.mockReset();
    updateSettings.mockReset();
    getSettings.mockResolvedValue({
      llm: { provider: "azure-foundry", vendors: { "azure-foundry": { thinkingBudgetTokens: 10_000 } } },
    });
    updateSettings.mockResolvedValue({ ok: true });
  });

  it("renders a fixed '?' shortcuts button instead of inline keyboard hint text", () => {
    const { getByTestId, queryByTestId, container } = renderRow({ isBusy: true });
    // The old variable-width inline hints are gone.
    expect(queryByTestId("composer-hint-immediate")).toBeNull();
    // A single fixed-size "?" button takes their place.
    const help = getByTestId("composer-shortcuts-button");
    expect(help.getAttribute("aria-label")).toBe("단축키");
    expect(help.className).toContain("h-[26px]");
    expect(help.className).toContain("w-[26px]");
    // No raw "줄바꿈" hint text rendered in the row by default.
    expect(container.textContent).not.toContain("줄바꿈");
  });

  it("opens a popover listing the composer shortcuts on click", async () => {
    const { getByTestId } = renderRow();
    fireEvent.click(getByTestId("composer-shortcuts-button"));
    await waitFor(() => {
      const popover = getByTestId("composer-shortcuts-popover");
      expect(popover.textContent).toContain("전송");
      expect(popover.textContent).toContain("줄바꿈");
      expect(popover.textContent).toContain("즉시 주입");
      expect(popover.textContent).toContain("LLM 취소");
      expect(popover.textContent).toContain("커맨드 / 리소스");
    });
  });

  it("places the thinking button between the '?' button and Send", () => {
    const { getByTestId } = renderRow();
    const help = getByTestId("composer-shortcuts-button");
    const thinking = getByTestId("thinking-button");
    const send = getByTestId("composer-send-button");
    // DOM order encodes left→right placement: ? · 생각모드 · 전송.
    expect(help.compareDocumentPosition(thinking) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(thinking.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the whole row single-line and right-justified (#1303 / ring moved to action bar)", () => {
    const { getByTestId } = renderRow();
    // The row container must never wrap to a second line.
    const row = getByTestId("composer-bottom-action-row");
    expect(row.className).toContain("flex-nowrap");
    expect(row.className).not.toContain("flex-wrap");
    // The token ring moved to the InputActionBar leading cluster, so this row
    // no longer hosts a token slot — its turn controls sit flush-right.
    expect(row.className).toContain("justify-end");
  });

  it("invokes onSend when Send is clicked", () => {
    const onSend = vi.fn();
    const { getByTestId } = renderRow({ onSend });
    fireEvent.click(getByTestId("composer-send-button"));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("shows the cancel button only while busy", () => {
    const { queryByTestId, rerender, getByTestId } = renderRow({ isBusy: false });
    expect(queryByTestId("composer-cancel-button")).toBeNull();
    rerender(
      <TooltipProvider>
        <BottomActionRow
          isBusy
          isSendDisabled={false}
          onSend={vi.fn()}
          onCancel={vi.fn()}
          enableThinkingChat={false}
          onToggleThinking={vi.fn()}
        />
      </TooltipProvider>,
    );
    expect(getByTestId("composer-cancel-button")).not.toBeNull();
  });
});
