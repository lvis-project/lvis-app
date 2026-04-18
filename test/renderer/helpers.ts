/**
 * Common test helpers for renderer test files.
 */
import { act, fireEvent } from "@testing-library/react";

/**
 * Submits a chat message by typing into the main composer textarea and
 * pressing Enter. Mirrors the pattern previously duplicated across
 * chat-edit-resend.test.tsx and chat-retry-effort.test.tsx.
 */
export async function submitChatMessage(
  container: HTMLElement,
  text: string,
): Promise<void> {
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement | null;
  if (!textarea) throw new Error("main composer textarea not found");
  await act(async () => {
    fireEvent.change(textarea, { target: { value: text } });
  });
  await act(async () => {
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
  });
}
