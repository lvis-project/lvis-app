/**
 * `/allow <sentence>` end to end through the real renderer — issue #1940.
 *
 * These drive the actual composer of the actual App: the text goes through
 * `useMessageQueue`'s submit path, `useApprovalSentence`'s interceptor, the
 * `window.lvis.approval.selectSentence` bridge, and lands (or fails to land)
 * on the real `DockedApprovalCard`. Nothing here unit-tests the parser.
 *
 * The property under test is the one the whole design rests on: **the sentence
 * fills the form and the button grants.** A `/allow` that reached `respond`
 * would be a grant channel, and every assertion below that checks
 * `approval.respond` was not called is checking exactly that.
 */
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";
import { submitChatMessage } from "./helpers.js";

const TARGET = "/home/ken/reports/q3.md";
const PARENT = "/home/ken/reports";

function approvalRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-allow-1",
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
      currentAllowed: ["/home/ken/work"],
      adjacencyWarnings: [],
    },
    ...overrides,
  };
}

/** Render the app, raise a directory approval, and wait for the card. */
async function appWithPendingApproval() {
  const app = await renderApp({ hasApiKey: true });
  await act(async () => {
    app.emitApproval(approvalRequest());
  });
  await waitFor(() =>
    expect(app.container.querySelector('[data-testid="approval-dock"]')).toBeTruthy(),
  );
  return app;
}

const choice = (container: HTMLElement, name: string) =>
  container.querySelector(`[data-testid="docked-approval-choice-${name}"]`) as HTMLButtonElement | null;

const systemText = (container: HTMLElement) => container.textContent ?? "";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/allow — the sentence fills the form", () => {
  it("pre-selects the scope the host chose, and grants nothing until the button is pressed", async () => {
    const app = await appWithPendingApproval();
    const ns = window.lvis as unknown as {
      approval: { selectSentence: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn> };
    };
    ns.approval.selectSentence.mockResolvedValueOnce({
      ok: true,
      requestId: "req-allow-1",
      choice: "allow-always",
    });

    await submitChatMessage(app.container, "/allow 이 폴더는 앞으로 계속 열어도 돼");

    // The host was asked with the pending request's id and the raw sentence.
    await waitFor(() => expect(ns.approval.selectSentence).toHaveBeenCalledTimes(1));
    expect(ns.approval.selectSentence.mock.calls[0][0]).toBe("req-allow-1");
    expect(ns.approval.selectSentence.mock.calls[0][1]).toContain("/allow");

    // Focus moved onto the proposed button, and the target line moved with it
    // — the user reads the parent directory before confirming it.
    await waitFor(() =>
      expect(choice(app.container, "allow-always")?.dataset.proposed).toBe("true"),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(choice(app.container, "allow-always")),
    );
    expect(
      app.container.querySelector('[data-testid="docked-approval-target"]')?.textContent,
    ).toContain(PARENT);

    // THE point: nothing has been decided. The card is still up.
    expect(ns.approval.respond).not.toHaveBeenCalled();
    expect(app.container.querySelector('[data-testid="approval-dock"]')).toBeTruthy();

    // Only the press decides.
    await act(async () => {
      choice(app.container, "allow-always")!.click();
    });
    await waitFor(() => expect(ns.approval.respond).toHaveBeenCalledTimes(1));
    expect(ns.approval.respond.mock.calls[0][0]).toMatchObject({
      requestId: "req-allow-1",
      choice: "allow-always",
      rememberPattern: PARENT,
    });
  });

  it("never sends the sentence to the model as a chat message", async () => {
    const app = await appWithPendingApproval();
    const ns = window.lvis as unknown as {
      approval: { selectSentence: ReturnType<typeof vi.fn> };
    };
    ns.approval.selectSentence.mockResolvedValueOnce({
      ok: true,
      requestId: "req-allow-1",
      choice: "allow-once",
    });

    await submitChatMessage(app.container, "/allow 한 번만 허용");

    await waitFor(() => expect(ns.approval.selectSentence).toHaveBeenCalledTimes(1));
    // An approval sentence is a control gesture, not conversation. It must not
    // reach the turn — and while an approval is pending the turn is suspended,
    // so an un-intercepted `/allow` would sit in the mid-turn queue and be
    // delivered to the model minutes later, out of context.
    expect(app.api.chatSend).not.toHaveBeenCalled();
  });

  it("ignores a proposal for a scope this request does not offer", async () => {
    // A remote-controller request is narrowed to one-shot or deny. A proposal
    // naming `allow-always` is not approximated down to something adjacent —
    // it is dropped, and the user is left on the narrowest button.
    const app = await renderApp({ hasApiKey: true });
    await act(async () => {
      app.emitApproval(
        approvalRequest({ allowedChoices: ["allow-once", "deny-once"] }),
      );
    });
    await waitFor(() =>
      expect(app.container.querySelector('[data-testid="approval-dock"]')).toBeTruthy(),
    );
    const ns = window.lvis as unknown as {
      approval: { selectSentence: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn> };
    };
    ns.approval.selectSentence.mockResolvedValueOnce({
      ok: true,
      requestId: "req-allow-1",
      choice: "allow-always",
    });

    await submitChatMessage(app.container, "/allow 앞으로 계속 허용");

    await waitFor(() => expect(ns.approval.selectSentence).toHaveBeenCalledTimes(1));
    expect(choice(app.container, "allow-always")).toBeNull();
    expect(choice(app.container, "allow-once")?.tabIndex).toBe(0);
    expect(app.container.querySelector('[data-testid="approval-dock"]')?.contains(document.activeElement)).toBe(false);
    expect(ns.approval.respond).not.toHaveBeenCalled();
  });
});

