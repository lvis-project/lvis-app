/**
 * Sprint E §2 — briefing feedback persistence.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../memory-manager.js";

let dir: string;
let mm: MemoryManager;

beforeEach(() => {
  dir = mkdtempSync(join(homedir(), ".lvis", "test-tmp", "lvis-mm-"));
  mm = new MemoryManager({ lvisDir: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("MemoryManager briefing feedback", () => {
  it("appends entries as markdown blocks and reads back in order", async () => {
    await mm.appendBriefingFeedback({ reason: "inaccurate", details: "기한이 틀림", date: "2026-04-18" });
    await mm.appendBriefingFeedback({ reason: "busy", date: "2026-04-19" });

    const path = join(dir, "notes", "briefing-feedback.md");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("reason: inaccurate");
    expect(content).toContain("reason: busy");

    const recent = mm.readRecentBriefingFeedback(5);
    expect(recent.length).toBe(2);
    expect(recent[0].reason).toBe("inaccurate");
    expect(recent[1].reason).toBe("busy");
    expect(recent[0].details).toBe("기한이 틀림");
  });

  it("returns empty array when no feedback exists", () => {
    expect(mm.readRecentBriefingFeedback()).toEqual([]);
  });

  it("respects limit on recent entries", async () => {
    for (let i = 0; i < 10; i++) {
      await mm.appendBriefingFeedback({ reason: "other", details: `entry-${i}`, date: `2026-04-${10 + i}` });
    }
    const recent = mm.readRecentBriefingFeedback(3);
    expect(recent.length).toBe(3);
    expect(recent[2].details).toBe("entry-9");
  });
});
