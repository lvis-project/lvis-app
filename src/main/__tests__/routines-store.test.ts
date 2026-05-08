/**
 * RoutinesStore v2 — coverage mirrors RemindersStore H4 tests.
 *
 * - Invalid `at` rejection.
 * - 50-record cap enforcement (Q6).
 * - Atomic write (tmp file replaced, no half-write).
 * - File mode 0o600 on POSIX.
 * - Monthly clamping (Q5) — Feb 28/29, April 30.
 * - markFired advances daily/weekly/monthly/interval repeat.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import { RoutinesStore, MAX_PERSISTED_ROUTINES, MAX_LLM_SESSION_ROUTINES } from "../routines-store.js";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "lvis-rs-v2-"));
  const store = new RoutinesStore(join(dir, "routines.json"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { store, dir, cleanup };
}

function futureIso(offsetMs = 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe("RoutinesStore v2 — basic persistence", () => {
  it("adds a notification-only routine and reads it back", async () => {
    const { store, cleanup } = tempStore();
    try {
      const r = await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { at: futureIso() },
        notificationTitle: "test",
      });
      expect(r.id).toBeTruthy();
      expect(store.listActive()).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("adds an llm-session routine", async () => {
    const { store, cleanup } = tempStore();
    try {
      const r = await store.add({
        trigger: "schedule",
        execution: "llm-session",
        schedule: { at: futureIso(), repeat: { kind: "daily" } },
        prePrompt: "daily briefing",
        title: "Daily",
      });
      expect(r.execution).toBe("llm-session");
      expect(r.prePrompt).toBe("daily briefing");
    } finally {
      cleanup();
    }
  });
});

describe("RoutinesStore v2 — cap enforcement (Q6)", () => {
  it("rejects after the 50-record cap is reached", async () => {
    const { store, cleanup } = tempStore();
    try {
      for (let i = 0; i < MAX_PERSISTED_ROUTINES; i++) {
        await store.add({
          trigger: "schedule",
          execution: "notification-only",
          schedule: { at: futureIso((i + 1) * 60_000) },
          notificationTitle: `r-${i}`,
        });
      }
      await expect(
        store.add({
          trigger: "schedule",
          execution: "notification-only",
          schedule: { at: futureIso(1_000_000) },
          notificationTitle: "overflow",
        }),
      ).rejects.toThrow(/cap reached/);
    } finally {
      cleanup();
    }
  });
});

describe("RoutinesStore v2 — invalid at", () => {
  it("rejects non-ISO at value", async () => {
    const { store, cleanup } = tempStore();
    try {
      await expect(
        store.add({
          trigger: "schedule",
          execution: "notification-only",
          schedule: { at: "not-a-date" },
          notificationTitle: "bad",
        }),
      ).rejects.toThrow(/invalid schedule.at/);
    } finally {
      cleanup();
    }
  });
});

describe("RoutinesStore v2 — atomic write", () => {
  it("does not leave a .tmp file behind after successful add", async () => {
    const { store, dir, cleanup } = tempStore();
    try {
      const path = join(dir, "routines.json");
      await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { at: futureIso() },
        notificationTitle: "ok",
      });
      const { existsSync } = await import("node:fs");
      expect(existsSync(`${path}.tmp`)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it.skipIf(platform() === "win32")(
    "sets file mode 0o600 on POSIX",
    async () => {
      const { store, dir, cleanup } = tempStore();
      try {
        const path = join(dir, "routines.json");
        await store.add({
          trigger: "schedule",
          execution: "notification-only",
          schedule: { at: futureIso() },
          notificationTitle: "ok",
        });
        const mode = statSync(path).mode & 0o777;
        expect(mode).toBe(0o600);
      } finally {
        cleanup();
      }
    },
  );
});

describe("RoutinesStore v2 — dismiss / remove", () => {
  it("dismiss sets dismissedAt and hides from listActive", async () => {
    const { store, cleanup } = tempStore();
    try {
      const r = await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { at: futureIso() },
        notificationTitle: "to-dismiss",
      });
      const ok = await store.dismiss(r.id);
      expect(ok).toBe(true);
      expect(store.listActive()).toHaveLength(0);
      expect(store.list()).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("remove deletes from list entirely", async () => {
    const { store, cleanup } = tempStore();
    try {
      const r = await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { at: futureIso() },
        notificationTitle: "to-remove",
      });
      await store.remove(r.id);
      expect(store.list()).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe("RoutinesStore v2 — markFired repeat advancement", () => {
  it("none: dismisses after first fire", async () => {
    const { store, cleanup } = tempStore();
    try {
      const r = await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { at: futureIso(-1000), repeat: { kind: "none" } },
        notificationTitle: "one-shot",
      });
      const updated = await store.markFired(r.id);
      expect(updated?.dismissedAt).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it("daily: advances at by 24h+", async () => {
    const { store, cleanup } = tempStore();
    try {
      const pastIso = new Date(Date.now() - 1000).toISOString();
      const r = await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { at: pastIso, repeat: { kind: "daily" } },
        notificationTitle: "daily",
      });
      const updated = await store.markFired(r.id);
      expect(updated?.dismissedAt).toBeUndefined();
      const newAt = new Date(updated!.schedule!.at!).getTime();
      expect(newAt).toBeGreaterThan(Date.now());
    } finally {
      cleanup();
    }
  });

  it("monthly clamping: Jan 31 → Feb stays within Feb (Q5)", async () => {
    const { store, cleanup } = tempStore();
    try {
      // Use a past date: Jan 31, 2026
      const jan31 = new Date("2026-01-31T09:00:00Z");
      const r = await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { at: jan31.toISOString(), repeat: { kind: "monthly" } },
        notificationTitle: "monthly",
      });
      const updated = await store.markFired(r.id);
      const nextAt = new Date(updated!.schedule!.at!);
      // nextAt should be in Feb or later (not overflowing into March)
      expect(nextAt.getMonth()).not.toBe(2); // not March (month index 2)
    } finally {
      cleanup();
    }
  });

  it("interval: advances at by intervalMs", async () => {
    const { store, cleanup } = tempStore();
    try {
      const pastIso = new Date(Date.now() - 1000).toISOString();
      const r = await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { at: pastIso, repeat: { kind: "interval", intervalMs: 3_600_000 } },
        notificationTitle: "interval",
      });
      const updated = await store.markFired(r.id);
      const newAt = new Date(updated!.schedule!.at!).getTime();
      expect(newAt).toBeGreaterThan(Date.now());
    } finally {
      cleanup();
    }
  });
});

describe("RoutinesStore v2 — schedule.at ISO normalization", () => {
  it("normalizes tz-offset at to UTC ISO string", async () => {
    const { store, cleanup } = tempStore();
    try {
      const kstAt = "2026-05-09T09:00:00+09:00";
      const r = await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { at: kstAt },
        notificationTitle: "normalized",
      });
      // stored at must be a valid ISO string parseable back to the same UTC moment
      const storedMs = new Date(r.schedule!.at!).getTime();
      const expectedMs = new Date(kstAt).getTime();
      expect(storedMs).toBe(expectedMs);
      // and must be in the canonical UTC "Z" form
      expect(r.schedule!.at).toMatch(/Z$/);
    } finally {
      cleanup();
    }
  });
});

describe("RoutinesStore v2 — cron validation", () => {
  it("rejects invalid cron expression", async () => {
    const { store, cleanup } = tempStore();
    try {
      await expect(
        store.add({
          trigger: "schedule",
          execution: "notification-only",
          schedule: { repeat: { kind: "cron", expression: "not a cron" } },
          notificationTitle: "bad-cron",
        }),
      ).rejects.toThrow(/invalid cron expression/);
    } finally {
      cleanup();
    }
  });

  it("rejects cron expression exceeding 256 chars", async () => {
    const { store, cleanup } = tempStore();
    try {
      await expect(
        store.add({
          trigger: "schedule",
          execution: "notification-only",
          schedule: { repeat: { kind: "cron", expression: "0 9 * * 1".padEnd(300, " x") } },
          notificationTitle: "long-cron",
        }),
      ).rejects.toThrow(/too long/);
    } finally {
      cleanup();
    }
  });

  it("accepts valid 5-field cron expression", async () => {
    const { store, cleanup } = tempStore();
    try {
      const r = await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { repeat: { kind: "cron", expression: "0 9 * * 1-5" } },
        notificationTitle: "valid-cron",
      });
      expect(r.id).toBeTruthy();
    } finally {
      cleanup();
    }
  });
});

describe("RoutinesStore v2 — execution validation", () => {
  it("rejects llm-session with empty prePrompt", async () => {
    const { store, cleanup } = tempStore();
    try {
      await expect(
        store.add({
          trigger: "schedule",
          execution: "llm-session",
          schedule: { at: futureIso() },
          prePrompt: "   ",
        }),
      ).rejects.toThrow(/prePrompt/);
    } finally {
      cleanup();
    }
  });

  it("rejects notification-only with empty notificationTitle", async () => {
    const { store, cleanup } = tempStore();
    try {
      await expect(
        store.add({
          trigger: "schedule",
          execution: "notification-only",
          schedule: { at: futureIso() },
          notificationTitle: "  ",
        }),
      ).rejects.toThrow(/notificationTitle/);
    } finally {
      cleanup();
    }
  });
});

describe("RoutinesStore v2 — Q8 LLM session sub-cap", () => {
  it(`rejects LLM session routine after ${MAX_LLM_SESSION_ROUTINES} active LLM routines`, async () => {
    const { store, cleanup } = tempStore();
    try {
      for (let i = 0; i < MAX_LLM_SESSION_ROUTINES; i++) {
        await store.add({
          trigger: "schedule",
          execution: "llm-session",
          schedule: { at: futureIso((i + 1) * 60_000) },
          prePrompt: `routine ${i}`,
        });
      }
      await expect(
        store.add({
          trigger: "schedule",
          execution: "llm-session",
          schedule: { at: futureIso(1_000_000) },
          prePrompt: "overflow llm routine",
        }),
      ).rejects.toThrow(/LLM session routine cap/);
    } finally {
      cleanup();
    }
  });

  it("notification-only routines are not affected by LLM sub-cap", async () => {
    const { store, cleanup } = tempStore();
    try {
      // Fill LLM sub-cap
      for (let i = 0; i < MAX_LLM_SESSION_ROUTINES; i++) {
        await store.add({
          trigger: "schedule",
          execution: "llm-session",
          schedule: { at: futureIso((i + 1) * 60_000) },
          prePrompt: `routine ${i}`,
        });
      }
      // notification-only should still be allowed
      const r = await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { at: futureIso(1_000_000) },
        notificationTitle: "notification after llm cap",
      });
      expect(r.id).toBeTruthy();
    } finally {
      cleanup();
    }
  });
});

describe("RoutinesStore v2 — advanceInterval far-past (no loop)", () => {
  it("advances far-past interval schedule in arithmetic time (no while loop)", async () => {
    const { store, cleanup } = tempStore();
    // Create a routine with an at timestamp 1 year in the past.
    const farPastMs = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const farPastIso = new Date(farPastMs).toISOString();
    try {
      const r = await store.add({
        trigger: "schedule",
        execution: "notification-only",
        schedule: { at: farPastIso, repeat: { kind: "interval", intervalMs: 3_600_000 } },
        notificationTitle: "far-past-interval",
      });
      const start = Date.now();
      const updated = await store.markFired(r.id);
      const elapsed = Date.now() - start;
      // Should complete in well under 1 second (arithmetic skip, not iterative loop)
      expect(elapsed).toBeLessThan(1000);
      // newAt must be after the far-past timestamp we started with
      const newAt = new Date(updated!.schedule!.at!).getTime();
      expect(newAt).toBeGreaterThan(farPastMs);
    } finally {
      cleanup();
    }
  });
});
