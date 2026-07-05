/**
 * NotificationService — Issue #260 unit coverage.
 *
 * The service must:
 *   1. Cap body at 80 chars + ellipsis.
 *   2. Pick OS vs in-app gate based on window focused/minimized state.
 *   3. Audit every fire — kind, gate, title (NEVER body — PII).
 *   4. No-op when NODE_ENV === "test" or app not ready (guarded by ctor opts).
 *   5. Click handler dispatches IPC payload with contextRef.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  NotificationService,
  IPC_NOTIFICATION_TOAST,
  IPC_NOTIFICATION_CLICKED,
  __test,
} from "../notification-service.js";
import type { AuditLogger } from "../../audit/audit-logger.js";

interface MockWindow {
  isDestroyed: () => boolean;
  isFocused: () => boolean;
  isMinimized: () => boolean;
  show: () => void;
  focus: () => void;
  restore: () => void;
  webContents: { send: (channel: string, payload: unknown) => void };
}

function makeMockWindow(opts: {
  destroyed?: boolean;
  focused?: boolean;
  minimized?: boolean;
} = {}): MockWindow & {
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  webContents: { send: ReturnType<typeof vi.fn> };
} {
  return {
    isDestroyed: vi.fn(() => opts.destroyed ?? false),
    isFocused: vi.fn(() => opts.focused ?? false),
    isMinimized: vi.fn(() => opts.minimized ?? false),
    show: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
    webContents: { send: vi.fn() },
  };
}

function makeMockAuditLogger(): AuditLogger {
  // Only `log` is used by NotificationService; cast through unknown so we
  // don't have to stub the full AuditLogger surface.
  const logger = { log: vi.fn() };
  return logger as unknown as AuditLogger;
}

interface FactoryCall {
  title: string;
  body: string;
  silent: boolean;
  urgency: "normal" | "critical" | "low";
  show: ReturnType<typeof vi.fn>;
  clickHandler?: () => void;
}

function makeNotificationFactoryStub(): {
  factory: NonNullable<ConstructorParameters<typeof NotificationService>[0]["notificationFactory"]>;
  calls: FactoryCall[];
} {
  const calls: FactoryCall[] = [];
  const factory: NonNullable<ConstructorParameters<typeof NotificationService>[0]["notificationFactory"]> = (opts) => {
    const entry: FactoryCall = {
      ...opts,
      show: vi.fn(),
    };
    calls.push(entry);
    return {
      show: entry.show,
      on: (event, handler) => {
        if (event === "click") entry.clickHandler = handler;
      },
    };
  };
  return { factory, calls };
}

function makeActivationRegistrationStub(): {
  register: NonNullable<ConstructorParameters<typeof NotificationService>[0]["notificationActivationRegistration"]>;
  getHandler: () => ((details: Electron.ActivationArguments) => void) | undefined;
} {
  let handler: ((details: Electron.ActivationArguments) => void) | undefined;
  const register = vi.fn((next: (details: Electron.ActivationArguments) => void) => {
    handler = next;
  });
  return {
    register,
    getHandler: () => handler,
  };
}

describe("NotificationService — body truncation", () => {
  it("caps body at 80 chars and appends ellipsis", () => {
    const long = "x".repeat(120);
    const result = __test.truncateBody(long);
    // Codepoint length: 80 base + 1 ellipsis = 81 codepoints.
    expect([...result].length).toBe(81);
    expect(result.endsWith("…")).toBe(true);
  });

  it("leaves short bodies untouched", () => {
    const short = "짧은 응답";
    expect(__test.truncateBody(short)).toBe(short);
  });

  it("strips C0 control chars and DEL (M1)", () => {
    const dirty = "hello\r\n\x1b[31mworld\x1b[0m\x07\x7fend";
    expect(__test.truncateBody(dirty)).toBe("hello[31mworld[0mend");
  });

  it("L5: strips C1 control chars (0x80–0x9F) — Windows toast XML safety", () => {
    // C1 range (\x80–\x9F) can surprise Windows toast XML just like C0 range.
    const dirty = "start\x80mid\x9fend";
    expect(__test.stripControlChars(dirty)).toBe("startmidend");
  });

  it("collapses ANSI/CR/LF to a clean single-line string (M1)", () => {
    const dirty = "line1\nline2\r\nline3";
    expect(__test.truncateBody(dirty)).toBe("line1line2line3");
  });

  it("UTF-16 surrogate-safe truncation: emoji at boundary stays whole (L1)", () => {
    // 79 chars + 4-byte emoji at codepoint 80. Without surrogate-safe slicing,
    // `string.slice(0, 80)` would split the emoji's surrogate pair.
    const padding = "x".repeat(79);
    const emoji = "\u{1F389}"; // 🎉 — code-point 0x1F389, surrogate pair in UTF-16.
    const input = padding + emoji + "rest";
    const result = __test.truncateBody(input);
    // Should contain the whole emoji (or none of it), never a lone surrogate.
    const codepoints = [...result];
    expect(codepoints.length).toBe(81); // 80 + ellipsis
    // Emoji at position 79 (0-indexed) should be intact.
    expect(codepoints[79]).toBe(emoji);
  });
});

describe("NotificationService — routing decision", () => {
  let auditLogger: AuditLogger;
  let factoryStub: ReturnType<typeof makeNotificationFactoryStub>;

  beforeEach(() => {
    auditLogger = makeMockAuditLogger();
    factoryStub = makeNotificationFactoryStub();
  });

  it("focused, non-minimized system notification → in-app toast IPC", () => {
    const win = makeMockWindow({ focused: true, minimized: false });
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      auditLogger,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => false,
      isAnyWindowFocused: () => true, // multi-window probe: main is focused
    });
    svc.fire({
      kind: "system",
      title: "동기화 완료",
      body: "hello world",
      contextRef: { sessionId: "s-1" },
    });
    expect(win.webContents.send).toHaveBeenCalledWith(
      IPC_NOTIFICATION_TOAST,
      expect.objectContaining({
        kind: "system",
        title: "동기화 완료",
        body: "hello world",
        contextRef: { sessionId: "s-1" },
      }),
    );
    expect(factoryStub.calls.length).toBe(0);
    // Audit: gate=in-app
    const log = (auditLogger.log as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(log.input).toContain('"gate":"in-app"');
    expect(log.input).toContain('"kind":"system"');
    expect(log.input).toContain('"title":"동기화 완료"');
    // Body MUST NOT appear in audit (PII).
    expect(log.input).not.toContain("hello world");
  });

  it("focused turn-end is suppressed without composer toast or cooldown consumption", () => {
    const win = makeMockWindow({ focused: true, minimized: false });
    let anyFocused = true;
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      auditLogger,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => false,
      isAnyWindowFocused: () => anyFocused,
    });
    const perfBase = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => perfBase);

    svc.fire({
      kind: "turn-end",
      title: "응답 완료",
      body: "hello world",
      contextRef: { sessionId: "s-1" },
    });

    expect(win.webContents.send).not.toHaveBeenCalled();
    expect(factoryStub.calls.length).toBe(0);
    const suppressedLog = (auditLogger.log as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const suppressed = JSON.parse(suppressedLog.input);
    expect(suppressed).toMatchObject({
      event: "notification.suppressed",
      kind: "turn-end",
      reason: "foreground",
    });
    expect(suppressedLog.input).not.toContain("hello world");

    anyFocused = false;
    vi.spyOn(performance, "now").mockImplementation(() => perfBase + 1_000);
    svc.fire({
      kind: "turn-end",
      title: "응답 완료",
      body: "hello world",
      contextRef: { sessionId: "s-1" },
    });

    expect(factoryStub.calls.length).toBe(1);
    vi.restoreAllMocks();
  });

  it("system notifications route through the same in-app toast path", () => {
    const win = makeMockWindow({ focused: true, minimized: false });
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      auditLogger,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => false,
      isAnyWindowFocused: () => true,
    });

    svc.fire({
      kind: "system",
      title: "LVIS reference 업데이트 사용 가능",
      body: "~/.lvis/AGENTS.md.new 를 검토해 병합하거나 삭제하세요.",
    });

    expect(win.webContents.send).toHaveBeenCalledWith(
      IPC_NOTIFICATION_TOAST,
      expect.objectContaining({
        kind: "system",
        title: "LVIS reference 업데이트 사용 가능",
      }),
    );
    const log = (auditLogger.log as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.parse(log.input).kind).toBe("system");
  });

  it("minimized window → OS notification path", () => {
    const win = makeMockWindow({ focused: false, minimized: true });
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      auditLogger,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => false,
    });
    svc.fire({
      kind: "approval",
      title: "승인 필요",
      body: "long body".repeat(20),
      contextRef: { approvalId: "a-1" },
      urgent: true,
    });
    expect(win.webContents.send).not.toHaveBeenCalledWith(
      IPC_NOTIFICATION_TOAST,
      expect.anything(),
    );
    expect(factoryStub.calls.length).toBe(1);
    const call = factoryStub.calls[0];
    expect(call.title).toBe("승인 필요");
    expect(call.silent).toBe(false);
    expect(call.urgency).toBe("critical");
    // body capped
    expect(call.body.length).toBe(81);
    // Audit: gate=os (parsed JSON, not substring — see critic iter 1 finding).
    const log = (auditLogger.log as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const parsed = JSON.parse(log.input);
    expect(parsed.gate).toBe("os");
    expect(parsed.kind).toBe("approval");
  });

  it("blurred (non-focused) window → OS path", () => {
    const win = makeMockWindow({ focused: false, minimized: false });
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      auditLogger,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => false,
    });
    svc.fire({
      kind: "ask-user",
      title: "질문 도착",
      body: "어떤 작업을 원하시나요?",
    });
    expect(factoryStub.calls.length).toBe(1);
    expect(factoryStub.calls[0].silent).toBe(true); // not urgent → silent
    expect(factoryStub.calls[0].urgency).toBe("normal");
  });

  it("destroyed window → falls through to OS path (focused returns false)", () => {
    const win = makeMockWindow({ destroyed: true, focused: true });
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      auditLogger,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => false,
    });
    svc.fire({ kind: "routine", title: "wakeup 완료", body: "morning briefing" });
    expect(win.webContents.send).not.toHaveBeenCalled();
    expect(factoryStub.calls.length).toBe(1);
  });

  it("approval kind defaults urgent=true (silent=false, urgency=critical)", () => {
    const win = makeMockWindow({ focused: false });
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      auditLogger,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => false,
    });
    svc.fire({ kind: "approval", title: "승인 필요", body: "do thing?" });
    expect(factoryStub.calls[0].silent).toBe(false);
    expect(factoryStub.calls[0].urgency).toBe("critical");
  });
});

describe("NotificationService — quiet flags", () => {
  it("isTestEnv true → no-op (no audit, no IPC, no factory call)", () => {
    const win = makeMockWindow({ focused: true });
    const auditLogger = makeMockAuditLogger();
    const factoryStub = makeNotificationFactoryStub();
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      auditLogger,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => true,
    });
    svc.fire({ kind: "turn-end", title: "x", body: "y" });
    expect(win.webContents.send).not.toHaveBeenCalled();
    expect(factoryStub.calls.length).toBe(0);
    expect((auditLogger.log as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("isReady false → no-op", () => {
    const win = makeMockWindow({ focused: true });
    const factoryStub = makeNotificationFactoryStub();
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      notificationFactory: factoryStub.factory,
      isReady: () => false,
      isTestEnv: () => false,
    });
    svc.fire({ kind: "turn-end", title: "x", body: "y" });
    expect(win.webContents.send).not.toHaveBeenCalled();
    expect(factoryStub.calls.length).toBe(0);
  });
});

describe("NotificationService — click handler", () => {
  it("OS notification click sends IPC payload + restores/focuses window", () => {
    const win = makeMockWindow({ focused: false, minimized: true });
    const factoryStub = makeNotificationFactoryStub();
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => false,
    });
    svc.fire({
      kind: "ask-user",
      title: "질문",
      body: "anything?",
      contextRef: { questionId: "q-42" },
    });
    expect(factoryStub.calls[0].clickHandler).toBeDefined();
    // Simulate the user clicking the OS toast.
    factoryStub.calls[0].clickHandler!();
    expect(win.restore).toHaveBeenCalled();
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledWith(
      IPC_NOTIFICATION_CLICKED,
      expect.objectContaining({
        kind: "ask-user",
        contextRef: { questionId: "q-42" },
      }),
    );
  });

  it("Windows activation callback restores/focuses the window without a stale renderer payload", () => {
    const win = makeMockWindow({ focused: false, minimized: true });
    const factoryStub = makeNotificationFactoryStub();
    const activationStub = makeActivationRegistrationStub();
    new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      notificationFactory: factoryStub.factory,
      notificationActivationRegistration: activationStub.register,
      isReady: () => true,
      isTestEnv: () => false,
    });

    expect(activationStub.register).toHaveBeenCalledTimes(1);
    activationStub.getHandler()?.({ arguments: "", type: "click" });

    expect(win.restore).toHaveBeenCalled();
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});

describe("NotificationService — per-kind rate limit (M4)", () => {
  it("turn-end: 3 rapid fires within cooldown → only 1 fires; suppressions audited", () => {
    const win = makeMockWindow({ focused: false, minimized: false });
    const auditLogger = makeMockAuditLogger();
    const factoryStub = makeNotificationFactoryStub();
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      auditLogger,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => false,
    });
    // Fire 3 within 1s — cooldown is 30s for turn-end, so only the first fires.
    // Cooldown now uses performance.now() (monotonic) — stub it to control timing.
    const perfBase = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => perfBase);
    svc.fire({ kind: "turn-end", title: "응답", body: "a" });
    vi.spyOn(performance, "now").mockImplementation(() => perfBase + 200);
    svc.fire({ kind: "turn-end", title: "응답", body: "b" });
    vi.spyOn(performance, "now").mockImplementation(() => perfBase + 800);
    svc.fire({ kind: "turn-end", title: "응답", body: "c" });
    expect(factoryStub.calls.length).toBe(1);
    // Audit: 1 fired + 2 suppressed.
    const logs = (auditLogger.log as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0].input as string,
    );
    expect(logs.filter((l) => l.includes('"event":"notification.fired"')).length).toBe(1);
    expect(logs.filter((l) => l.includes('"event":"notification.suppressed"')).length).toBe(2);
    expect(logs.filter((l) => l.includes('"reason":"cooldown"')).length).toBe(2);
    vi.restoreAllMocks();
  });

  it("turn-end: 4th fire after cooldown elapses succeeds", () => {
    const win = makeMockWindow({ focused: false, minimized: false });
    const auditLogger = makeMockAuditLogger();
    const factoryStub = makeNotificationFactoryStub();
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      auditLogger,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => false,
    });
    const perfBase = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => perfBase);
    svc.fire({ kind: "turn-end", title: "응답", body: "a" });
    vi.spyOn(performance, "now").mockImplementation(() => perfBase + 1_000);
    svc.fire({ kind: "turn-end", title: "응답", body: "b" }); // suppressed
    vi.spyOn(performance, "now").mockImplementation(() => perfBase + 31_000);
    svc.fire({ kind: "turn-end", title: "응답", body: "c" }); // succeeds
    expect(factoryStub.calls.length).toBe(2);
    vi.restoreAllMocks();
  });

  it("routine cooldown is 0 — back-to-back fires both succeed", () => {
    const win = makeMockWindow({ focused: false, minimized: false });
    const factoryStub = makeNotificationFactoryStub();
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => false,
    });
    svc.fire({ kind: "routine", title: "wakeup", body: "a" });
    svc.fire({ kind: "routine", title: "wakeup", body: "b" });
    expect(factoryStub.calls.length).toBe(2);
  });

  it("approval: 2s cooldown coalesces micro-bursts", () => {
    const win = makeMockWindow({ focused: false, minimized: false });
    const factoryStub = makeNotificationFactoryStub();
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => false,
    });
    const perfBase = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => perfBase);
    svc.fire({ kind: "approval", title: "승인", body: "a" });
    vi.spyOn(performance, "now").mockImplementation(() => perfBase + 500);
    svc.fire({ kind: "approval", title: "승인", body: "b" }); // suppressed
    vi.spyOn(performance, "now").mockImplementation(() => perfBase + 2_500);
    svc.fire({ kind: "approval", title: "승인", body: "c" }); // succeeds
    expect(factoryStub.calls.length).toBe(2);
    vi.restoreAllMocks();
  });

  it("L2: exactly cooldownMs elapsed allows fire (< not <=)", () => {
    // Boundary semantics: elapsedMs === cooldownMs must be allowed through.
    // This test locks the `<` comparison so it can't accidentally become `<=`.
    const win = makeMockWindow({ focused: false, minimized: false });
    const factoryStub = makeNotificationFactoryStub();
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => false,
      isAnyWindowFocused: () => false,
    });
    const cooldownMs = __test.COOLDOWN_MS_BY_KIND["turn-end"]; // 30_000
    const perfBase = 1_000_000;
    vi.spyOn(performance, "now").mockImplementation(() => perfBase);
    svc.fire({ kind: "turn-end", title: "a", body: "a" }); // fires
    vi.spyOn(performance, "now").mockImplementation(() => perfBase + cooldownMs); // exactly at boundary
    svc.fire({ kind: "turn-end", title: "b", body: "b" }); // must fire (elapsedMs === cooldownMs is not suppressed)
    expect(factoryStub.calls.length).toBe(2);
    vi.restoreAllMocks();
  });

  it("M1: wall-clock backward jump (clock skew) does not suppress subsequent fires", () => {
    // Simulate an NTP step where Date.now() jumps backwards. Since cooldown
    // now uses performance.now() (monotonic), the backward wall-clock jump
    // has no effect on the gate — fires proceed normally.
    const win = makeMockWindow({ focused: false, minimized: false });
    const factoryStub = makeNotificationFactoryStub();
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => false,
    });
    const perfBase = performance.now();
    // First fire at perfBase, then advance monotonic clock past cooldown.
    vi.spyOn(performance, "now").mockImplementation(() => perfBase);
    svc.fire({ kind: "turn-end", title: "a", body: "a" }); // fires
    // Simulate wall clock going backward (Date.now() drops by 1 hour).
    // Monotonic clock still advances past cooldown.
    vi.spyOn(performance, "now").mockImplementation(() => perfBase + 31_000);
    const wallNow = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => wallNow - 3_600_000); // 1h backward
    svc.fire({ kind: "turn-end", title: "b", body: "b" }); // must fire despite wall clock going backward
    expect(factoryStub.calls.length).toBe(2);
    vi.restoreAllMocks();
  });
});

describe("NotificationService — title sanitization (M1)", () => {
  it("strips control chars from title before send", () => {
    const win = makeMockWindow({ focused: true });
    const auditLogger = makeMockAuditLogger();
    const factoryStub = makeNotificationFactoryStub();
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      auditLogger,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => false,
      isAnyWindowFocused: () => true,
    });
    svc.fire({
      kind: "routine",
      title: "wake\nup\r\x1b[1m완료",
      body: "ok",
    });
    // Toast IPC payload — title is sanitized.
    expect(win.webContents.send).toHaveBeenCalledWith(
      IPC_NOTIFICATION_TOAST,
      expect.objectContaining({ title: "wakeup[1m완료" }),
    );
  });
});

describe("NotificationService — multi-window focus gate (#842)", () => {
  it("main blurred + aux window focused → focus gate ACTIVE (in-app toast, no OS pop)", () => {
    // The pre-fix gate only consulted `win.isFocused()` on mainWindow. With
    // a detached settings/auth/link window holding focus, the gate now
    // correctly classifies as in-app via the `isAnyWindowFocused` probe.
    const win = makeMockWindow({ focused: false, minimized: false });
    const factoryStub = makeNotificationFactoryStub();
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => false,
      isAnyWindowFocused: () => true, // an aux window holds focus
    });
    svc.fire({ kind: "system", title: "응답", body: "ok" });
    expect(factoryStub.calls.length).toBe(0);
    expect(win.webContents.send).toHaveBeenCalledWith(
      IPC_NOTIFICATION_TOAST,
      expect.objectContaining({ kind: "system" }),
    );
  });

  it("main blurred + no LVIS window focused → focus gate INACTIVE (OS path)", () => {
    const win = makeMockWindow({ focused: false, minimized: false });
    const factoryStub = makeNotificationFactoryStub();
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => false,
      isAnyWindowFocused: () => false,
    });
    svc.fire({ kind: "turn-end", title: "응답", body: "ok" });
    expect(factoryStub.calls.length).toBe(1);
  });

  it("default isAnyWindowFocused returns false when Electron is unavailable (test env)", () => {
    // Without injecting `isAnyWindowFocused`, the default tries to `require("electron")`.
    // In a vitest environment without a real Electron context, the BrowserWindow
    // call would throw — the wrapper returns false so notifications still fire
    // via the OS path (degraded gracefully).
    const win = makeMockWindow({ focused: false });
    const factoryStub = makeNotificationFactoryStub();
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => false,
      // isAnyWindowFocused omitted → default path exercised
    });
    expect(() => svc.fire({ kind: "ask-user", title: "x", body: "y" })).not.toThrow();
  });
});

describe("NotificationService — bypassFocusGate (#843)", () => {
  it("bypassFocusGate=true + focused window → OS path fires (critical notification)", () => {
    const win = makeMockWindow({ focused: true, minimized: false });
    const factoryStub = makeNotificationFactoryStub();
    const auditLogger = makeMockAuditLogger();
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      auditLogger,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => false,
      isAnyWindowFocused: () => true,
    });
    svc.fire({
      kind: "plugin",
      title: "meeting.starting-soon",
      body: "회의가 5분 후 시작됩니다",
      bypassFocusGate: true,
    });
    // OS path used despite focused window
    expect(factoryStub.calls.length).toBe(1);
    expect(win.webContents.send).not.toHaveBeenCalledWith(
      IPC_NOTIFICATION_TOAST,
      expect.anything(),
    );
    // Audit reflects gate=os (parsed JSON property, not substring).
    const log = (auditLogger.log as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const parsed = JSON.parse(log.input);
    expect(parsed.gate).toBe("os");
  });

  it("bypassFocusGate=false (default) + focused window → in-app toast (gate honored)", () => {
    const win = makeMockWindow({ focused: true, minimized: false });
    const factoryStub = makeNotificationFactoryStub();
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => false,
      isAnyWindowFocused: () => true,
    });
    svc.fire({ kind: "plugin", title: "noise", body: "chatter" });
    expect(factoryStub.calls.length).toBe(0);
    expect(win.webContents.send).toHaveBeenCalled();
  });
});

describe("NotificationService — plugin kind cooldown (#841)", () => {
  it("plugin: 5s cooldown coalesces back-to-back fires", () => {
    const win = makeMockWindow({ focused: false, minimized: false });
    const auditLogger = makeMockAuditLogger();
    const factoryStub = makeNotificationFactoryStub();
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      auditLogger,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => false,
      isAnyWindowFocused: () => false,
    });
    const perfBase = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => perfBase);
    svc.fire({ kind: "plugin", title: "a", body: "1" });
    vi.spyOn(performance, "now").mockImplementation(() => perfBase + 1_000);
    svc.fire({ kind: "plugin", title: "b", body: "2" }); // suppressed
    vi.spyOn(performance, "now").mockImplementation(() => perfBase + 5_500);
    svc.fire({ kind: "plugin", title: "c", body: "3" }); // succeeds
    expect(factoryStub.calls.length).toBe(2);
    const logs = (auditLogger.log as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0].input as string,
    );
    expect(logs.filter((l) => l.includes('"event":"notification.suppressed"')).length).toBe(1);
    vi.restoreAllMocks();
  });
});

// CRITICAL regression guard — critic iter 1 finding. The pre-fix `fire()`
// applied the per-kind cooldown branch BEFORE the bypassFocusGate gate, so a
// plugin's routine fire would silently coalesce a subsequent critical alert
// (meeting.starting-soon, incident.page) within the 5s plugin cooldown window.
// `bypassFocusGate=true` must escape BOTH gates.
describe("NotificationService — bypassFocusGate × cooldown intersection (#843 regression)", () => {
  it("bypass=true fires even when a prior plugin emit is within cooldown window", () => {
    const win = makeMockWindow({ focused: false, minimized: false });
    const auditLogger = makeMockAuditLogger();
    const factoryStub = makeNotificationFactoryStub();
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      auditLogger,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => false,
      isAnyWindowFocused: () => false,
    });
    const perfBase = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => perfBase);
    // Routine plugin emit consumes the cooldown slot.
    svc.fire({ kind: "plugin", title: "routine", body: "1" });
    // 2s later — well within the 5s plugin cooldown.
    vi.spyOn(performance, "now").mockImplementation(() => perfBase + 2_000);
    // Critical alert with bypass — pre-fix this would be cooldown-suppressed.
    svc.fire({
      kind: "plugin",
      title: "meeting.starting-soon",
      body: "회의 5분 전",
      bypassFocusGate: true,
    });
    // Both fires reach the OS path.
    expect(factoryStub.calls.length).toBe(2);
    // No suppressed audit entries.
    const logs = (auditLogger.log as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0].input as string,
    );
    expect(
      logs.filter((l) => l.includes('"event":"notification.suppressed"')).length,
    ).toBe(0);
    vi.restoreAllMocks();
  });

  it("non-bypass fire after a bypass fire still respects cooldown (slot consumed)", () => {
    // bypass=true fires CONSUME the cooldown slot — the next non-bypass fire
    // within cooldownMs is suppressed as normal. This guards against the
    // alternate bug: bypass treated as "didn't happen at all", which would
    // let a turn-loop spam non-bypass fires without cooldown.
    const win = makeMockWindow({ focused: false, minimized: false });
    const auditLogger = makeMockAuditLogger();
    const factoryStub = makeNotificationFactoryStub();
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      auditLogger,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => false,
      isAnyWindowFocused: () => false,
    });
    const perfBase = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => perfBase);
    // Bypass fire consumes the slot.
    svc.fire({
      kind: "plugin",
      title: "incident.page",
      body: "critical",
      bypassFocusGate: true,
    });
    // 1s later — still within the 5s plugin cooldown.
    vi.spyOn(performance, "now").mockImplementation(() => perfBase + 1_000);
    // Non-bypass plugin fire — must be suppressed.
    svc.fire({ kind: "plugin", title: "routine", body: "1" });
    expect(factoryStub.calls.length).toBe(1);
    const logs = (auditLogger.log as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0].input as string,
    );
    expect(
      logs.filter((l) => l.includes('"reason":"cooldown"')).length,
    ).toBe(1);
    vi.restoreAllMocks();
  });

  it("bypass=true also sets urgent (silent+bypassed paradox guard)", () => {
    // code-reviewer iter 1 HIGH: bypassFocusGate without urgent produces a
    // silent OS notification for an alert flagged as critical. urgent must
    // auto-promote when bypass is set (unless caller explicitly opts out).
    const win = makeMockWindow({ focused: true, minimized: false });
    const factoryStub = makeNotificationFactoryStub();
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => false,
      isAnyWindowFocused: () => true,
    });
    svc.fire({
      kind: "plugin",
      title: "meeting.starting-soon",
      body: "회의 5분 전",
      bypassFocusGate: true,
    });
    expect(factoryStub.calls.length).toBe(1);
    expect(factoryStub.calls[0].silent).toBe(false);
    expect(factoryStub.calls[0].urgency).toBe("critical");
  });
});
