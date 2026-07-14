import { beforeEach, describe, expect, it, vi } from "vitest";
import { UI } from "../../../shared/ipc-channels.js";

const {
  handlers,
  popupMock,
  sendMock,
  isDestroyedMock,
  getURLMock,
  fromWebContentsMock,
  auditLogMock,
  menuTemplates,
} = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  popupMock: vi.fn(),
  sendMock: vi.fn(),
  isDestroyedMock: vi.fn(() => false),
  getURLMock: vi.fn(() => "file:///app/index.html"),
  fromWebContentsMock: vi.fn(),
  auditLogMock: vi.fn(),
  menuTemplates: [] as unknown[],
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  BrowserWindow: {
    fromWebContents: fromWebContentsMock,
  },
  Menu: {
    buildFromTemplate: vi.fn((template: unknown) => {
      menuTemplates.push(template);
      return { popup: popupMock };
    }),
  },
}));

function invoke(channel: string, ...args: unknown[]): unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return fn(...args);
}

function makeEvent(url = "file:///app/index.html") {
  getURLMock.mockReturnValue(url);
  return {
    sender: {
      isDestroyed: isDestroyedMock,
      send: sendMock,
      getURL: getURLMock,
    },
    senderFrame: {
      url,
    },
  };
}

async function setup() {
  handlers.clear();
  vi.clearAllMocks();
  menuTemplates.length = 0;
  fromWebContentsMock.mockReturnValue({ isDestroyed: vi.fn(() => false) });
  const { registerUiHandlers } = await import("../ui.js");
  registerUiHandlers({
    auditLogger: { log: auditLogMock },
    getMainWindow: vi.fn(),
  } as never);
}

function firstTemplate() {
  return menuTemplates[0] as Array<{
    label?: string;
    type?: string;
    enabled?: boolean;
    checked?: boolean;
    click?: () => void;
    submenu?: Array<{
      label?: string;
      type?: string;
      enabled?: boolean;
      checked?: boolean;
      click?: () => void;
    }>;
  }>;
}

