/**
 * Common test helpers for renderer test files.
 */
import { act, fireEvent } from "@testing-library/react";
import type { MessageQueueStore } from "../../src/ui/renderer/state/message-queue-store.js";
import { SETTINGS_TABS } from "../../src/shared/settings-tabs.js";
import { MOCK_DEFAULT_SETTINGS } from "./mock-lvis-api.js";
import type { ActionPanelActivityState } from "../../src/ui/renderer/components/ActionPanel.js";
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

/**
 * Halve the window into a second tile and hand back both frames.
 *
 * The split control lives in each tile's header, so this drives the same
 * gesture a user would. Tests that need two CONVERSATIONS want this: the mock
 * api gives every non-primary group its own session id.
 */
export async function splitIntoTwoTiles(container: HTMLElement): Promise<HTMLElement[]> {
  const split = container.querySelector<HTMLButtonElement>('[data-testid="chat-group-split"]');
  if (!split) throw new Error("no chat-group split control");
  await act(async () => {
    fireEvent.click(split);
  });
  const tiles = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="chat-group"]'));
  if (tiles.length !== 2) throw new Error(`expected 2 tiles, got ${tiles.length}`);
  return tiles;
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

/**
 * Settings-tab helpers.
 *
 * Radix names a tab trigger `${baseId}-trigger-${value}`, so these address the
 * settings tabs by their settings-tab id rather than their localized label, and
 * they ignore unrelated tablists elsewhere in the app shell (the sidebar's
 * Chats/Projects control is also `role="tab"`).
 */
export function settingsTabTrigger(container: HTMLElement, value: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[role="tab"][id$="-trigger-${value}"]`);
  if (!el) throw new Error(`no settings tab trigger for "${value}"`);
  return el;
}

/** Radix commits a tab on primary-button mousedown, not on the click event. */
export function clickSettingsTab(container: HTMLElement, value: string): void {
  const trigger = settingsTabTrigger(container, value);
  fireEvent.mouseDown(trigger, { button: 0 });
  fireEvent.click(trigger);
}

export function activeSettingsTab(container: HTMLElement): string | null {
  for (const value of SETTINGS_TABS) {
    const el = container.querySelector<HTMLElement>(`[role="tab"][id$="-trigger-${value}"]`);
    if (el?.getAttribute("data-state") === "active") return value;
  }
  return null;
}

/**
 * Settings as they would be on disk from a previous run, with the location the
 * app should resume at.
 *
 * Shared because the restore feature and visit history need the SAME fixture:
 * one asserts the app lands there, the other asserts history treats landing
 * there as arrival rather than a step. Two copies would let a change to the
 * persisted shape fix one test and silently rot the other.
 */
export function settingsWithActiveView(activeView: string, settingsTab?: string) {
  return {
    ...MOCK_DEFAULT_SETTINGS,
    system: {
      closeBehavior: "hide-to-tray",
      activeView,
      ...(settingsTab ? { settingsTab } : {}),
    },
  };
}

/**
 * An ActionPanel activity state with nothing in it.
 *
 * Shared because two tests need the same empty starting point for different
 * reasons — one exercises item routing after filling a list in, the other
 * asserts the collapsed rail's placement in the floating lane. Two copies would
 * let a change to `ActionPanelActivityState` be fixed in one and rot in the
 * other.
 */
export function emptyActionPanelActivity(): ActionPanelActivityState {
  return {
    readFileCount: 0,
    writtenFileCount: 0,
    mcpCallCount: 0,
    pluginCallCount: 0,
    toolCallCount: 0,
    fetchedPageCount: 0,
    readFiles: [],
    writtenFiles: [],
    pluginCalls: [],
    mcpCalls: [],
    fetchedPages: [],
  };
}
