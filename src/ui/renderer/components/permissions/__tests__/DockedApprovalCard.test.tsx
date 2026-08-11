// @vitest-environment jsdom
import "../../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { DockedApprovalCard } from "../DockedApprovalCard.js";
import type { ApprovalRequest } from "../../../types.js";

const TARGET = "C:\\ProgramData\\lvis\\config.json";
const PARENT = "C:\\ProgramData\\lvis";

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "req-1",
    category: "tool",
    kind: "out-of-allowed-dir",
    toolName: "read_file",
    args: {},
    reason: "outside allowed directories",
    createdAt: 0,
    requireExplicit: false,
    outOfAllowedDir: {
      candidatePath: TARGET,
      suggestedParent: PARENT,
      currentAllowed: ["C:\\work"],
      adjacencyWarnings: [],
    },
    ...overrides,
  } as ApprovalRequest;
}

async function renderCard(request = makeRequest()) {
  const onDecide = vi.fn();
  const onReturnFocus = vi.fn();
  let container!: HTMLElement;
  await act(async () => {
    container = render(
      <DockedApprovalCard
        request={request}
        onDecide={onDecide}
        onReturnFocus={onReturnFocus}
      />,
    ).container;
  });
  // The card focuses the narrowest scope inside a rAF, so flush one frame.
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
  return { onDecide, onReturnFocus, container };
}

const card = () => screen.getByTestId("docked-approval-panel");
const targetLine = () => screen.getByTestId("docked-approval-target").textContent ?? "";

describe("DockedApprovalCard — what will be granted is always on screen", () => {
  it("starts on the narrowest scope without stealing route focus", async () => {
    const { container } = await renderCard();
    const narrowest = screen.getByTestId("docked-approval-choice-allow-once");
    expect(document.activeElement).not.toBe(narrowest);
    expect(narrowest.tabIndex).toBe(0);
    expect(targetLine()).toContain(TARGET);
    expect(container.querySelector('input, textarea, [contenteditable="true"], [role="textbox"]'))
      .toBeNull();
  });

  it("rewrites the target as focus moves to a wider scope", async () => {
    // The target is the only thing that differs between scopes, and moving is
    // what makes the widening visible.
    await renderCard();
    await act(async () => {
      fireEvent.keyDown(card(), { key: "ArrowRight" });
      fireEvent.keyDown(card(), { key: "ArrowRight" });
    });
    expect(document.activeElement).toBe(
      screen.getByTestId("docked-approval-choice-allow-always"),
    );
    // "always" grants the parent folder, not the file.
    expect(targetLine()).toContain(PARENT);
    expect(targetLine()).not.toContain("config.json");
  });

  it("shows the adjacency warning only on the scope that adds the directory", async () => {
    await renderCard(
      makeRequest({
        outOfAllowedDir: {
          candidatePath: TARGET,
          suggestedParent: PARENT,
          currentAllowed: [],
          adjacencyWarnings: ["path contains '.git' segment"],
        },
      }),
    );
    expect(screen.queryByTestId("docked-approval-warning")).toBeNull();
    await act(async () => {
      fireEvent.keyDown(card(), { key: "2" });
    });
    expect(screen.getByTestId("docked-approval-warning").textContent).toContain(".git");
  });

  it("says plainly that deny grants nothing", async () => {
    await renderCard();
    await act(async () => {
      fireEvent.keyDown(card(), { key: "1" });
    });
    expect(targetLine()).toContain("거부");
  });
});

describe("DockedApprovalCard — narrow scopes commit on native activation", () => {
  it("allows once on click", async () => {
    const { onDecide } = await renderCard();
    await act(async () => {
      fireEvent.click(screen.getByTestId("docked-approval-choice-allow-once"));
    });
    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);
  });

  it("denies on click — one press, same as allowing", async () => {
    const { onDecide } = await renderCard();
    await act(async () => {
      fireEvent.click(screen.getByTestId("docked-approval-choice-deny-once"));
    });
    expect(onDecide).toHaveBeenCalledWith("deny-once", undefined);
  });
});

describe("DockedApprovalCard — widening requires moving there first", () => {
  it("grants nothing until focus has been moved to the widening scope", async () => {
    // The safety claim: a widening scope is not reachable by repeating the key
    // already under the user's finger. Pressing the focused (narrowest) scope
    // can never yield a standing grant.
    const { onDecide } = await renderCard();
    await act(async () => {
      fireEvent.click(screen.getByTestId("docked-approval-choice-allow-once"));
    });
    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);
    expect(onDecide).not.toHaveBeenCalledWith("allow-always", expect.anything());
  });

  it("applies the widening scope, with the host path, once moved there", async () => {
    const { onDecide } = await renderCard();
    await act(async () => {
      fireEvent.keyDown(card(), { key: "2" });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("docked-approval-choice-allow-always"));
    });
    expect(onDecide).toHaveBeenCalledWith("allow-always", PARENT);
  });

});

