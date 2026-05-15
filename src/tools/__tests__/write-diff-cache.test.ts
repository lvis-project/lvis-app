/**
 * Issue #749 — write-diff-cache unit tests.
 *
 * Covers:
 *   1. writeDiffSidecar: writes sidecar when either side exceeds limit
 *   2. writeDiffSidecar: skips write when both sides are within limit
 *   3. writeDiffSidecar: rejects unsafe ids (path separator characters)
 *   4. readDiffSidecar: returns blob for written sidecar
 *   5. readDiffSidecar: returns null for missing sidecar
 *   6. clearSessionDiffCache: removes session dir
 *   7. purgeStaleSessionDiffDirs: removes dirs older than maxAgeMs
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Override LVIS_HOME so sidecar writes go to a temp dir.
let testHome: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "lvis-diff-cache-test-"));
  process.env.LVIS_HOME = testHome;
});

afterEach(() => {
  delete process.env.LVIS_HOME;
  rmSync(testHome, { recursive: true, force: true });
});

// Dynamic import AFTER env override so lvisHome() picks up LVIS_HOME.
async function loadModule() {
  return import("../write-diff-cache.js");
}

const SESSION_ID = "session-abc123";
const TOOL_USE_ID = "tu-def456";
const SMALL = "x".repeat(10);
const LARGE = "y".repeat(5000); // > 4096

describe("write-diff-cache", () => {
  it("skips write when both sides are within WRITE_DIFF_PREVIEW_LIMIT", async () => {
    const { writeDiffSidecar, WRITE_DIFF_PREVIEW_LIMIT } = await loadModule();
    const warns: string[] = [];
    const result = await writeDiffSidecar(
      SESSION_ID,
      TOOL_USE_ID,
      SMALL,
      SMALL,
      (m) => warns.push(m),
    );
    expect(result).toBe(false);
    expect(warns).toHaveLength(0);
    // No file should be created
    const path = join(testHome, "diff-cache", SESSION_ID, `${TOOL_USE_ID}.json`);
    expect(existsSync(path)).toBe(false);
    // Confirm WRITE_DIFF_PREVIEW_LIMIT is 4096
    expect(WRITE_DIFF_PREVIEW_LIMIT).toBe(4096);
  });

  it("writes sidecar when before exceeds WRITE_DIFF_PREVIEW_LIMIT", async () => {
    const { writeDiffSidecar } = await loadModule();
    const warns: string[] = [];
    const result = await writeDiffSidecar(SESSION_ID, TOOL_USE_ID, LARGE, SMALL, (m) => warns.push(m));
    expect(result).toBe(true);
    expect(warns).toHaveLength(0);
    const path = join(testHome, "diff-cache", SESSION_ID, `${TOOL_USE_ID}.json`);
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(path, "utf8")) as { before: string; after: string };
    expect(raw.before).toBe(LARGE);
    expect(raw.after).toBe(SMALL);
  });

  it("writes sidecar when after exceeds WRITE_DIFF_PREVIEW_LIMIT", async () => {
    const { writeDiffSidecar } = await loadModule();
    const warns: string[] = [];
    const result = await writeDiffSidecar(SESSION_ID, TOOL_USE_ID, SMALL, LARGE, (m) => warns.push(m));
    expect(result).toBe(true);
    expect(warns).toHaveLength(0);
  });

  it("rejects unsafe sessionId (path separator)", async () => {
    const { writeDiffSidecar } = await loadModule();
    const warns: string[] = [];
    const result = await writeDiffSidecar(
      "../../evil",
      TOOL_USE_ID,
      LARGE,
      LARGE,
      (m) => warns.push(m),
    );
    expect(result).toBe(false);
    expect(warns.length).toBeGreaterThan(0);
  });

  it("rejects unsafe toolUseId (path separator)", async () => {
    const { writeDiffSidecar } = await loadModule();
    const warns: string[] = [];
    const result = await writeDiffSidecar(
      SESSION_ID,
      "../evil",
      LARGE,
      LARGE,
      (m) => warns.push(m),
    );
    expect(result).toBe(false);
    expect(warns.length).toBeGreaterThan(0);
  });

  it("readDiffSidecar returns blob for written sidecar", async () => {
    const { writeDiffSidecar, readDiffSidecar } = await loadModule();
    await writeDiffSidecar(SESSION_ID, TOOL_USE_ID, LARGE, SMALL, () => {});
    const blob = await readDiffSidecar(SESSION_ID, TOOL_USE_ID);
    expect(blob).not.toBeNull();
    expect(blob!.before).toBe(LARGE);
    expect(blob!.after).toBe(SMALL);
  });

  it("readDiffSidecar returns null for missing sidecar", async () => {
    const { readDiffSidecar } = await loadModule();
    const blob = await readDiffSidecar(SESSION_ID, "nonexistent-tu");
    expect(blob).toBeNull();
  });

  it("readDiffSidecar returns null for unsafe ids", async () => {
    const { readDiffSidecar } = await loadModule();
    const blob = await readDiffSidecar("../../etc", "passwd");
    expect(blob).toBeNull();
  });

  it("clearSessionDiffCache removes the session dir", async () => {
    const { writeDiffSidecar, clearSessionDiffCache } = await loadModule();
    await writeDiffSidecar(SESSION_ID, TOOL_USE_ID, LARGE, LARGE, () => {});
    const dir = join(testHome, "diff-cache", SESSION_ID);
    expect(existsSync(dir)).toBe(true);
    await clearSessionDiffCache(SESSION_ID);
    expect(existsSync(dir)).toBe(false);
  });

  it("clearSessionDiffCache is a no-op when session dir does not exist", async () => {
    const { clearSessionDiffCache } = await loadModule();
    // Should not throw
    await expect(clearSessionDiffCache("no-such-session")).resolves.toBeUndefined();
  });

  it("purgeStaleSessionDiffDirs removes dirs older than maxAgeMs", async () => {
    const { writeDiffSidecar, purgeStaleSessionDiffDirs } = await loadModule();

    // Create two session dirs — one stale, one fresh.
    await writeDiffSidecar("stale-session", TOOL_USE_ID, LARGE, LARGE, () => {});
    await writeDiffSidecar("fresh-session", TOOL_USE_ID, LARGE, LARGE, () => {});

    // Back-date the stale dir to 8 days ago.
    const staleDir = join(testHome, "diff-cache", "stale-session");
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(staleDir, eightDaysAgo, eightDaysAgo);

    const { swept, failed } = await purgeStaleSessionDiffDirs(7 * 24 * 60 * 60 * 1000);
    expect(failed).toHaveLength(0);
    expect(swept.length).toBe(1);
    expect(swept[0]).toContain("stale-session");
    expect(existsSync(staleDir)).toBe(false);
    expect(existsSync(join(testHome, "diff-cache", "fresh-session"))).toBe(true);
  });

  it("purgeStaleSessionDiffDirs is a no-op when root does not exist", async () => {
    const { purgeStaleSessionDiffDirs } = await loadModule();
    // diff-cache root has not been created yet
    const { swept, failed } = await purgeStaleSessionDiffDirs(1000);
    expect(swept).toHaveLength(0);
    expect(failed).toHaveLength(0);
  });
});
