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
      agents: [{ name: "Planner" }],
      skills: [{ name: "Debugger" }],
      personas: [{ id: "default", name: "기본" }],
      activeAgentName: "Planner",
      activeSkillNames: ["Debugger"],
      activePersonaId: "default",
    });

    expect(result).toEqual({ ok: true });
    expect(popupMock).toHaveBeenCalledWith({
      window: expect.objectContaining({ isDestroyed: expect.any(Function) }),
      x: 10,
      y: 21,
    });
    const template = firstTemplate();
    expect(template[0]?.label).toBe("Agent");
    expect(template[0]?.submenu?.[0]?.label).toBe("기본 에이전트");
    expect(template[0]?.submenu?.[1]).toMatchObject({
      label: "Planner",
      type: "radio",
      checked: true,
    });
    expect(template[1]?.submenu?.[0]).toMatchObject({
      label: "스킬 해제",
      enabled: true,
    });
    expect(template[1]?.submenu?.[2]).toMatchObject({
      label: "Debugger",
      type: "checkbox",
      checked: true,
    });
    expect(template[3]?.submenu?.[0]).toMatchObject({
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
      agents: [{ name: "Planner" }],
      skills: [{ name: "Debugger" }],
      personas: [{ id: "coding", name: "코딩" }],
      activeAgentName: "",
      activeSkillNames: [],
      activePersonaId: "",
    });

    const template = firstTemplate();
    template[0]?.submenu?.[1]?.click?.();
    template[1]?.submenu?.[0]?.click?.();
    template[1]?.submenu?.[2]?.click?.();
    template[3]?.submenu?.[0]?.click?.();

    expect(sendMock).toHaveBeenCalledWith(UI.assistantContextAction, {
      requestId: "req-2",
      kind: "agent",
      name: "Planner",
    });
    expect(sendMock).toHaveBeenCalledWith(UI.assistantContextAction, {
      requestId: "req-2",
      kind: "skills-clear",
    });
    expect(sendMock).toHaveBeenCalledWith(UI.assistantContextAction, {
      requestId: "req-2",
      kind: "skill-toggle",
      name: "Debugger",
    });
    expect(sendMock).toHaveBeenCalledWith(UI.assistantContextAction, {
      requestId: "req-2",
      kind: "persona",
      id: "coding",
    });
  });

  it("rejects malformed payloads without opening a menu", () => {
    const result = invoke(UI.assistantContextMenu, makeEvent(), {
      requestId: "req-3",
      x: 1,
      y: 2,
      agents: "bad",
      skills: [],
      personas: [],
    });

    expect(result).toEqual({ ok: false, error: "invalid-assistant-context-menu" });
    expect(popupMock).not.toHaveBeenCalled();
  });

  it("rejects plugin shell or child-frame senders", () => {
    const pluginResult = invoke(
      UI.assistantContextMenu,
      makeEvent("file:///app/plugin-ui-shell.html"),
      { requestId: "req-4", x: 1, y: 2, agents: [], skills: [], personas: [] },
    );
    expect(pluginResult).toEqual({ ok: false, error: "unauthorized-frame" });

    const iframeEvent = makeEvent("file:///app/index.html");
    getURLMock.mockReturnValue("file:///app/host.html");
    const iframeResult = invoke(
      UI.assistantContextMenu,
      iframeEvent,
      { requestId: "req-5", x: 1, y: 2, agents: [], skills: [], personas: [] },
    );

    expect(iframeResult).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(auditLogMock).toHaveBeenCalled();
    expect(popupMock).not.toHaveBeenCalled();
  });
});
