/**
 * RoutinesScheduler v2 — unit tests.
 *
 * Tests polling (checkAndFire), dispatch branch (llm-session vs notification-only),
 * cron lastFiredMinuteUTC dedup persistence, and dispatchNow (trigger-now IPC path).
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RoutinesStore } from "../routines-store.js";
import { RoutinesScheduler } from "../routines-scheduler.js";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "lvis-sched-"));
  const store = new RoutinesStore(join(dir, "routines.json"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { store, cleanup };
}

function pastIso(offsetMs = -1000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function futureIso(offsetMs = 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe("RoutinesScheduler — llm-session dispatch", () => {
  it("fires onLlmSession handler when llm-session routine is due", async () => {
    const { store, cleanup } = tempStore();
    try {
      await store.add({
        trigger: "schedule",
        execution: "llm-session",
        schedule: { at: pastIso() },
        prePrompt: "test prompt",
        title: "test",
      });

      const scheduler = new RoutinesScheduler(store);
      const fired: string[] = [];
      scheduler.onLlmSession(({ routine }) => { fired.push(routine.id); });

      await scheduler.checkAndFire();
      expect(fired).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("does not fire onNotification for llm-session routine", async () => {
    const { store, cleanup } = tempStore();
    try {
      await store.add({
        trigger: "schedule",
        execution: "llm-session",
        schedule: { at: pastIso() },
        prePrompt: "test prompt",
      });

      const scheduler = new RoutinesScheduler(store);
      const notifFired: string[] = [];
      scheduler.onNotification(({ routine }) => { notifFired.push(routine.id); });

      await scheduler.checkAndFire();
      expect(notifFired).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe("RoutinesScheduler — notification-only dispatch", () => {
  it("fires onNotification handler for notification-only routine", async () => {
    const { store, cleanup } = tempStore();
    try {
      await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { at: pastIso() },
        notificationTitle: "test notif",
      });

      const scheduler = new RoutinesScheduler(store);
      const fired: string[] = [];
      scheduler.onNotification(({ routine }) => { fired.push(routine.id); });

      await scheduler.checkAndFire();
      expect(fired).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("does not fire onLlmSession for notification-only routine", async () => {
    const { store, cleanup } = tempStore();
    try {
      await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { at: pastIso() },
        notificationTitle: "test notif",
      });

      const scheduler = new RoutinesScheduler(store);
      const llmFired: string[] = [];
      scheduler.onLlmSession(({ routine }) => { llmFired.push(routine.id); });

      await scheduler.checkAndFire();
      expect(llmFired).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe("RoutinesScheduler — future routine not fired", () => {
  it("does not fire routines scheduled in the future", async () => {
    const { store, cleanup } = tempStore();
    try {
      await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { at: futureIso() },
        notificationTitle: "future notif",
      });

      const scheduler = new RoutinesScheduler(store);
      const fired: string[] = [];
      scheduler.onNotification(({ routine }) => { fired.push(routine.id); });

      await scheduler.checkAndFire();
      expect(fired).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe("RoutinesScheduler — markFired persistence", () => {
  it("updates lastFiredAt and dismisses one-shot routine after fire", async () => {
    const { store, cleanup } = tempStore();
    try {
      await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { at: pastIso(), repeat: { kind: "none" } },
        notificationTitle: "one-shot",
      });

      const scheduler = new RoutinesScheduler(store);
      await scheduler.checkAndFire();

      // Routine should now be dismissed (one-shot)
      expect(store.listActive()).toHaveLength(0);
      expect(store.list()[0].lastFiredAt).toBeTruthy();
    } finally {
      cleanup();
    }
  });
});

describe("RoutinesScheduler — dispatchNow (trigger-now IPC)", () => {
  it("dispatches routine immediately via dispatchNow", async () => {
    const { store, cleanup } = tempStore();
    try {
      const r = await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { at: futureIso() }, // future — would not fire via normal tick
        notificationTitle: "manual trigger",
      });

      const scheduler = new RoutinesScheduler(store);
      const fired: string[] = [];
      scheduler.onNotification(({ routine }) => { fired.push(routine.id); });

      const ok = await scheduler.dispatchNow(r.id);
      expect(ok).toBe(true);
      expect(fired).toContain(r.id);
    } finally {
      cleanup();
    }
  });

  it("dispatchNow returns false for unknown id", async () => {
    const { store, cleanup } = tempStore();
    try {
      const scheduler = new RoutinesScheduler(store);
      const ok = await scheduler.dispatchNow("nonexistent-id");
      expect(ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("dispatchNow updates lastFiredAt", async () => {
    const { store, cleanup } = tempStore();
    try {
      const r = await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { at: futureIso(), repeat: { kind: "daily" } },
        notificationTitle: "daily triggered manually",
      });

      const scheduler = new RoutinesScheduler(store);
      scheduler.onNotification(() => {});
      await scheduler.dispatchNow(r.id);

      const updated = store.list().find((x) => x.id === r.id);
      expect(updated?.lastFiredAt).toBeTruthy();
    } finally {
      cleanup();
    }
  });
});

describe("RoutinesScheduler — per-tick error isolation", () => {
  it("checkAndFire resolves even when a handler throws", async () => {
    const { store, cleanup } = tempStore();
    try {
      await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { at: pastIso() },
        notificationTitle: "routine 1",
      });

      const scheduler = new RoutinesScheduler(store);

      // Handler always throws — checkAndFire should still resolve (not reject).
      scheduler.onNotification(() => {
        throw new Error("simulated handler error");
      });

      // Promise must resolve (not reject) — per-handler errors are swallowed.
      await expect(scheduler.checkAndFire()).resolves.toBeUndefined();
    } finally {
      cleanup();
    }
  });
});
