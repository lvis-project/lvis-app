/**
 * Common test helpers for renderer test files.
 */
import { createElement, type ReactElement } from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import type { MessageQueueStore } from "../../src/ui/renderer/state/message-queue-store.js";
import { SETTINGS_TABS } from "../../src/shared/settings-tabs.js";
import { MOCK_DEFAULT_SETTINGS } from "./mock-lvis-api.js";
import type { ToolActivityState } from "../../src/ui/renderer/components/ToolActivity.js";
import { ApprovalSurfaceClaims, type ApprovalSurfaceContextValue } from "../../src/ui/renderer/hooks/use-approval.js";
import { expect, vi } from "vitest";
export { relativeLuminance } from "../contrast-helpers.js";

/**
 * An approval surface with nothing pending, for components that draw their
 * own approval dock (SideChatView, ChatView) rendered outside App.
 */
export function approvalSurfaceStub(): ApprovalSurfaceContextValue {
  return {
    queue: [],
    decide: vi.fn(async () => undefined),
    dropSettled: vi.fn(),
    claims: new ApprovalSurfaceClaims(),
    openPermanentDeny: vi.fn(),
    lockedRequestId: null,
    proposal: null,
  };
}

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

/** One open tile: its chat group id and the element its content renders in. */
export interface RenderedTile {
  chatGroupId: string;
  /** The tile's cell — everything that tile renders is inside it. */
  element: HTMLElement;
}

/**
 * Every tile the view is SHOWING, in layout order.
 *
 * The `pane-cell:` testid prefix — and the slice that recovers the chat
 * group id from it — is this one place, so a test that needs the open tiles
 * never has to restate the naming scheme.
 *
 * A conversation the view is not showing keeps its tile mounted (its turn keeps
 * its stream subscription that way) and marks it `data-hidden`. Those are not
 * "open tiles" to a reader, so they are left out here; {@link mountedTileIds}
 * is for the tests that are about them.
 */
export function collectTiles(container: HTMLElement): RenderedTile[] {
  const prefix = "pane-cell:";
  return Array.from(container.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`))
    .filter((element) => element.getAttribute("data-hidden") !== "true")
    .map((element) => ({
      chatGroupId: element.getAttribute("data-testid")!.slice(prefix.length),
      element,
    }));
}

/** Every chat group that still has a mounted tile, shown or hidden. */
export function mountedTileIds(container: HTMLElement): string[] {
  const prefix = "pane-cell:";
  return Array.from(container.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`))
    .map((element) => element.getAttribute("data-testid")!.slice(prefix.length));
}

/**
 * Halve the window into a second tile and hand back both, in layout order.
 *
 * The split control lives in each tile's header, so this drives the same
 * gesture a user would. Tests that need two CONVERSATIONS want this: the mock
 * api gives every non-primary group its own session id. Focus follows a split,
 * so the SECOND tile is the focused one on return.
 */
export async function splitIntoTwoTiles(container: HTMLElement): Promise<RenderedTile[]> {
  return splitWith(container, container, 2);
}

/**
 * Split twice — the window, then the tile the first split focused — and hand
 * back all three, in layout order. Three conversations, three session ids.
 */
export async function splitIntoThreeTiles(container: HTMLElement): Promise<RenderedTile[]> {
  return splitIntoNTiles(container, 3);
}

/** Split until `count` tiles are open, each split taken from the newest tile. */
export async function splitIntoNTiles(
  container: HTMLElement,
  count: number,
): Promise<RenderedTile[]> {
  let tiles = await splitIntoTwoTiles(container);
  for (let open = 3; open <= count; open += 1) {
    tiles = await splitWith(container, tiles[tiles.length - 1]!.element, open);
  }
  return tiles;
}

async function splitWith(
  container: HTMLElement,
  holder: HTMLElement,
  expectedTiles: number,
): Promise<RenderedTile[]> {
  const split = holder.querySelector<HTMLButtonElement>('[data-testid="pane-split"]');
  if (!split) throw new Error("no pane split control");
  await act(async () => {
    fireEvent.click(split);
  });
  // The split control opens a direction choice (portaled, so it is looked up
  // on the document); either direction yields one more tile.
  const sideBySide = document.querySelector<HTMLButtonElement>('[data-testid="pane-split-row"]');
  if (!sideBySide) throw new Error("no split direction choice");
  await act(async () => {
    fireEvent.click(sideBySide);
  });
  const tiles = collectTiles(container);
  if (tiles.length !== expectedTiles) {
    throw new Error(`expected ${expectedTiles} tiles, got ${tiles.length}`);
  }
  return tiles;
}

/**
 * Show one tile alone, or restore the split. Every other tile UNMOUNTS while a
 * tile is maximized, which is one of the ways a card's origin conversation can
 * stop being on screen.
 */