describe("/allow — every failure is plain, and none of it is a grant", () => {
  it("does not invoke the filesystem scope selector for a generic tool approval", async () => {
    const app = await renderApp({ hasApiKey: true });
    const ns = window.lvis as unknown as {
      approval: { selectSentence: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn> };
    };
    await act(async () => {
      app.emitApproval(approvalRequest({
        id: "req-generic-tool",
        kind: "tool",
        toolName: "bash",
        outOfAllowedDir: undefined,
      }));
    });
    await waitFor(() =>
      expect(app.container.querySelector('[data-testid="tool-approval-panel"]')).toBeTruthy(),
    );

    await submitChatMessage(app.container, "/allow this folder");

    expect(ns.approval.selectSentence).not.toHaveBeenCalled();
    expect(ns.approval.respond).not.toHaveBeenCalled();
    expect(app.api.chatSend).not.toHaveBeenCalled();
    expect(app.container.querySelector("[data-proposed]")).toBeNull();
    expect(app.container.querySelector('[data-testid="approval-dock"]')).toBeTruthy();
  });

  it.each([
    ["no clear match", "allow-no-match"],
    ["no provider configured", "allow-selector-unavailable"],
    ["selection failed", "allow-selection-failed"],
    ["stale request id", "allow-no-pending-request"],
  ])("surfaces %s as ordinary text and decides nothing", async (_label, code) => {
    const app = await appWithPendingApproval();
    const ns = window.lvis as unknown as {
      approval: { selectSentence: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn> };
    };
    ns.approval.selectSentence.mockResolvedValueOnce({ ok: false, error: code });

    await submitChatMessage(app.container, "/allow 허용해줘");

    await waitFor(() => expect(ns.approval.selectSentence).toHaveBeenCalledTimes(1));
    // Nothing decided, nothing pre-selected, card untouched.
    await waitFor(() => expect(ns.approval.respond).not.toHaveBeenCalled());
    expect(app.container.querySelector("[data-proposed]")).toBeNull();
    expect(choice(app.container, "allow-once")?.tabIndex).toBe(0);
    expect(app.container.querySelector('[data-testid="approval-dock"]')?.contains(document.activeElement)).toBe(false);
    // The raw kebab code never reaches the user.
    expect(systemText(app.container)).not.toContain(code);
  });

  it("says so plainly when nothing is waiting, and does not talk to the model", async () => {
    const app = await renderApp({ hasApiKey: true });
    const ns = window.lvis as unknown as {
      approval: { selectSentence: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn> };
    };

    await submitChatMessage(app.container, "/allow 그 폴더 허용해줘");

    // No pending prompt ⇒ answered locally; the host is never asked, because
    // there is no request id to ask about.
    await waitFor(() => expect(systemText(app.container)).toContain("/allow"));
    expect(ns.approval.selectSentence).not.toHaveBeenCalled();
    expect(ns.approval.respond).not.toHaveBeenCalled();
    expect(app.api.chatSend).not.toHaveBeenCalled();
  });

  it("drops a proposal that arrives after its request is gone", async () => {
    const app = await appWithPendingApproval();
    const ns = window.lvis as unknown as {
      approval: { selectSentence: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn> };
    };
    let release!: (v: unknown) => void;
    ns.approval.selectSentence.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    await submitChatMessage(app.container, "/allow 계속 허용");
    await waitFor(() => expect(ns.approval.selectSentence).toHaveBeenCalledTimes(1));

    // The user answers the prompt by hand while the selector is still thinking.
    await act(async () => {
      choice(app.container, "deny-once")!.click();
    });
    await waitFor(() => expect(ns.approval.respond).toHaveBeenCalledTimes(1));

    // The late proposal must not pre-select anything on whatever comes next.
    await act(async () => {
      release({ ok: true, requestId: "req-allow-1", choice: "allow-always" });
      await Promise.resolve();
    });
    expect(app.container.querySelector("[data-proposed]")).toBeNull();
    expect(ns.approval.respond).toHaveBeenCalledTimes(1);
  });

  it("never carries a proposal from one FIFO head onto the next request", async () => {
    const app = await appWithPendingApproval();
    const ns = window.lvis as unknown as {
      approval: { selectSentence: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn> };
    };
    ns.approval.selectSentence.mockResolvedValueOnce({
      ok: true,
      requestId: "req-allow-1",
      choice: "allow-always",
    });

    await act(async () => {
      app.emitApproval(approvalRequest({
        id: "req-allow-2",
        outOfAllowedDir: {
          candidatePath: "/home/ken/reports/q4.md",
          suggestedParent: "/home/ken/reports",
          currentAllowed: ["/home/ken/work"],
          adjacencyWarnings: [],
        },
      }));
    });

    await submitChatMessage(app.container, "/allow continue for this folder");
    await waitFor(() =>
      expect(choice(app.container, "allow-always")?.dataset.proposed).toBe("true"),
    );

    await act(async () => {
      choice(app.container, "deny-once")!.click();
    });
    await waitFor(() =>
      expect(
        app.container.querySelector('[data-testid="approval-dock"]')
          ?.getAttribute("data-approval-request-id"),
      ).toBe("req-allow-2"),
    );

    expect(app.container.querySelector("[data-proposed]")).toBeNull();
    expect(choice(app.container, "allow-once")?.tabIndex).toBe(0);
    expect(choice(app.container, "allow-always")?.tabIndex).toBe(-1);
    expect(
      app.container.querySelector('[data-testid="docked-approval-target"]')?.textContent,
    ).toContain("/home/ken/reports/q4.md");
    expect(ns.approval.respond).toHaveBeenCalledTimes(1);
  });
});