describe("DockedApprovalCard — Escape", () => {
  it("denies, preserving the modal's fail-closed gesture", async () => {
    const { onDecide } = await renderCard();
    await act(async () => {
      fireEvent.keyDown(card(), { key: "Escape" });
    });
    expect(onDecide).toHaveBeenCalledWith("deny-once");
  });

  it("is ignored when the request requires an explicit choice", async () => {
    const { onDecide } = await renderCard(makeRequest({ requireExplicit: true }));
    await act(async () => {
      fireEvent.keyDown(card(), { key: "Escape" });
    });
    expect(onDecide).not.toHaveBeenCalled();
  });
});

describe("DockedApprovalCard — navigation and option table", () => {
  it("keeps the group to a single tab stop", async () => {
    await renderCard();
    await act(async () => {
      fireEvent.keyDown(card(), { key: "2" });
    });
    expect(
      screen.getByTestId("docked-approval-choice-allow-always").getAttribute("tabindex"),
    ).toBe("0");
    expect(
      screen.getByTestId("docked-approval-choice-allow-once").getAttribute("tabindex"),
    ).toBe("-1");
  });

  it("moves forward from allow-once to reject", async () => {
    await renderCard();
    await act(async () => {
      fireEvent.keyDown(card(), { key: "ArrowRight" });
    });
    expect(document.activeElement).toBe(
      screen.getByTestId("docked-approval-choice-deny-once"),
    );
  });

  it("hands focus back to the composer on shift-tab", async () => {
    const { onReturnFocus } = await renderCard();
    await act(async () => {
      fireEvent.keyDown(card(), { key: "Tab", shiftKey: true });
    });
    expect(onReturnFocus).toHaveBeenCalled();
  });

  it("keeps Always allow visible but disabled when the host resolved no parent", async () => {
    const { container } = await renderCard(
      makeRequest({
        outOfAllowedDir: {
          candidatePath: TARGET,
          suggestedParent: null,
          currentAllowed: [],
          adjacencyWarnings: [],
        },
      }),
    );
    const always = container.querySelector<HTMLButtonElement>('[data-testid="docked-approval-choice-allow-always"]');
    expect(always).toBeTruthy();
    expect(always).toBeDisabled();
    expect(always).toHaveAttribute(
      "title",
      "지속 허용할 안전한 검토 상위 폴더가 없습니다.",
    );
    expect(screen.getByTestId("docked-persistent-unavailable-reason"))
      .toHaveTextContent("지속 허용할 안전한 검토 상위 폴더가 없습니다.");
    expect(screen.getByTestId("docked-approval-choice-deny-once")).toBeTruthy();
  });

  it("keeps host-forbidden persistence visible but disabled", async () => {
    const { container } = await renderCard(
      makeRequest({ allowedChoices: ["allow-once", "deny-once"] }),
    );
    const always = container.querySelector<HTMLButtonElement>('[data-testid="docked-approval-choice-allow-always"]');
    expect(always).toBeTruthy();
    expect(always).toBeDisabled();
    expect(always).toHaveAttribute(
      "title",
      "호스트가 이 요청을 일회성 결정으로 제한했습니다.",
    );
    expect(screen.getByTestId("docked-persistent-unavailable-reason"))
      .toHaveTextContent("호스트가 이 요청을 일회성 결정으로 제한했습니다.");
  });

  it("locks path decisions while an exact reject is being managed in Settings", async () => {
    const onDecide = vi.fn();
    const onOpenPermanentDeny = vi.fn();
    await act(async () => {
      render(
        <DockedApprovalCard
          request={makeRequest()}
          onDecide={onDecide}
          onOpenPermanentDeny={onOpenPermanentDeny}
          interactionLocked
        />,
      );
    });
    expect(screen.getByTestId("approval-decision-locked")).toBeTruthy();
    expect(screen.getByTestId("docked-approval-choice-deny-once")).toBeDisabled();
    expect(screen.getByTestId("docked-approval-choice-allow-always")).toBeDisabled();
    expect(screen.getByTestId("docked-approval-choice-allow-once")).toBeDisabled();
    fireEvent.keyDown(card(), { key: "Escape" });
    expect(onDecide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("open-permanent-deny-settings"));
    expect(onOpenPermanentDeny).toHaveBeenCalled();
  });

  it("renders nothing without a request", async () => {
    let container!: HTMLElement;
    await act(async () => {
      container = render(
        <DockedApprovalCard request={null} onDecide={vi.fn()} />,
      ).container;
    });
    expect(container.querySelector('[data-testid="docked-approval-panel"]')).toBeNull();
  });
});
