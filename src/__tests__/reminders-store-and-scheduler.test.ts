/**
 * Unit tests for RemindersStore + RemindersScheduler.
 * The store persists to a tmp JSON file; the scheduler is exercised via its
 * synchronous `checkAndFire` hook so we don't have to wait 30 seconds.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RemindersStore } from "../main/reminders-store.js";
import { RemindersScheduler } from "../main/reminders-scheduler.js";

describe("RemindersStore", () => {
  it("persists across instances", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-rs-"));
    const path = join(dir, "reminders.json");
    try {
      const a = new RemindersStore(path);
      await a.add({
        at: "2099-01-01T00:00:00.000Z",
        title: "a",
        repeat: "none",
      });
      const b = new RemindersStore(path);
      await b.load();
      const list = b.listActive();
      expect(list).toHaveLength(1);
      expect(list[0].title).toBe("a");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dismiss flips dismissedAt and remove deletes the row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-rs-"));
    const path = join(dir, "reminders.json");
    try {
      const store = new RemindersStore(path);
      const r = await store.add({
        at: "2099-01-01T00:00:00.000Z",
        title: "x",
      });
      const dismissed = await store.dismiss(r.id);
      expect(dismissed).toBe(true);
      const removed = await store.remove(r.id);
      expect(removed).toBe(true);
      expect(store.listActive()).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("markFired advances daily reminder past now", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-rs-"));
    const path = join(dir, "reminders.json");
    try {
      const store = new RemindersStore(path);
      // Past time so markFired must roll forward.
      const past = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
      const r = await store.add({ at: past, title: "rec", repeat: "daily" });
      const updated = await store.markFired(r.id);
      expect(updated).not.toBeNull();
      expect(new Date(updated!.at).getTime()).toBeGreaterThan(Date.now());
      expect(updated!.dismissedAt).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("RemindersScheduler", () => {
  it("fires due reminders and skips future ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-rs-"));
    const path = join(dir, "reminders.json");
    try {
      const store = new RemindersStore(path);
      const past = new Date(Date.now() - 60_000).toISOString();
      const future = new Date(Date.now() + 5 * 60_000).toISOString();
      await store.add({ at: past, title: "due", repeat: "none" });
      await store.add({ at: future, title: "later", repeat: "none" });
      const scheduler = new RemindersScheduler(store);
      const fired: string[] = [];
      scheduler.onFired(({ reminder }) => fired.push(reminder.title));
      await scheduler.checkAndFire();
      expect(fired).toEqual(["due"]);
      expect(store.listActive().map((r) => r.title)).toEqual(["later"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
