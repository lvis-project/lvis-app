// @vitest-environment jsdom
import "../../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { DockedApprovalCard } from "../DockedApprovalCard.js";
import type { ApprovalRequest } from "../../../types.js";

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
      candidatePath: "C:\\ProgramData\\lvis\\config.json",
      suggestedParent: "C:\\ProgramData\\lvis",
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
  return { onDecide, onReturnFocus, container };
}

const card = () => screen.getByTestId("docked-approval-card");

describe("DockedApprovalCard — narrow choices commit immediately", () => {
  it("allows once on click", async () => {
    const { onDecide } = await renderCard();
    await act(async () => {
      fireEvent.click(screen.getByTestId("docked-approval-choice-allow-once"));
    });
    expect(onDecide).toHaveBeenCalledWith("allow-once");
  });

  it("denies on click, with no confirm step in the way", async () => {
    // Deny must cost exactly what allow-once costs — one press.
    const { onDecide, container } = await renderCard();
    await act(async () => {
      fireEvent.click(screen.getByTestId("docked-approval-choice-deny-once"));
    });
    expect(onDecide).toHaveBeenCalledWith("deny-once");
    expect(container.querySelector('[data-testid="docked-approval-confirm"]')).toBeNull();
  });
});

describe("DockedApprovalCard — widening choices cannot be committed by momentum", () => {
  it("opens the confirm step instead of granting", async () => {
    const { onDecide } = await renderCard();
    await act(async () => {
      fireEvent.click(screen.getByTestId("docked-approval-choice-allow-always"));
    });
    expect(screen.getByTestId("docked-approval-confirm")).toBeTruthy();
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("leaves focus on the choice button, so a repeated Enter grants nothing", async () => {
    // This is the whole mechanism: the confirm step deliberately does not take
    // focus, so the key that opened it cannot also commit it.
    const { onDecide } = await renderCard();
    const always = screen.getByTestId("docked-approval-choice-allow-always");
    await act(async () => {
      always.focus();
      fireEvent.click(always);
    });
    expect(document.activeElement).toBe(always);

    // Repeat the same gesture several times — a user leaning on Enter.
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        fireEvent.click(always);
      });
    }
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.getByTestId("docked-approval-confirm")).toBeTruthy();
  });

  it("plain Enter on the card does not commit the open confirm step", async () => {
    const { onDecide } = await renderCard();
    await act(async () => {
      fireEvent.click(screen.getByTestId("docked-approval-choice-allow-session"));
    });
    await act(async () => {
      fireEvent.keyDown(card(), { key: "Enter" });
    });
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("commits on Ctrl+Enter with the host-resolved path", async () => {
    const { onDecide } = await renderCard();
    await act(async () => {
      fireEvent.click(screen.getByTestId("docked-approval-choice-allow-session"));
    });
    await act(async () => {
      fireEvent.keyDown(card(), { key: "Enter", ctrlKey: true });
    });
    expect(onDecide).toHaveBeenCalledWith("allow-session", "C:\\ProgramData\\lvis");
  });

  it("commits from the Tab-reachable confirm button", async () => {
    // The button is a real button and must keep working natively for AT.
    const { onDecide } = await renderCard();
    await act(async () => {
      fireEvent.click(screen.getByTestId("docked-approval-choice-allow-always"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("docked-approval-commit"));
    });
    expect(onDecide).toHaveBeenCalledWith("allow-always", "C:\\ProgramData\\lvis");
  });

  it("states the concrete path, duration, and any adjacency warning", async () => {
    await renderCard(
      makeRequest({
        outOfAllowedDir: {
          candidatePath: "C:\\ProgramData\\lvis\\config.json",
          suggestedParent: "C:\\ProgramData\\lvis",
          currentAllowed: [],
          adjacencyWarnings: ["path contains '.git' segment"],
        },
      } as Partial<ApprovalRequest>),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("docked-approval-choice-allow-always"));
    });
    const confirm = screen.getByTestId("docked-approval-confirm");
    expect(confirm.textContent).toContain("C:\\ProgramData\\lvis");
    expect(confirm.textContent).toContain("취소할 때까지");
    expect(screen.getByTestId("docked-approval-warning").textContent).toContain(".git");
  });
});

describe("DockedApprovalCard — Escape", () => {
  it("returns from the confirm step to the choices without deciding", async () => {
    const { onDecide, container } = await renderCard();
    await act(async () => {
      fireEvent.click(screen.getByTestId("docked-approval-choice-allow-always"));
    });
    await act(async () => {
      fireEvent.keyDown(card(), { key: "Escape" });
    });
    expect(container.querySelector('[data-testid="docked-approval-confirm"]')).toBeNull();
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("denies from the choice group — the modal's fail-closed gesture is kept", async () => {
    const { onDecide } = await renderCard();
    await act(async () => {
      fireEvent.keyDown(card(), { key: "Escape" });
    });
    expect(onDecide).toHaveBeenCalledWith("deny-once");
  });

  it("is ignored entirely when the request requires an explicit choice", async () => {
    const { onDecide } = await renderCard(makeRequest({ requireExplicit: true }));
    await act(async () => {
      fireEvent.keyDown(card(), { key: "Escape" });
    });
    expect(onDecide).not.toHaveBeenCalled();
  });
});

describe("DockedApprovalCard — keyboard navigation", () => {
  it("moves the single tab stop with number keys", async () => {
    await renderCard();
    await act(async () => {
      fireEvent.keyDown(card(), { key: "2" });
    });
    const session = screen.getByTestId("docked-approval-choice-allow-session");
    expect(document.activeElement).toBe(session);
    expect(session.getAttribute("tabindex")).toBe("0");
    expect(
      screen.getByTestId("docked-approval-choice-allow-once").getAttribute("tabindex"),
    ).toBe("-1");
  });

  it("wraps with arrow keys", async () => {
    await renderCard();
    await act(async () => {
      fireEvent.keyDown(card(), { key: "ArrowLeft" });
    });
    // Wrapping backwards from the first choice lands on deny, the last.
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
});

describe("DockedApprovalCard — option table", () => {
  it("offers no widening choices when the host resolved no parent", async () => {
    const { container } = await renderCard(
      makeRequest({
        outOfAllowedDir: {
          candidatePath: "C:\\x\\y.json",
          suggestedParent: undefined,
          currentAllowed: [],
          adjacencyWarnings: [],
        },
      } as Partial<ApprovalRequest>),
    );
    expect(
      container.querySelector('[data-testid="docked-approval-choice-allow-session"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="docked-approval-choice-allow-always"]'),
    ).toBeNull();
    // Deny and allow-once remain, so the card is still actionable.
    expect(screen.getByTestId("docked-approval-choice-deny-once")).toBeTruthy();
  });

  it("honours allowedChoices from the host", async () => {
    const { container } = await renderCard(
      makeRequest({ allowedChoices: ["allow-once", "deny-once"] } as Partial<ApprovalRequest>),
    );
    expect(
      container.querySelector('[data-testid="docked-approval-choice-allow-always"]'),
    ).toBeNull();
  });

  it("renders nothing without a request", async () => {
    let container!: HTMLElement;
    await act(async () => {
      container = render(
        <DockedApprovalCard request={null} onDecide={vi.fn()} />,
      ).container;
    });
    expect(container.querySelector('[data-testid="docked-approval-card"]')).toBeNull();
  });
});
