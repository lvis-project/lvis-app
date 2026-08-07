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

const card = () => screen.getByTestId("docked-approval-overlay");
const targetLine = () => screen.getByTestId("docked-approval-target").textContent ?? "";

describe("DockedApprovalCard — what will be granted is always on screen", () => {
  it("opens on the narrowest scope and shows the file it would allow", async () => {
    await renderCard();
    expect(document.activeElement).toBe(
      screen.getByTestId("docked-approval-choice-allow-once"),
    );
    expect(targetLine()).toContain(TARGET);
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
      fireEvent.keyDown(card(), { key: "3" });
    });
    expect(screen.getByTestId("docked-approval-warning").textContent).toContain(".git");
  });

  it("says plainly that deny grants nothing", async () => {
    await renderCard();
    await act(async () => {
      fireEvent.keyDown(card(), { key: "4" });
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

describe("DockedApprovalCard — widening scopes need the modifier", () => {
  it.each(["allow-session", "allow-always"])(
    "activating %s does not grant on its own",
    async (choice) => {
      const { onDecide } = await renderCard();
      await act(async () => {
        fireEvent.click(screen.getByTestId(`docked-approval-choice-${choice}`));
      });
      expect(onDecide).not.toHaveBeenCalled();
    },
  );

  it("repeating plain Enter on a widening scope never grants", async () => {
    // With the confirm step gone, this modifier is the only thing between
    // arrow-then-Enter and a standing grant.
    const { onDecide } = await renderCard();
    await act(async () => {
      fireEvent.keyDown(card(), { key: "3" });
    });
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        fireEvent.keyDown(card(), { key: "Enter" });
        fireEvent.click(screen.getByTestId("docked-approval-choice-allow-always"));
      });
    }
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("applies the focused widening scope on Ctrl+Enter with the host path", async () => {
    const { onDecide } = await renderCard();
    await act(async () => {
      fireEvent.keyDown(card(), { key: "3" });
    });
    await act(async () => {
      fireEvent.keyDown(card(), { key: "Enter", ctrlKey: true });
    });
    expect(onDecide).toHaveBeenCalledWith("allow-always", PARENT);
  });

  it("applies session scope on Ctrl+Enter", async () => {
    const { onDecide } = await renderCard();
    await act(async () => {
      fireEvent.keyDown(card(), { key: "2" });
    });
    await act(async () => {
      fireEvent.keyDown(card(), { key: "Enter", ctrlKey: true });
    });
    expect(onDecide).toHaveBeenCalledWith("allow-session", TARGET);
  });

  it("Ctrl+Enter on the narrowest scope applies that, not a wider one", async () => {
    const { onDecide } = await renderCard();
    await act(async () => {
      fireEvent.keyDown(card(), { key: "Enter", ctrlKey: true });
    });
    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);
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
      screen.getByTestId("docked-approval-choice-allow-session").getAttribute("tabindex"),
    ).toBe("0");
    expect(
      screen.getByTestId("docked-approval-choice-allow-once").getAttribute("tabindex"),
    ).toBe("-1");
  });

  it("wraps backwards from the narrowest scope to deny", async () => {
    await renderCard();
    await act(async () => {
      fireEvent.keyDown(card(), { key: "ArrowLeft" });
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

  it("offers no widening scopes when the host resolved no parent", async () => {
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
    expect(
      container.querySelector('[data-testid="docked-approval-choice-allow-session"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="docked-approval-choice-allow-always"]'),
    ).toBeNull();
    expect(screen.getByTestId("docked-approval-choice-deny-once")).toBeTruthy();
  });

  it("honours allowedChoices from the host", async () => {
    const { container } = await renderCard(
      makeRequest({ allowedChoices: ["allow-once", "deny-once"] }),
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
    expect(container.querySelector('[data-testid="docked-approval-overlay"]')).toBeNull();
  });
});
