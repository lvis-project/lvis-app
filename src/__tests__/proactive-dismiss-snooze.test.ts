/**
 * Sprint 3-A — IPC dismiss debounce + snooze shift tests.
 *
 * We exercise the handler closures directly (same logic as ipc-bridge.ts)
 * without spinning up Electron. The real registerIpcHandlers uses identical
 * closures — keeping this test focused on the behaviour contract.
 */
import { describe, it, expect } from "vitest";

type Proactive = { enableDailyBriefing: boolean; lastDismissedAt?: string; lastBriefingAt?: string };

function makeStore(initial: Proactive = { enableDailyBriefing: true }) {
  let cur: Proactive = { ...initial };
  return {
    get: () => ({ ...cur }),
    patch: (p: { proactive: Proactive }) => {
      cur = { ...cur, ...p.proactive };
    },
  };
}

function makeDismissHandler(store: ReturnType<typeof makeStore>) {
  let lastDismissAcceptedAt = 0;
  const DEBOUNCE_MS = 1000;
  return (nowMs: number) => {
    if (nowMs - lastDismissAcceptedAt < DEBOUNCE_MS) {
      return { ok: false, debounced: true };
    }
    lastDismissAcceptedAt = nowMs;
    const cur = store.get();
    store.patch({
      proactive: { ...cur, lastDismissedAt: new Date(nowMs).toISOString() },
    });
    return { ok: true };
  };
}

function makeSnoozeHandler(store: ReturnType<typeof makeStore>) {
  return (nowMs: number) => {
    const cur = store.get();
    const baseMs = cur.lastDismissedAt ? new Date(cur.lastDismissedAt).getTime() : nowMs;
    const effective = Number.isFinite(baseMs) ? baseMs : nowMs;
    const shifted = new Date(effective + 60 * 60 * 1000).toISOString();
    store.patch({ proactive: { ...cur, lastDismissedAt: shifted } });
    return { ok: true, lastDismissedAt: shifted };
  };
}

describe("dismiss-briefing debounce (min 1s between accepted dismisses)", () => {
  it("rejects a second dismiss within 1s", () => {
    const store = makeStore();
    const dismiss = makeDismissHandler(store);
    const t0 = Date.parse("2026-04-18T10:00:00.000Z");
    const r1 = dismiss(t0);
    const r2 = dismiss(t0 + 500);
    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: false, debounced: true });
    // store should reflect first dismiss only
    expect(store.get().lastDismissedAt).toBe(new Date(t0).toISOString());
  });

  it("accepts a second dismiss after ≥1s", () => {
    const store = makeStore();
    const dismiss = makeDismissHandler(store);
    const t0 = Date.parse("2026-04-18T10:00:00.000Z");
    dismiss(t0);
    const r2 = dismiss(t0 + 1000);
    expect(r2).toEqual({ ok: true });
    expect(store.get().lastDismissedAt).toBe(new Date(t0 + 1000).toISOString());
  });
});

describe("snooze-briefing shifts lastDismissedAt forward by 1h", () => {
  it("from unset, sets lastDismissedAt to now+1h", () => {
    const store = makeStore();
    const snooze = makeSnoozeHandler(store);
    const t0 = Date.parse("2026-04-18T10:00:00.000Z");
    const r = snooze(t0);
    const expected = new Date(t0 + 60 * 60 * 1000).toISOString();
    expect(r).toEqual({ ok: true, lastDismissedAt: expected });
    expect(store.get().lastDismissedAt).toBe(expected);
  });

  it("from existing value, shifts forward by exactly 1h", () => {
    const t0 = Date.parse("2026-04-18T10:00:00.000Z");
    const store = makeStore({ enableDailyBriefing: true, lastDismissedAt: new Date(t0).toISOString() });
    const snooze = makeSnoozeHandler(store);
    snooze(t0 + 500);
    const expected = new Date(t0 + 60 * 60 * 1000).toISOString();
    expect(store.get().lastDismissedAt).toBe(expected);
  });
});
