/**
 * lvis:chat:import IPC handler unit tests (#1500 / E3).
 *
 * Strategy: register the chat IPC handlers with a minimal mock memoryManager +
 * a mocked electron `dialog` and `node:fs/promises`, then invoke the import
 * handler directly. Covers the export→import round-trip, the strict
 * GenericMessage shape validation (fail-closed on any unknown field), and the
 * DoS / malformed-file rejection branches. Import ALWAYS mints a brand-new
 * sessionId and NEVER overwrites an existing session.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invokeRegisteredHandler } from "../../../__tests__/test-helpers.js";

const CHANNEL = "lvis:chat:import";
const MAX_SESSION_FILE_BYTES = 5_000_000;

const handlers = new Map<string, (...args: unknown[]) => unknown>();

// Mutable dialog + fs state, reset per test.
const dialogState: { canceled: boolean; filePaths: string[] } = { canceled: false, filePaths: ["/tmp/import.json"] };
const fsState: { size: number; text: string; statThrows: boolean; readThrows: boolean } = {
  size: 100,
  text: "{}",
  statThrows: false,
  readThrows: false,
};

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: dialogState.canceled, filePaths: dialogState.filePaths })),
  },
}));

vi.mock("node:fs/promises", () => ({
  stat: vi.fn(async () => {
    if (fsState.statThrows) throw new Error("ENOENT");
    return { size: fsState.size };
  }),
  readFile: vi.fn(async () => {
    if (fsState.readThrows) throw new Error("EIO");
    return fsState.text;
  }),
}));

vi.mock("../../../audit/dlp-filter.js", () => ({
  redactForLLM: vi.fn((s: string) => ({ redacted: s, totalCount: 0, counts: {} })),
  redactFsPath: vi.fn((s: string) => s),
  redactAuditPayload: vi.fn((p: unknown) => p),
  maskSensitiveData: vi.fn((s: string) => ({ masked: s, findings: [] })),
  initDlpAudit: vi.fn(),
}));
vi.mock("../../../lib/logger.js", () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() })),
}));

interface ImportResult {
  ok: boolean;
  sessionId?: string;
  messageCount?: number;
  error?: string;
  canceled?: boolean;
}

function makeDeps() {
  return {
    conversationLoop: { getSessionId: vi.fn(() => "active"), listSessions: vi.fn(() => []) } as any,
    settingsService: { get: vi.fn(() => ({})), patch: vi.fn(async () => undefined) } as any,
    memoryManager: {
      saveImportedSession: vi.fn(async () => undefined),
      saveSession: vi.fn(async () => undefined),
      saveSessionMetadata: vi.fn(async () => undefined),
    } as any,
    auditLogger: { log: vi.fn() } as any,
    getMainWindow: vi.fn(() => null),
  };
}

async function setup() {
  handlers.clear();
  vi.clearAllMocks();
  const { registerChatHandlers } = await import("../chat.js");
  const deps = makeDeps();
  registerChatHandlers(deps as any);
  return deps;
}

function setFile(obj: unknown): void {
  fsState.text = JSON.stringify(obj);
  fsState.size = Buffer.byteLength(fsState.text);
}

function invoke(): Promise<ImportResult> {
  // event = null → validateSender treats a frame-less internal caller as trusted.
  return Promise.resolve(invokeRegisteredHandler<Promise<ImportResult>>(handlers, CHANNEL));
}

const validExport = {
  sessionId: "original-session-id",
  exportedAt: "2026-07-05T00:00:00.000Z",
  messages: [
    { role: "user", content: "hello there" },
    { role: "assistant", content: "hi back", thought: "reasoning" },
    { role: "tool_result", toolUseId: "tu-1", content: "result", toolName: "Read", isError: false },
  ],
};

beforeEach(() => {
  dialogState.canceled = false;
  dialogState.filePaths = ["/tmp/import.json"];
  fsState.statThrows = false;
  fsState.readThrows = false;
});

describe("lvis:chat:import — success round-trip", () => {
  it("imports a valid export as a BRAND-NEW session (never the original id)", async () => {
    const deps = await setup();
    setFile(validExport);

    const result = await invoke();

    expect(result.ok).toBe(true);
    expect(result.messageCount).toBe(3);
    expect(typeof result.sessionId).toBe("string");
    expect(result.sessionId).not.toBe("original-session-id");
    // saveImportedSession is the new-session, always-main path.
    expect(deps.memoryManager.saveImportedSession).toHaveBeenCalledTimes(1);
    const [savedId, savedMessages] = deps.memoryManager.saveImportedSession.mock.calls[0];
    expect(savedId).toBe(result.sessionId);
    expect(savedMessages).toHaveLength(3);
    // Re-derived objects carry ONLY whitelisted keys (defense in depth).
    expect(savedMessages[1]).toEqual({ role: "assistant", content: "hi back", thought: "reasoning" });
    expect(savedMessages[2]).toEqual({ role: "tool_result", toolUseId: "tu-1", content: "result", toolName: "Read", isError: false });
  });

  it("accepts array (multi-part) user content", async () => {
    const deps = await setup();
    setFile({
      ...validExport,
      messages: [{ role: "user", content: [{ type: "text", text: "part" }] }],
    });

    const result = await invoke();
    expect(result.ok).toBe(true);
    expect(deps.memoryManager.saveImportedSession).toHaveBeenCalledTimes(1);
  });
});

describe("lvis:chat:import — rejection branches (fail-closed)", () => {
  it("returns canceled when the user dismisses the file dialog", async () => {
    const deps = await setup();
    dialogState.canceled = true;

    const result = await invoke();
    expect(result).toEqual({ ok: false, canceled: true });
    expect(deps.memoryManager.saveImportedSession).not.toHaveBeenCalled();
  });

  it("rejects a file larger than MAX_SESSION_FILE_BYTES before reading it", async () => {
    const deps = await setup();
    setFile(validExport);
    fsState.size = MAX_SESSION_FILE_BYTES + 1;

    const result = await invoke();
    expect(result).toEqual({ ok: false, error: "file-too-large" });
    expect(deps.memoryManager.saveImportedSession).not.toHaveBeenCalled();
  });

  it("rejects non-JSON file content", async () => {
    await setup();
    fsState.text = "this is not json {";
    fsState.size = Buffer.byteLength(fsState.text);

    const result = await invoke();
    expect(result).toEqual({ ok: false, error: "invalid-json" });
  });

  it("rejects a file missing the top-level export shape", async () => {
    await setup();
    setFile({ messages: [{ role: "user", content: "x" }] }); // no sessionId/exportedAt

    const result = await invoke();
    expect(result).toEqual({ ok: false, error: "invalid-file-shape" });
  });

  it("rejects an empty messages array", async () => {
    await setup();
    setFile({ ...validExport, messages: [] });

    const result = await invoke();
    expect(result).toEqual({ ok: false, error: "empty-messages" });
  });

  it("rejects a message with an unknown role (whole import fails, no partial)", async () => {
    const deps = await setup();
    setFile({
      ...validExport,
      messages: [{ role: "user", content: "ok" }, { role: "system", content: "nope" }],
    });

    const result = await invoke();
    expect(result).toEqual({ ok: false, error: "invalid-message-shape" });
    expect(deps.memoryManager.saveImportedSession).not.toHaveBeenCalled();
  });

  it("rejects a message carrying an unknown field (arbitrary-field smuggling)", async () => {
    await setup();
    setFile({
      ...validExport,
      messages: [{ role: "user", content: "ok", __proto__: { polluted: true }, extra: 1 }],
    });

    const result = await invoke();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid-message-shape");
  });

  it("rejects a tool_result missing its required toolUseId", async () => {
    await setup();
    setFile({
      ...validExport,
      messages: [{ role: "tool_result", content: "result" }],
    });

    const result = await invoke();
    expect(result).toEqual({ ok: false, error: "invalid-message-shape" });
  });

  it("rejects an assistant toolCalls block with a bad shape", async () => {
    await setup();
    setFile({
      ...validExport,
      messages: [{ role: "assistant", content: "x", toolCalls: [{ name: "t" }] }], // missing id/input
    });

    const result = await invoke();
    expect(result).toEqual({ ok: false, error: "invalid-message-shape" });
  });
});
