/**
 * Phase 3.2 safety net — edit & resend on user messages.
 *
 * Exercises UserMessageEditor mount/cancel/save flow, failure restoration,
 * and chatEditResend IPC contract. Hover-revealed action buttons are found
 * via title attribute since group-hover:flex hides them in jsdom.
 */
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "./render-app.js";
import { submitChatMessage } from "./helpers.js";

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
});

afterEach(() => {
  vi.unstubAllGlobals();
});
