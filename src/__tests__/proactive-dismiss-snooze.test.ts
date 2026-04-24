/**
 * Sprint 3-A — IPC dismiss debounce + snooze shift tests.
 *
 * We exercise the handler closures directly (same logic as ipc-bridge.ts)
 * without spinning up Electron. The real registerIpcHandlers uses identical
 * closures — keeping this test focused on the behaviour contract.
 */
import { describe, it, expect } from "vitest";

type RoutineState = { enableDailyBriefing: boolean; lastDismissedAt?: string; lastBriefingAt?: string };

function makeStore(initial: RoutineState = { enableDailyBriefing: true }) {
  let cur: RoutineState = { ...initial };
  return {
    get: () => ({ ...cur }),
    patch: (p: { routine: RoutineState }) => {
      cur = { ...cur, ...p.routine };
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
      routine: { ...cur, lastDismissedAt: new Date(nowMs).toISOString() },
    });
    return { ok: true };
  };
}

function makeSnoozeHandler(store: ReturnType<typeof makeStore>) {
  // Mirror ipc-bridge.ts: 1s debounce + 7d clamp (PR#44 HIGH).
  let lastSnoozeAcceptedAt = 0;
  const DEBOUNCE_MS = 1000;
  const MAX_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;
  return (nowMs: number) => {
    if (nowMs - lastSnoozeAcceptedAt < DEBOUNCE_MS) {
      return { ok: false, debounced: true } as const;
    }
    const cur = store.get();
    const baseMs = cur.lastDismissedAt ? new Date(cur.lastDismissedAt).getTime() : nowMs;
    const effective = Number.isFinite(baseMs) ? baseMs : nowMs;
    const shiftedMs = effective + 60 * 60 * 1000;
    if (shiftedMs > nowMs + MAX_AHEAD_MS) {
      return { ok: false, error: "snooze horizon exceeded (7d)" } as const;
    }
    lastSnoozeAcceptedAt = nowMs;
    const shifted = new Date(shiftedMs).toISOString();
    store.patch({ routine: { ...cur, lastDismissedAt: shifted } });
    return { ok: true, lastDismissedAt: shifted } as const;
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

  // PR#44 HIGH: debounce rate-limits snooze the same way dismiss is limited.
  it("rejects a second snooze within 1s (debounce)", () => {
    const store = makeStore();
    const snooze = makeSnoozeHandler(store);
    const t0 = Date.parse("2026-04-18T10:00:00.000Z");
    const r1 = snooze(t0);
    const r2 = snooze(t0 + 500);
    expect(r1.ok).toBe(true);
    expect(r2).toEqual({ ok: false, debounced: true });
  });

  // PR#44 HIGH: clamp — reject snoozes that would shift beyond now + 7d.
  it("rejects snoozes that would push lastDismissedAt beyond now + 7 days", () => {
    const t0 = Date.parse("2026-04-18T10:00:00.000Z");
    // Seed a lastDismissedAt already ~7d out.
    const farFuture = new Date(t0 + 7 * 24 * 60 * 60 * 1000).toISOString();
    const store = makeStore({ enableDailyBriefing: true, lastDismissedAt: farFuture });
    const snooze = makeSnoozeHandler(store);
    const r = snooze(t0);
    expect(r.ok).toBe(false);
    if (!r.ok && "error" in r) {
      expect(r.error).toMatch(/horizon/);
    }
    // Store must be unchanged.
    expect(store.get().lastDismissedAt).toBe(farFuture);
  });
});