export async function toggleTileMaximized(tile: RenderedTile): Promise<void> {
  const button = tile.element.querySelector<HTMLButtonElement>('[data-testid="pane-maximize"]');
  if (!button) throw new Error(`tile ${tile.chatGroupId} has no maximize control`);
  await act(async () => {
    fireEvent.click(button);
  });
}

/**
 * Make every element report an overflowing summary.
 *
 * jsdom computes no layout, so `scrollHeight` and `clientHeight` are both 0 and
 * the card's expand toggle never appears. Returns the undo.
 */
export function forceOverflowingSummaries(): () => void {
  const scrollDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  const clientDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 120 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 40 });
  return () => {
    if (scrollDesc) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollDesc);
    if (clientDesc) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientDesc);
  };
}

/** Move focus to a tile the way clicking into it does. */
export async function focusTile(tile: RenderedTile): Promise<void> {
  const frame = tile.element.querySelector<HTMLElement>('[data-testid="pane"]');
  if (!frame) throw new Error(`tile ${tile.chatGroupId} has no frame`);
  await act(async () => {
    fireEvent.mouseDown(frame);
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
 * A tool activity state with nothing in it.
 *
 * Shared because two tests need the same empty starting point for different
 * reasons — one exercises item routing after filling a list in, the other
 * asserts the collapsed rail's placement in the floating lane. Two copies would
 * let a change to `ToolActivityState` be fixed in one and rot in the
 * other.
 */
export function emptyToolActivity(): ToolActivityState {
  return {
    readFileCount: 0,
    changedFileCount: 0,
    mcpCallCount: 0,
    pluginCallCount: 0,
    toolCallCount: 0,
    fetchedPageCount: 0,
    readFiles: [],
    changedFiles: [],
    pluginCalls: [],
    mcpCalls: [],
    toolCalls: [],
    fetchedPages: [],
  };
}

/** Render a component that uses shadcn tooltips — they require the provider above them. */
export function renderWithTooltipProvider(ui: ReactElement) {
  return render(createElement(TooltipProvider, null, ui));
}

/** Sidebar nav group whose flyout holds a row: the built-in views or the plugin rows. */
export type SidebarNavGroup = "features" | "plugins";

function sidebarGroupMenu(group: SidebarNavGroup): HTMLElement | null {
  return document.querySelector(`[data-testid="sidebar-group-${group}-menu"]`);
}

/**
 * Opens a sidebar nav group's flyout and returns its menu. The rows render in
 * a portal, so they are read from `document`, never from the render container.
 */
export async function openSidebarGroup(group: SidebarNavGroup): Promise<HTMLElement> {
  const trigger = await waitFor(() => {
    const el = document.querySelector<HTMLButtonElement>(`[data-testid="sidebar-group-${group}"]`);
    expect(el, `missing sidebar group ${group}`).not.toBeNull();
    return el!;
  });
  if (trigger.getAttribute("aria-expanded") !== "true") {
    await act(async () => {
      fireEvent.click(trigger);
    });
  }
  return await waitFor(() => {
    const menu = sidebarGroupMenu(group);
    expect(menu, `flyout of ${group} did not open`).not.toBeNull();
    return menu!;
  });
}

export async function closeSidebarGroup(group: SidebarNavGroup): Promise<void> {
  const menu = sidebarGroupMenu(group);
  if (!menu) return;
  await act(async () => {
    fireEvent.keyDown(menu, { key: "Escape" });
  });
  await waitFor(() => expect(sidebarGroupMenu(group)).toBeNull());
}

/**
 * Picks a row the way the user does: open the flyout, click, and let it close.
 *
 * `modifiers` is how the SECOND destination is reached — a meta/ctrl click is
 * "open in a new pane", the same event the row's context menu performs.
 */
export async function clickSidebarNavRow(
  group: SidebarNavGroup,
  rowTestId: string,
  modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {},
): Promise<void> {
  const menu = await openSidebarGroup(group);
  const row = menu.querySelector<HTMLButtonElement>(`[data-testid="${rowTestId}"]`);
  expect(row, `missing [data-testid="${rowTestId}"] in the ${group} flyout`).not.toBeNull();
  await act(async () => {
    fireEvent.click(row!, modifiers);
  });
  await waitFor(() => expect(sidebarGroupMenu(group)).toBeNull());
}

/** Whether a flyout row is the current page — opens and closes the flyout to read it. */
export async function sidebarNavRowActive(group: SidebarNavGroup, rowTestId: string): Promise<boolean> {
  const menu = await openSidebarGroup(group);
  const active = menu.querySelector(`[data-testid="${rowTestId}"]`)?.getAttribute("aria-current") === "page";
  await closeSidebarGroup(group);
  return active;
}
