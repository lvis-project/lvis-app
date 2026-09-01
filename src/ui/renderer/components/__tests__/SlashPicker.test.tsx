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
    actions: [],
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
  it("puts the shortcuts flat and the long lists behind their own submenus", async () => {
    const bridge = installMenuBridge();
    const run = vi.fn();
    const { getByTestId } = renderPicker({
      actions: [{ id: "board", label: "업무 보드", run }],
      plugins: [{ viewKey: "meeting", label: "미팅" } as never],
    });

    fireEvent.click(getByTestId(TEST_IDS.slashPickerTrigger));
    await waitFor(() => expect(bridge.showDynamicMenu).toHaveBeenCalledOnce());
    const payload = bridge.showDynamicMenu.mock.calls[0]![0] as DynamicNativeMenuPayload;

    // What the user reaches for constantly is one click away; what depends on
    // what is installed is one level down. A native menu cannot filter, so this
    // shape is the whole navigation.
    const [shortcuts, categories] = payload.sections;
    expect(shortcuts!.items.map((item) => item.label)).toEqual(["업무 보드"]);
    expect(shortcuts!.items.every((item) => item.submenu === undefined)).toBe(true);
    expect(categories!.items.every((item) => (item.submenu?.length ?? 0) > 0)).toBe(true);

    // An empty category is left out rather than shown empty: a row that never
    // opens teaches the user the menu is broken.
    const categoryIds = categories!.items.map((item) => item.id);
    expect(categoryIds).toContain("category:command");
    expect(categoryIds).toContain("category:plugin");
    expect(categoryIds).not.toContain("category:mcp");
    expect(categoryIds).not.toContain("category:skills");
  });

  it("runs the row main names back, and only that row", async () => {
    const bridge = installMenuBridge();
    const run = vi.fn();
    const onInsert = vi.fn();
    const onSelectPlugin = vi.fn();
    const { getByTestId } = renderPicker({
      actions: [{ id: "board", label: "업무 보드", run }],
      plugins: [{ viewKey: "meeting", label: "미팅" } as never],
      onInsert,
      onSelectPlugin,
    });

    fireEvent.click(getByTestId(TEST_IDS.slashPickerTrigger));
    await waitFor(() => expect(bridge.showDynamicMenu).toHaveBeenCalledOnce());
    const payload = bridge.showDynamicMenu.mock.calls[0]![0] as DynamicNativeMenuPayload;
    const rows = payload.sections.flatMap((section) => flatten(section.items));

    act(() => { bridge.fire({ requestId: payload.requestId, id: "command:/new" }); });
    expect(onInsert).toHaveBeenCalledWith("/new ");

    // An id from a DIFFERENT request must not reach this call's handlers.
    act(() => { bridge.fire({ requestId: "some-other-request", id: "shortcut:board" }); });
    expect(run).not.toHaveBeenCalled();

    expect(rows.some((row) => row.id === "plugin:meeting")).toBe(true);
    expect(onSelectPlugin).not.toHaveBeenCalled();
  });

  it("opens the same menu when the shortcut raises it", async () => {
    const bridge = installMenuBridge();
    const onOpenChange = vi.fn();
    const { rerender } = renderPicker({ open: false, onOpenChange });
    expect(bridge.showDynamicMenu).not.toHaveBeenCalled();

    rerender(
      <TooltipProvider>
        <SlashPicker
          actions={[]}
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
  });
});
