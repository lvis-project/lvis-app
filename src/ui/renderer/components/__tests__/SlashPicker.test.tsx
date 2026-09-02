// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import type {
  DynamicNativeMenuAction,
  DynamicNativeMenuPayload,
  NativeMenuItem,
} from "../../../../shared/native-context-menu.js";
import { SlashPicker } from "../SlashPicker.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";

const originalLvis = window.lvis;

afterEach(() => {
  Object.defineProperty(window, "lvis", { configurable: true, value: originalLvis });
});

/**
 * The menu itself belongs to the OS: nothing in the page can click a row of it,
 * and no screenshot can show it. What the renderer still owns — and what these
 * tests hold — is the payload it hands main, and what it runs when main names
 * one of its ids back.
 */
function installMenuBridge() {
  let actionHandler: ((action: DynamicNativeMenuAction) => void) | null = null;
  const showDynamicMenu = vi.fn(async () => ({ ok: true as const }));
  Object.defineProperty(window, "lvis", {
    configurable: true,
    value: {
      ...originalLvis,
      ui: {
        ...originalLvis?.ui,
        showDynamicMenu,
        onDynamicMenuAction: (handler: (action: DynamicNativeMenuAction) => void) => {
          actionHandler = handler;
          return () => { actionHandler = null; };
        },
      },
      mcp: { servers: vi.fn(async () => []) },
    },
  });
  (window as unknown as { lvisApi?: unknown }).lvisApi = {
    ...(window as unknown as { lvisApi?: Record<string, unknown> }).lvisApi,
    listSkills: vi.fn(async () => ({ skills: [] })),
  };
  return {
    showDynamicMenu,
    fire: (action: DynamicNativeMenuAction) => actionHandler?.(action),
  };
}

const flatten = (items: NativeMenuItem[]): NativeMenuItem[] =>
  items.flatMap((item) => [item, ...flatten(item.submenu ?? [])]);

function renderPicker(overrides: Partial<Parameters<typeof SlashPicker>[0]> = {}) {
  const props: Parameters<typeof SlashPicker>[0] = {
    plugins: [],
    onSelectPlugin: vi.fn(),
    onInsert: vi.fn(),
    onRunMcpPrompt: vi.fn(),
    open: false,
    onOpenChange: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<TooltipProvider><SlashPicker {...props} /></TooltipProvider>) };
}

describe("SlashPicker", () => {
  it("opens with the submenus and nothing else — no flat block of view shortcuts", async () => {
    const bridge = installMenuBridge();
    const { getByTestId } = renderPicker({
      plugins: [{ viewKey: "meeting", label: "미팅" } as never],
    });

    fireEvent.click(getByTestId(TEST_IDS.slashPickerTrigger));
    await waitFor(() => expect(bridge.showDynamicMenu).toHaveBeenCalledOnce());
    const payload = bridge.showDynamicMenu.mock.calls[0]![0] as DynamicNativeMenuPayload;

    // One section. The menu hangs off the composer, so it holds what goes INTO
    // a message; going home or opening a plugin's page is navigation and has
    // the sidebar. Ten such rows above the divider also pushed the three things
    // the button is for below the fold.
    expect(payload.sections).toHaveLength(1);
    const categories = payload.sections[0]!;
    expect(categories.items.every((item) => (item.submenu?.length ?? 0) > 0)).toBe(true);

    // An empty category is left out rather than shown empty: a row that never
    // opens teaches the user the menu is broken.
    const categoryIds = categories.items.map((item) => item.id);
    expect(categoryIds).toContain("category:command");
    expect(categoryIds).toContain("category:plugin");
    expect(categoryIds).not.toContain("category:mcp");
    expect(categoryIds).not.toContain("category:skills");
    // Nothing anywhere in the menu acts on click without opening a submenu.
    expect(flatten(categories.items).some((item) => item.id.startsWith("shortcut:")))
      .toBe(false);
  });

  it("runs the row main names back, and only that row", async () => {
    const bridge = installMenuBridge();
    const onInsert = vi.fn();
    const onSelectPlugin = vi.fn();
    const { getByTestId } = renderPicker({
      plugins: [{ viewKey: "meeting", label: "미팅" } as never],
      onInsert,
      onSelectPlugin,
    });

    fireEvent.click(getByTestId(TEST_IDS.slashPickerTrigger));
    await waitFor(() => expect(bridge.showDynamicMenu).toHaveBeenCalledOnce());
    const payload = bridge.showDynamicMenu.mock.calls[0]![0] as DynamicNativeMenuPayload;
    const rows = payload.sections.flatMap((section) => flatten(section.items));

    // The forged action comes FIRST, while this request is still pending and its
    // handlers are live. Fired after a legitimate one, it would be rejected by
    // the pending entry already being consumed, and the requestId comparison —
    // the thing under test — would never run.
    act(() => { bridge.fire({ requestId: "some-other-request", id: "plugin:meeting" }); });
    expect(onSelectPlugin).not.toHaveBeenCalled();

    act(() => { bridge.fire({ requestId: payload.requestId, id: "plugin:meeting" }); });
    expect(onSelectPlugin).toHaveBeenCalledOnce();

    // …and the pending entry is single-shot: the row that already reported is
    // not re-runnable.
    act(() => { bridge.fire({ requestId: payload.requestId, id: "command:/new" }); });
    expect(onInsert).not.toHaveBeenCalled();

    expect(rows.some((row) => row.id === "plugin:meeting")).toBe(true);
  });

  it("opens the same menu when the shortcut raises it", async () => {
    const bridge = installMenuBridge();
    const onOpenChange = vi.fn();
    const { rerender } = renderPicker({ open: false, onOpenChange });
    expect(bridge.showDynamicMenu).not.toHaveBeenCalled();

    rerender(
      <TooltipProvider>
        <SlashPicker
          plugins={[]}
          onSelectPlugin={vi.fn()}
          onInsert={vi.fn()}
          onRunMcpPrompt={vi.fn()}
          open
          onOpenChange={onOpenChange}
        />
      </TooltipProvider>,
    );
    await waitFor(() => expect(bridge.showDynamicMenu).toHaveBeenCalledOnce());
    // The OS owns the menu once it is up, so the flag is released immediately —
    // it exists to raise the menu, not to track it.
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    // `onOpenChange` is a spy here, so `open` stays true — exactly the window the
    // real app is in between popping the menu and the parent clearing the flag.
    // Any re-render in that window must NOT pop a second menu.
    rerender(
      <TooltipProvider>
        <SlashPicker
          plugins={[]}
          onSelectPlugin={vi.fn()}
          onInsert={vi.fn()}
          onRunMcpPrompt={vi.fn()}
          open
          onOpenChange={onOpenChange}
        />
      </TooltipProvider>,
    );
    // `openMenu` is async, so a second pop would land a tick later — waiting for
    // "still once" without flushing would pass against a picker that pops twice.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(bridge.showDynamicMenu).toHaveBeenCalledOnce();
  });
});
