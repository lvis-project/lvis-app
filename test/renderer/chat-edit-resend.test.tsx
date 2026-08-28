/**
 * Safety net for the rewind actions on the user's own message card.
 *
 * Two of them, and they differ by what happens after the rewind:
 *   - edit & resend — UserMessageEditor mount/cancel/save, failure
 *     restoration, and the chatEditResend IPC contract;
 *   - return here — the same rewind with NO resend: the text goes back to the
 *     composer and the conversation stops there.
 *
 * Hover-revealed action buttons are found via title attribute since the
 * group-hover reveal is invisible to jsdom layout.
 */
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "./render-app.js";
import { deferred, submitChatMessage } from "./helpers.js";

describe("Chat edit & resend (Phase 3.2 regression net)", () => {
  it("submitting a user message appends a user entry", async () => {
    const { container, api } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await submitChatMessage(container, "Hello LVIS");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());
    await waitFor(() => {
      expect(container.textContent).toContain("Hello LVIS");
    });
  });

  it("clicking pencil opens UserMessageEditor with the message text", async () => {
    const { container, api } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "first draft" } });
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    });
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    // Pencil button is hover-only; query by its title attribute directly.
    const editBtn = await waitFor(() => {
      const btn = container.querySelector('button[title="편집"]');
      if (!btn) throw new Error("edit button not yet rendered");
      return btn as HTMLButtonElement;
    });
    await act(async () => {
      fireEvent.click(editBtn);
    });
    await waitFor(() => {
      const textareas = container.querySelectorAll("textarea");
      // There should now be 2 textareas: main composer + editor.
      expect(textareas.length).toBeGreaterThanOrEqual(2);
      const editorTa = Array.from(textareas).find(
        (t) => (t as HTMLTextAreaElement).value === "first draft",
      );
      expect(editorTa).toBeTruthy();
    });
  });

  it("cancel closes the editor without firing chatEditResend", async () => {
    const { container, api } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "will cancel" } });
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    });
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    const editBtn = await waitFor(() => {
      const btn = container.querySelector('button[title="편집"]');
      if (!btn) throw new Error("edit button not yet rendered");
      return btn as HTMLButtonElement;
    });
    await act(async () => {
      fireEvent.click(editBtn);
    });
    // Find the cancel button (text: 취소)
    const cancelBtn = await waitFor(() => {
      const btns = Array.from(container.querySelectorAll("button"));
      const btn = btns.find((b) => b.textContent?.trim() === "취소");
      if (!btn) throw new Error("cancel not found");
      return btn;
    });
    await act(async () => {
      fireEvent.click(cancelBtn);
    });
    expect(api.chatEditResend).not.toHaveBeenCalled();
  });

  it("save fires chatEditResend with the new text", async () => {
    const user = userEvent.setup();
    const { container, api } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "original" } });
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    });
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    const editBtn = await waitFor(() => {
      const btn = container.querySelector('button[title="편집"]');
      if (!btn) throw new Error("edit button not yet rendered");
      return btn as HTMLButtonElement;
    });
    await act(async () => {
      fireEvent.click(editBtn);
    });

    // Locate editor textarea and change its text.
    const editorTa = await waitFor(() => {
      const tas = Array.from(container.querySelectorAll("textarea")) as HTMLTextAreaElement[];
      const ta = tas.find((t) => t.value === "original");
      if (!ta) throw new Error("editor not ready");
      return ta;
    });
    await act(async () => {
      fireEvent.change(editorTa, { target: { value: "edited text" } });
    });
    const saveBtn = await waitFor(() => {
      const btns = Array.from(container.querySelectorAll("button"));
      const btn = btns.find((b) => b.textContent?.includes("저장 후 재전송"));
      if (!btn) throw new Error("save not found");
      return btn;
    });
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await waitFor(() => {
      expect(api.chatEditResend).toHaveBeenCalled();
    });
    const [histIdx, text] = (api.chatEditResend.mock.calls[0] ?? []) as unknown[];
    expect(typeof histIdx).toBe("number");
    expect(text).toBe("edited text");
    // Minimally assert userEvent import is usable (future-proofing).
    expect(user).toBeTruthy();
  });

  it("save failure keeps editor open and surfaces error", async () => {
    const { container, api } = await renderApp();
    api.chatEditResend.mockResolvedValueOnce({ ok: false, error: "invalid-index" });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "original" } });
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    });
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    const editBtn = await waitFor(() => {
      const btn = container.querySelector('button[title="편집"]');
      if (!btn) throw new Error("edit button not yet rendered");
      return btn as HTMLButtonElement;
    });
    await act(async () => {
      fireEvent.click(editBtn);
    });

    const editorTa = await waitFor(() => {
      const tas = Array.from(container.querySelectorAll("textarea")) as HTMLTextAreaElement[];
      const ta = tas.find((t) => t.value === "original");
      if (!ta) throw new Error("editor not ready");
      return ta;
    });
    await act(async () => {
      fireEvent.change(editorTa, { target: { value: "retry edit" } });
    });
    const saveBtn = await waitFor(() => {
      const btns = Array.from(container.querySelectorAll("button"));
      const btn = btns.find((b) => b.textContent?.includes("저장 후 재전송"));
      if (!btn) throw new Error("save not found");
      return btn;
    });
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await waitFor(() => expect(api.chatEditResend).toHaveBeenCalled());

    // On failure, the editor stays open (a textarea with "retry edit" value
    // still exists), and the error message is surfaced.
    await waitFor(() => {
      const tas = Array.from(container.querySelectorAll("textarea")) as HTMLTextAreaElement[];
      const stillOpen = tas.some((t) => t.value === "retry edit");
      expect(stillOpen).toBe(true);
      expect(container.textContent).toMatch(/편집 실패|invalid-index/);
    });
  });

  it("restores optimistic rows when a staged-envelope failure rejects", async () => {
    const { container, api, emitChatStream } = await renderApp();
    let rejectEditResend: (reason?: unknown) => void = () => undefined;
    api.chatEditResend.mockImplementationOnce(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectEditResend = reject;
        }),
    );
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "original staged turn" } });
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    });
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());
    await act(async () => {
      emitChatStream({ type: "text_delta", text: "existing assistant reply" });
      emitChatStream({ type: "assistant_round", text: "existing assistant reply" });
      emitChatStream({ type: "done" });
    });

    const editBtn = await waitFor(() => {
      const btn = container.querySelector('button[title="편집"]');
      if (!btn) throw new Error("edit button not yet rendered");
      return btn as HTMLButtonElement;
    });
    await act(async () => {
      fireEvent.click(editBtn);
    });
    const editorTa = await waitFor(() => {
      const tas = Array.from(container.querySelectorAll("textarea")) as HTMLTextAreaElement[];
      const ta = tas.find((t) => t.value === "original staged turn");
      if (!ta) throw new Error("editor not ready");
      return ta;
    });
    await act(async () => {
      fireEvent.change(editorTa, { target: { value: "rejected staged edit" } });
    });
    const saveBtn = await waitFor(() => {
      const btn = Array.from(container.querySelectorAll("button"))
        .find((candidate) => candidate.textContent?.includes("저장 후 재전송"));
      if (!btn) throw new Error("save not found");
      return btn;
    });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    await waitFor(() => expect(api.chatEditResend).toHaveBeenCalled());
    await act(async () => {
      // Main emits the aggregate notice before the DLP-damaged staged header
      // fails closed. It must survive renderer rollback regardless of IPC order.
      emitChatStream({ type: "redact_notice", count: 1, byKind: { PHONE_KR: 1 } });
    });
    await waitFor(() => expect(container.textContent).toContain("PII 1"));
    await act(async () => {
      rejectEditResend(
        new Error("Error invoking remote method 'lvis:chat:edit-resend': Error: missing-app-envelope"),
      );
    });

    await waitFor(() => {
      expect(api.chatEditResend).toHaveBeenCalled();
      expect(container.textContent).toContain("existing assistant reply");
      expect(container.textContent).toContain("missing-app-envelope");
      expect(container.textContent).toContain("PII 1");
      const tas = Array.from(container.querySelectorAll("textarea")) as HTMLTextAreaElement[];
      expect(tas.some((candidate) => candidate.value === "rejected staged edit")).toBe(true);
    });

    const cancelBtn = Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.trim() === "취소");
    expect(cancelBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(cancelBtn!);
    });
    await waitFor(() => {
      expect(container.textContent).toContain("original staged turn");
      expect(container.textContent).toContain("existing assistant reply");
    });
  });
});

