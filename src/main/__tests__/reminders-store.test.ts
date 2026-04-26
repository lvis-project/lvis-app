/**
 * RemindersStore — H4 hardening coverage.
 *
 *   - Future-cap rejection (>5 years out throws).
 *   - Persisted-count cap (>50 throws).
 *   - Atomic write (writes a tmp + rename, leaving no half-written file).
 *   - File mode (0o600) on POSIX. Skipped on Windows where mode flags are
 *     not enforced the same way.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import { RemindersStore } from "../reminders-store.js";

describe("RemindersStore — H4 hardening", () => {
  it("rejects 'at' more than 5 years in the future", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-rs-h4-"));
    try {
      const store = new RemindersStore(join(dir, "reminders.json"));
      const tooFar = new Date(Date.now() + 6 * 365 * 24 * 60 * 60 * 1000).toISOString();
      await expect(
        store.add({ at: tooFar, title: "way out there" }),
      ).rejects.toThrow(/too far in the future/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects after the 50-record cap is reached", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-rs-h4-"));
    try {
      const store = new RemindersStore(join(dir, "reminders.json"));
      // Fill up to 50 — within cap.
      for (let i = 0; i < 50; i++) {
        await store.add({
          at: new Date(Date.now() + (i + 1) * 60_000).toISOString(),
          title: `r-${i}`,
        });
      }
      // 51st must throw.
      await expect(
        store.add({
          at: new Date(Date.now() + 60 * 60_000).toISOString(),
          title: "overflow",
        }),
      ).rejects.toThrow(/cap reached/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not leave a tmp file behind after a successful add (atomic write)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-rs-h4-"));
    try {
      const path = join(dir, "reminders.json");
      const store = new RemindersStore(path);
      await store.add({
        at: new Date(Date.now() + 60_000).toISOString(),
        title: "ok",
      });
      // The atomic-write helper writes to `<path>.tmp` and renames; after
      // the rename the tmp file should not exist.
      expect(existsSync(`${path}.tmp`)).toBe(false);
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persisted reminders.json is owner-only (POSIX only)", async () => {
    if (platform() === "win32") return; // mode bits are not enforced on Windows
    const dir = mkdtempSync(join(tmpdir(), "lvis-rs-h4-"));
    try {
      const path = join(dir, "reminders.json");
      const store = new RemindersStore(path);
      await store.add({
        at: new Date(Date.now() + 60_000).toISOString(),
        title: "owner-only",
      });
      const st = statSync(path);
      // 0o600 — only owner read/write.
      expect(st.mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