describe("ui IPC handlers", () => {
  beforeEach(async () => {
    await setup();
  });

  it("shows the assistant context native menu with normalized template and popup coordinates", () => {
    const event = makeEvent();

    const result = invoke(UI.assistantContextMenu, event, {
      requestId: "req-1",
      x: 10.4,
      y: 20.6,
      personas: [{ id: "default", name: "기본" }],
      activePersonaId: "default",
    });

    expect(result).toEqual({ ok: true });
    expect(popupMock).toHaveBeenCalledWith({
      window: expect.objectContaining({ isDestroyed: expect.any(Function) }),
      x: 10,
      y: 21,
    });
    const template = firstTemplate();
    expect(template[0]?.label).toBe("Persona");
    expect(template[0]?.submenu?.[0]).toMatchObject({
      label: "기본",
      type: "radio",
      checked: true,
    });
  });

  it("emits typed actions for each native menu click", () => {
    const event = makeEvent();

    invoke(UI.assistantContextMenu, event, {
      requestId: "req-2",
      x: 1,
      y: 2,
      personas: [{ id: "coding", name: "코딩" }],
      activePersonaId: "",
    });

    const template = firstTemplate();
    template[0]?.submenu?.[0]?.click?.();

    expect(sendMock).toHaveBeenCalledWith(UI.assistantContextAction, {
      requestId: "req-2",
      kind: "persona",
      id: "coding",
    });
  });

  it("builds generic native commands in canonical order and emits typed click actions", () => {
    const event = makeEvent();

    const result = invoke(UI.nativeContextMenu, event, {
      requestId: "native-1",
      x: 10.4,
      y: 20.6,
      kind: "project",
      commands: [
        "project.remove",
        "project.reveal",
        "project.new-chat",
        "project.pin",
      ],
    });

    expect(result).toEqual({ ok: true });
    expect(popupMock).toHaveBeenCalledWith({
      window: expect.objectContaining({ isDestroyed: expect.any(Function) }),
      x: 10,
      y: 21,
    });

    const template = firstTemplate();
    expect(template.map((item) => item.type ?? "command")).toEqual([
      "command",
      "separator",
      "command",
      "command",
      "separator",
      "command",
    ]);
    for (const item of template) item.click?.();

    expect(sendMock.mock.calls.map(([, action]) => action)).toEqual([
      { requestId: "native-1", command: "project.new-chat" },
      { requestId: "native-1", command: "project.pin" },
      { requestId: "native-1", command: "project.reveal" },
      { requestId: "native-1", command: "project.remove" },
    ]);
    expect(sendMock.mock.calls.every(([channel]) => channel === UI.nativeContextAction)).toBe(true);
  });

  it("builds conversation commands in canonical order and emits typed click actions", () => {
    const event = makeEvent();

    const result = invoke(UI.nativeContextMenu, event, {
      requestId: "conversation-1",
      x: 4,
      y: 8,
      kind: "conversation",
      commands: ["conversation.unpin", "conversation.open"],
    });

    expect(result).toEqual({ ok: true });
    const template = firstTemplate();
    expect(template.map((item) => item.type ?? "command")).toEqual([
      "command",
      "separator",
      "command",
    ]);
    for (const item of template) item.click?.();

    expect(sendMock.mock.calls.map(([, action]) => action)).toEqual([
      { requestId: "conversation-1", command: "conversation.open" },
      { requestId: "conversation-1", command: "conversation.unpin" },
    ]);
  });

  it("builds command item actions in canonical order", () => {
    const event = makeEvent();

    const result = invoke(UI.nativeContextMenu, event, {
      requestId: "command-1",
      x: 4,
      y: 8,
      kind: "command-item",
      commands: ["command.copy", "command.activate"],
    });

    expect(result).toEqual({ ok: true });
    const template = firstTemplate();
    expect(template.map((item) => item.type ?? "command")).toEqual([
      "command",
      "separator",
      "command",
    ]);
    for (const item of template) item.click?.();

    expect(sendMock.mock.calls.map(([, action]) => action)).toEqual([
      { requestId: "command-1", command: "command.activate" },
      { requestId: "command-1", command: "command.copy" },
    ]);
  });

  it.each([
    ["cross-kind command", ["project.pin"]],
    ["unknown command", ["message.unknown"]],
    ["empty commands", []],
  ])("rejects native context payloads with %s", (_caseName, commands) => {
    const result = invoke(UI.nativeContextMenu, makeEvent(), {
      requestId: "native-invalid",
      x: 1,
      y: 2,
      kind: "message",
      commands,
    });

    expect(result).toEqual({ ok: false, error: "invalid-native-context-menu" });
    expect(popupMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects malformed payloads without opening a menu", () => {
    const result = invoke(UI.assistantContextMenu, makeEvent(), {
      requestId: "req-3",
      x: 1,
      y: 2,
      personas: "bad",
    });

    expect(result).toEqual({ ok: false, error: "invalid-assistant-context-menu" });
    expect(popupMock).not.toHaveBeenCalled();
  });

  it("rejects plugin shell or child-frame senders", () => {
    const pluginResult = invoke(
      UI.assistantContextMenu,
      makeEvent("file:///app/plugin-ui-shell.html"),
      { requestId: "req-4", x: 1, y: 2, personas: [] },
    );
    expect(pluginResult).toEqual({ ok: false, error: "unauthorized-frame" });

    const iframeEvent = makeEvent("file:///app/index.html");
    getURLMock.mockReturnValue("file:///app/host.html");
    const iframeResult = invoke(
      UI.assistantContextMenu,
      iframeEvent,
      { requestId: "req-5", x: 1, y: 2, personas: [] },
    );

    expect(iframeResult).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(auditLogMock).toHaveBeenCalled();
    expect(popupMock).not.toHaveBeenCalled();
  });
});