describe("Return here — rewind without resending", () => {
  const answeredTurn = {
    sessionId: "sess-default",
    messages: [
      { role: "user" as const, content: "the question I want back" },
      { role: "assistant" as const, content: "an answer to be discarded" },
    ],
  };

  const returnHereButton = (container: HTMLElement) =>
    waitFor(() => {
      const btn = container.querySelector('button[title="여기로 되돌아가기"]');
      if (!btn) throw new Error("return-here button not yet rendered");
      return btn as HTMLButtonElement;
    });

  const composer = (container: HTMLElement) =>
    container.querySelector('[data-testid="composer-textarea"]') as HTMLTextAreaElement;

  it("cuts the persisted history at the message and drops everything after it", async () => {
    const { container, api } = await renderApp({ history: answeredTurn });
    await waitFor(() => expect(container.textContent).toContain("an answer to be discarded"));

    await act(async () => {
      fireEvent.click(await returnHereButton(container));
    });

    // Main truncates at the message's own history index — the message goes too.
    await waitFor(() => expect(api.chatRewindTo).toHaveBeenCalledWith(0));
    await waitFor(() => {
      expect(container.textContent).not.toContain("an answer to be discarded");
      // The bubble goes too — its text is only in the composer now, which is
      // why this asserts on the transcript rather than the whole container.
      expect(container.querySelectorAll('[data-testid="user-message-bubble"]')).toHaveLength(0);
    });
  });

  it("puts the message text back in the composer without sending it", async () => {
    const { container, api } = await renderApp({ history: answeredTurn });
    await waitFor(() => expect(container.textContent).toContain("an answer to be discarded"));

    await act(async () => {
      fireEvent.click(await returnHereButton(container));
    });

    await waitFor(() => expect(composer(container).value).toBe("the question I want back"));
    expect(api.chatSend).not.toHaveBeenCalled();
    expect(api.chatEditResend).not.toHaveBeenCalled();
  });

  it("keeps the transcript when main refuses the rewind", async () => {
    const { container, api } = await renderApp({ history: answeredTurn });
    await waitFor(() => expect(container.textContent).toContain("an answer to be discarded"));
    api.chatRewindTo.mockResolvedValueOnce({ ok: false, error: "streaming-active" });

    await act(async () => {
      fireEvent.click(await returnHereButton(container));
    });

    // formatIpcError turns the wire code into the shared refusal sentence.
    await waitFor(() => expect(container.textContent).toContain("아직 응답을 생성하는 중입니다"));
    expect(container.textContent).toContain("an answer to be discarded");
    expect(composer(container).value).toBe("");
  });

  it("is unavailable while a turn is streaming", async () => {
    const pendingSend = deferred<{ ok: true }>();
    const { container, api } = await renderApp();
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);

    await submitChatMessage(container, "still answering");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    const btn = await returnHereButton(container);
    expect(btn.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(api.chatRewindTo).not.toHaveBeenCalled();

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await pendingSend.promise;
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
