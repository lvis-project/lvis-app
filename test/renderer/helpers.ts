/**
 * Common test helpers for renderer test files.
 */
import { act, fireEvent } from "@testing-library/react";
import type { MessageQueueStore } from "../../src/ui/renderer/state/message-queue-store.js";
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

/**
 * The live message-queue store, which `use-message-queue` publishes on `window`
 * under dev+e2e. Render with `lvisEnv: { isDev: true, isE2E: true }` for it to
 * be defined.
 */
export function getQueueStore(): MessageQueueStore | undefined {
  return (window as unknown as { __lvis_message_queue_store__?: MessageQueueStore })
    .__lvis_message_queue_store__;
}

/** Drops the published store so one test's queue cannot leak into the next. */
export function clearQueueStoreHandle(): void {
  delete (window as unknown as { __lvis_message_queue_store__?: unknown })
    .__lvis_message_queue_store__;
}
