import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_TUTORIAL_PREFERENCES,
  applyTutorialAction,
  readTutorialPreferences,
  writeTutorialPreferences,
} from "../tutorial-store.js";

/**
 * Tutorial-D — `~/.lvis/tutorial/` storage tests.
 *
 * Validates the persistence contract from PR-D §3:
 *   - Default returned when no file is present (read-never-throws).
 *   - Round-trip (writeTutorialPreferences → readTutorialPreferences).
 *   - Corrupt JSON returns the default.
 *   - applyTutorialAction merges liked / disliked / undone correctly.
 *   - The namespace directory is created at `~/.lvis/tutorial/`.
 */
describe("tutorial-store", () => {
  let prevLvisHome: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    prevLvisHome = process.env.LVIS_HOME;
    tempDir = mkdtempSync(join(tmpdir(), "lvis-tutorial-"));
    process.env.LVIS_HOME = tempDir;
  });

  afterEach(() => {
    if (prevLvisHome === undefined) {
      delete process.env.LVIS_HOME;
    } else {
      process.env.LVIS_HOME = prevLvisHome;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns the empty default when no file exists", async () => {
    const prefs = await readTutorialPreferences();
    expect(prefs).toEqual(DEFAULT_TUTORIAL_PREFERENCES);
  });

  it("round-trips writeTutorialPreferences → readTutorialPreferences", async () => {
    const value = {
      liked: ["meeting-summary"],
      disliked: ["chat-basics"],
      lastShownAt: "2026-05-19T00:00:00.000Z",
    };
    await writeTutorialPreferences(value);
    const prefs = await readTutorialPreferences();
    expect(prefs).toEqual(value);
  });

  it("falls back to default on corrupt JSON (read-never-throws)", async () => {
    await writeTutorialPreferences({
      liked: ["x"],
      disliked: [],
      lastShownAt: "now",
    });
    const path = join(tempDir, "tutorial", "preferences.json");
    writeFileSync(path, "{ not valid", "utf-8");
    const prefs = await readTutorialPreferences();
    expect(prefs).toEqual(DEFAULT_TUTORIAL_PREFERENCES);
  });

  it("creates the namespace directory under ~/.lvis/tutorial/", async () => {
    await writeTutorialPreferences({
      liked: [],
      disliked: [],
      lastShownAt: "2026-05-19T00:00:00.000Z",
    });
    const dir = join(tempDir, "tutorial");
    const file = join(dir, "preferences.json");
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(file).isFile()).toBe(true);
    const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
    expect(parsed).toMatchObject({ liked: [], disliked: [] });
  });

  it("applyTutorialAction promotes liked + clears from disliked", async () => {
    await writeTutorialPreferences({
      liked: [],
      disliked: ["meeting-summary"],
      lastShownAt: "old",
    });
    const next = await applyTutorialAction("meeting-summary", "liked", () => "ts1");
    expect(next.liked).toEqual(["meeting-summary"]);
    expect(next.disliked).toEqual([]);
    expect(next.lastShownAt).toBe("ts1");
  });

  it("applyTutorialAction promotes disliked + clears from liked", async () => {
    await writeTutorialPreferences({
      liked: ["meeting-summary"],
      disliked: [],
      lastShownAt: "old",
    });
    const next = await applyTutorialAction("meeting-summary", "disliked", () => "ts2");
    expect(next.disliked).toEqual(["meeting-summary"]);
    expect(next.liked).toEqual([]);
  });

  it("applyTutorialAction undone removes from both", async () => {
    await writeTutorialPreferences({
      liked: ["a", "b"],
      disliked: ["c"],
      lastShownAt: "old",
    });
    const after1 = await applyTutorialAction("a", "undone", () => "t");
    expect(after1.liked).toEqual(["b"]);
    expect(after1.disliked).toEqual(["c"]);
    const after2 = await applyTutorialAction("c", "undone", () => "t");
    expect(after2.disliked).toEqual([]);
  });

  it("applyTutorialAction skipped touches lastShownAt only", async () => {
    await writeTutorialPreferences({
      liked: ["a"],
      disliked: ["b"],
      lastShownAt: "old",
    });
    const next = await applyTutorialAction("c", "skipped", () => "new");
    expect(next.liked).toEqual(["a"]);
    expect(next.disliked).toEqual(["b"]);
    expect(next.lastShownAt).toBe("new");
  });

  it("rejects invalid action", async () => {
    await expect(
      applyTutorialAction("a", "bogus" as never),
    ).rejects.toThrow(/invalid-action/);
  });

  it("rejects empty cardId", async () => {
    await expect(
      applyTutorialAction("", "liked"),
    ).rejects.toThrow(/invalid-card-id/);
  });
});
