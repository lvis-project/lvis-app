/**
 * Work-flow memory contract: seed-once USER.md, header-preserving FIFO cap on
 * MEMORY.md (no summarisation), and the bounded prompt-context render.
 */
import { describe, it, expect } from "vitest";
import {
  readOrSeedUser,
  readMemory,
  appendMemory,
  renderWorkContext,
  USER_FILE,
  MEMORY_FILE,
  USER_MD_SEED,
  MEMORY_LINE_CAP,
  type MemoryStorage,
} from "../work-memory.js";

/** In-memory MemoryStorage backed by a plain map. */
function memStorage(seed?: Record<string, string>): MemoryStorage & { files: Record<string, string> } {
  const files: Record<string, string> = { ...seed };
  return {
    files,
    readText: async (rel) => files[rel] ?? "",
    write: async (rel, data) => {
      files[rel] = data;
    },
    exists: async (rel) => rel in files,
    mkdir: async () => {},
  };
}

describe("work-memory", () => {
  it("seeds USER.md once, then returns user edits unchanged", async () => {
    const s = memStorage();
    expect(await readOrSeedUser(s)).toBe(USER_MD_SEED);
    expect(s.files[USER_FILE]).toBe(USER_MD_SEED);

    s.files[USER_FILE] = "# 사용자 프로필\n- 역할: PM\n";
    // Second read returns the edit — the seed is never re-applied.
    expect(await readOrSeedUser(s)).toBe("# 사용자 프로필\n- 역할: PM\n");
  });

  it("appends body lines under a preserved header", async () => {
    const s = memStorage();
    await appendMemory(s, ["line A", "line B"]);
    const out = await readMemory(s);
    expect(out).toContain("# 업무 흐름 메모리"); // header kept
    expect(out).toContain("line A");
    expect(out).toContain("line B");
    expect(s.files[MEMORY_FILE]).toBeDefined();
  });

  it("ignores blank / whitespace-only appends", async () => {
    const s = memStorage();
    await appendMemory(s, ["   ", "", "\n"]);
    // Nothing persisted — an all-blank append is a no-op.
    expect(s.files[MEMORY_FILE]).toBeUndefined();
  });

  it("enforces a FIFO cap on body lines, never evicting the header", async () => {
    const s = memStorage();
    const many = Array.from({ length: MEMORY_LINE_CAP + 50 }, (_, i) => `entry-${i}`);
    await appendMemory(s, many);

    const out = await readMemory(s);
    const lines = out.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeLessThanOrEqual(MEMORY_LINE_CAP);
    expect(out).toContain("# 업무 흐름 메모리"); // header survives
    // Oldest entries dropped (FIFO); newest retained.
    expect(out).not.toContain("entry-0");
    expect(out).toContain(`entry-${MEMORY_LINE_CAP + 49}`);
  });

  it("renderWorkContext bounds output to maxLines", async () => {
    const s = memStorage();
    await appendMemory(s, Array.from({ length: 100 }, (_, i) => `m-${i}`));
    const ctx = await renderWorkContext(s, 12);
    expect(ctx.split("\n").length).toBeLessThanOrEqual(12);
    expect(ctx).toContain("## 사용자");
  });
});
