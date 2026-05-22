/**
 * Common test helpers for renderer test files.
 */
import { act, fireEvent } from "@testing-library/react";
export { relativeLuminance } from "../contrast-helpers.js";

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

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
