/**
 * Row identity for a session file written before rows carried ids.
 *
 * `loadSession` is the one door both readers of a session file come through —
 * the sidebar's history read and the conversation loop's resume — and they read
 * it independently, without writing anything back. So the ids it hands out have
 * to be (a) the same on every read, or a row the transcript named resolves to
 * nothing, and (b) distinct, or a lookup by id silently takes the first of two
 * rows answering to the same name.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../memory-manager.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const SESSION = "bbbbbbbb-1111-2222-3333-555555555555";

let dir: string;
let mm: MemoryManager;

function writeRawSession(rows: readonly unknown[]): void {
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(
    join(dir, "sessions", `${SESSION}.jsonl`),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}

function idsOf(messages: unknown[] | null): string[] {
  return (messages ?? []).map((row) => (row as { meta?: { messageId?: string } }).meta?.messageId ?? "");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lvis-legacy-row-ids-"));
  mm = new MemoryManager({ lvisDir: dir });
});

afterEach(async () => {
  await cleanupTmpDir(dir);
});

describe("loadSession — legacy row identity", () => {
  it("gives an id-less row an id, and the same one on a second read", () => {
    writeRawSession([
      { role: "user", content: "no id here" },
      { role: "assistant", content: "nor here" },
    ]);

    const first = idsOf(mm.loadSession(SESSION));
    expect(first.every((id) => id.startsWith("row-"))).toBe(true);
    expect(new Set(first).size).toBe(2);
    // Two independent readers must land on the same names.
    expect(idsOf(mm.loadSession(SESSION))).toEqual(first);
  });

  it("re-mints the second of two rows claiming one id, and leaves the first alone", () => {
    // A hand-merged or tampered file can carry duplicates. Passing them through
    // would make `find by id` answer with whichever row came first.
    writeRawSession([
      { role: "user", content: "original", meta: { messageId: "row-collision" } },
      { role: "assistant", content: "impostor", meta: { messageId: "row-collision" } },
      { role: "user", content: "no id at all" },
    ]);

    const ids = idsOf(mm.loadSession(SESSION));
    expect(ids[0]).toBe("row-collision");
    expect(ids[1]).not.toBe("row-collision");
    expect(ids[1]).toMatch(/^row-[0-9a-f]{32}$/);
    expect(new Set(ids).size).toBe(3);
    // Still deterministic with the collision in play.
    expect(idsOf(mm.loadSession(SESSION))).toEqual(ids);
  });

  it("leaves a session whose rows already have distinct ids untouched", () => {
    writeRawSession([
      { role: "user", content: "a", meta: { messageId: "row-aaa" } },
      { role: "assistant", content: "b", meta: { messageId: "row-bbb" } },
    ]);

    expect(idsOf(mm.loadSession(SESSION))).toEqual(["row-aaa", "row-bbb"]);
  });
});
