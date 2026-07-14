import { beforeEach, describe, expect, it, vi } from "vitest";

type ContextMenuParams = {
  selectionText: string;
  isEditable: boolean;
  editFlags: {
    canCut: boolean;
    canCopy: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
  x: number;
  y: number;
};

type ContextMenuHandler = (
  event: { preventDefault: () => void },
  params: ContextMenuParams,
) => void;

const {
  buildFromTemplateMock,
  fromWebContentsMock,
  popupMock,
  menuTemplates,
} = vi.hoisted(() => ({
  buildFromTemplateMock: vi.fn(),
  fromWebContentsMock: vi.fn(),
  popupMock: vi.fn(),
  menuTemplates: [] as unknown[],
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: fromWebContentsMock,
  },
  Menu: {
    buildFromTemplate: buildFromTemplateMock,
  },
}));

import { installNativeEditContextMenu } from "../native-edit-context-menu.js";

function install() {
  let handler: ContextMenuHandler | undefined;
  const contents = {
    on: vi.fn((eventName: string, callback: ContextMenuHandler) => {
      if (eventName === "context-menu") handler = callback;
    }),
  };
  installNativeEditContextMenu(contents as never);
  if (!handler) throw new Error("context-menu handler was not installed");
  return { contents, handler };
}

function params(overrides: Partial<ContextMenuParams> = {}): ContextMenuParams {
  return {
    selectionText: "",
    isEditable: false,
    editFlags: {
      canCut: false,
      canCopy: false,
      canPaste: false,
      canSelectAll: false,
    },
    x: 12,
    y: 34,
    ...overrides,
  };
}

describe("installNativeEditContextMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    menuTemplates.length = 0;
    buildFromTemplateMock.mockImplementation((template: unknown) => {
      menuTemplates.push(template);
      return { popup: popupMock };
    });
    fromWebContentsMock.mockReturnValue(null);
  });

  it("uses editable roles and opens against the owning window at event coordinates", () => {
    const owner = { id: 7 };
    fromWebContentsMock.mockReturnValue(owner);
    const { contents, handler } = install();
    const preventDefault = vi.fn();

    handler({ preventDefault }, params({
      isEditable: true,
      x: 41,
      y: 59,
      editFlags: {
        canCut: true,
        canCopy: false,
        canPaste: true,
        canSelectAll: false,
      },
    }));

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(menuTemplates[0]).toEqual([
      { role: "cut", enabled: true },
      { role: "copy", enabled: false },
      { role: "paste", enabled: true },
      { type: "separator" },
      { role: "selectAll", enabled: false },
    ]);
    expect(fromWebContentsMock).toHaveBeenCalledWith(contents);
    expect(popupMock).toHaveBeenCalledWith({ window: owner, x: 41, y: 59 });
  });

  it("uses selection roles and falls back to a coordinate-only popup without an owner", () => {
    const { handler } = install();
    const preventDefault = vi.fn();

    handler({ preventDefault }, params({
      selectionText: " selected text ",
      x: 5,
      y: 9,
      editFlags: {
        canCut: false,
        canCopy: false,
        canPaste: false,
        canSelectAll: true,
      },
    }));

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(menuTemplates[0]).toEqual([
      { role: "copy", enabled: true },
      { type: "separator" },
      { role: "selectAll", enabled: true },
    ]);
    expect(popupMock).toHaveBeenCalledWith({ x: 5, y: 9 });
  });

  it("does nothing for non-editable content without a selection", () => {
    const { handler } = install();
    const preventDefault = vi.fn();

    handler({ preventDefault }, params({ selectionText: "   " }));

    expect(preventDefault).not.toHaveBeenCalled();
    expect(buildFromTemplateMock).not.toHaveBeenCalled();
    expect(fromWebContentsMock).not.toHaveBeenCalled();
    expect(popupMock).not.toHaveBeenCalled();
  });
});
