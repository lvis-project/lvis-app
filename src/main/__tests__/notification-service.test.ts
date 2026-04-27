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

  it("focused, non-minimized window → in-app toast IPC", () => {
    const win = makeMockWindow({ focused: true, minimized: false });
    const svc = new NotificationService({
      getMainWindow: () => win as unknown as Electron.BrowserWindow,
      auditLogger,
      notificationFactory: factoryStub.factory,
      isReady: () => true,
      isTestEnv: () => false,
    });
    svc.fire({
      kind: "turn-end",
      title: "응답 완료",
      body: "hello world",
      contextRef: { sessionId: "s-1" },
    });
    expect(win.webContents.send).toHaveBeenCalledWith(
      IPC_NOTIFICATION_TOAST,
      expect.objectContaining({
        kind: "turn-end",
        title: "응답 완료",
        body: "hello world",
        contextRef: { sessionId: "s-1" },
      }),
    );
    expect(factoryStub.calls.length).toBe(0);
    // Audit: gate=in-app
    const log = (auditLogger.log as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(log.input).toContain('"gate":"in-app"');
    expect(log.input).toContain('"kind":"turn-end"');
    expect(log.input).toContain('"title":"응답 완료"');
    // Body MUST NOT appear in audit (PII).
    expect(log.input).not.toContain("hello world");
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
    // Audit: gate=os
    const log = (auditLogger.log as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(log.input).toContain('"gate":"os"');
    expect(log.input).toContain('"kind":"approval"');
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
    });
    const cooldownMs = __test.COOLDOWN_MS_BY_KIND["turn-end"]; // 30_000
    const perfBase = performance.now();
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
