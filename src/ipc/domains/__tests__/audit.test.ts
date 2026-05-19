/**
 * F6 (Tutorial-Suite verification fix) — `lvis:audit:log-demo-autoplay`
 * rate-limit handler test.
 *
 * The production handler in `src/ipc/domains/audit.ts:79-105` admits at
 * most 30 calls per 1-second sliding window before returning
 * `{ ok: false, error: "rate-limited" }`. This was previously untested.
 *
 * Mirrors the pattern from `tour.test.ts` / `auth-login-mockup.test.ts`:
 * vitest mocks `electron.ipcMain.handle` so each `registerAuditHandlers`
 * call lands in a `Map<channel, handler>`, then the test invokes the
 * handler with a fabricated `IpcMainInvokeEvent` shape.
 *
 * Verified:
 *   1. The first 30 calls in a 1-second window all return `{ ok: true }`.
 *   2. The 31st call returns `{ ok: false, error: "rate-limited" }` and
 *      does NOT call `auditLogger.log`.
 *   3. Advancing fake timers past the 1-second window resets the counter
 *      so subsequent calls succeed again.
 *
 * Activation: the handler is only registered when `LVIS_DEMO_VENDOR` is
 * set at process start. The test sets it in `beforeEach`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return Promise.resolve(
    fn(
      {
        frameId: 0,
        processId: 0,
        senderFrame: { url: "file:///app/index.html" },
      } as never,
      ...args,
    ),
  );
}

interface AuditLoggerSpy {
  log: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  getStats: ReturnType<typeof vi.fn>;
}

function makeDeps(): {
  auditLogger: AuditLoggerSpy;
  conversationLoop: { getSessionId: () => string };
} {
  return {
    auditLogger: {
      log: vi.fn(),
      search: vi.fn(async () => []),
      getStats: vi.fn(async () => ({})),
    },
    conversationLoop: {
      getSessionId: vi.fn(() => "test-session"),
    },
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  handlers.clear();
  vi.resetModules();
  process.env.LVIS_DEMO_VENDOR = "anthropic";
});

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
});

async function loadModule() {
  return import("../audit.js");
}

describe("audit:log-demo-autoplay IPC rate limit (F6)", () => {
  it("admits the first 30 calls in a 1-second window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const deps = makeDeps();
    const { registerAuditHandlers } = await loadModule();
    registerAuditHandlers(deps as never);

    expect(handlers.has("lvis:audit:log-demo-autoplay")).toBe(true);

    for (let i = 0; i < 30; i++) {
      const result = await invoke("lvis:audit:log-demo-autoplay", {
        scriptId: "meeting-summary-demo",
        phase: `step-${i}`,
      });
      expect(result).toEqual({ ok: true });
    }
    expect(deps.auditLogger.log).toHaveBeenCalledTimes(30);
  });

  it("rejects the 31st call with error=rate-limited and skips the audit log", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const deps = makeDeps();
    const { registerAuditHandlers } = await loadModule();
    registerAuditHandlers(deps as never);

    // Burn the entire budget without advancing the clock so the 31st
    // call lands in the same 1-second window.
    for (let i = 0; i < 30; i++) {
      await invoke("lvis:audit:log-demo-autoplay", {
        scriptId: "meeting-summary-demo",
        phase: `step-${i}`,
      });
    }
    expect(deps.auditLogger.log).toHaveBeenCalledTimes(30);

    const denied = await invoke("lvis:audit:log-demo-autoplay", {
      scriptId: "meeting-summary-demo",
      phase: "step-31-overflow",
    });
    expect(denied).toMatchObject({
      ok: false,
      error: "rate-limited",
    });
    // The rejected call must NOT have written to the audit log.
    expect(deps.auditLogger.log).toHaveBeenCalledTimes(30);
  });

  it("resets the counter after the 1-second window elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const deps = makeDeps();
    const { registerAuditHandlers } = await loadModule();
    registerAuditHandlers(deps as never);

    // Burn the budget.
    for (let i = 0; i < 30; i++) {
      await invoke("lvis:audit:log-demo-autoplay", {
        scriptId: "meeting-summary-demo",
        phase: `step-${i}`,
      });
    }
    // 31st call rejected.
    const overflow = await invoke("lvis:audit:log-demo-autoplay", {
      scriptId: "meeting-summary-demo",
      phase: "overflow",
    });
    expect(overflow).toMatchObject({ ok: false, error: "rate-limited" });

    // Advance past the 1-second window — the limiter should reset and
    // admit the next call again.
    vi.advanceTimersByTime(1_001);
    const afterReset = await invoke("lvis:audit:log-demo-autoplay", {
      scriptId: "meeting-summary-demo",
      phase: "after-reset",
    });
    expect(afterReset).toEqual({ ok: true });
    // 30 originals + 1 after reset = 31 audit lines (the rejected call
    // did NOT log).
    expect(deps.auditLogger.log).toHaveBeenCalledTimes(31);
  });

  it("skips handler registration when LVIS_DEMO_VENDOR is unset", async () => {
    delete process.env.LVIS_DEMO_VENDOR;
    const deps = makeDeps();
    const { registerAuditHandlers } = await loadModule();
    registerAuditHandlers(deps as never);
    expect(handlers.has("lvis:audit:log-demo-autoplay")).toBe(false);
  });
});
