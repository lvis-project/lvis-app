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
import { createHash } from "node:crypto";
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

/**
 * Mirror of `legacyRowId`'s derivation, so a test can name the exact candidate
 * the production code will reach for at a given step and park something on it.
 * Deliberately re-derived here rather than exported: the point is to pin the
 * formula, and importing it would only assert it equals itself.
 */
function derivedRowId(index: number, step: number): string {
  const digest = createHash("sha256")
    .update(`${SESSION}:${index}:${step}`)
    .digest("hex")
    .slice(0, 32);
  return `row-${digest}`;
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

  it("lets a stored id win over a derived one that wants the same name", () => {
    // Derive the name row 0 would be given if it had no id, then plant it on a
    // LATER row that does. Reserving stored ids before deriving any means the
    // row with real evidence of its identity keeps it, and row 0 moves.
    writeRawSession([
      { role: "user", content: "no id" },
      { role: "assistant", content: "b" },
    ]);
    const derivedForRowZero = idsOf(mm.loadSession(SESSION))[0];

    writeRawSession([
      { role: "user", content: "no id" },
      { role: "assistant", content: "owns it", meta: { messageId: derivedForRowZero } },
    ]);
    const ids = idsOf(mm.loadSession(SESSION));

    expect(ids[1]).toBe(derivedForRowZero);
    expect(ids[0]).not.toBe(derivedForRowZero);
    expect(new Set(ids).size).toBe(2);
  });

  it("opens a session even when stored ids squat on a row's whole retry run", () => {
    // Collisions used to spend the DLP retry budget: eight of them exhausted the
    // 8 attempts and threw, so `loadSession` returned nothing and the session
    // could not be opened at all. Plant exactly that — the first eight names
    // row 8 would derive, parked on the rows ahead of it — and it must still
    // come back with an id, from the ninth step.
    const squatters = Array.from({ length: 8 }, (_, step) => derivedRowId(8, step));
    expect(new Set(squatters).size).toBe(8);

    writeRawSession([
      ...squatters.map((messageId, n) => ({ role: "user", content: `squatter ${n}`, meta: { messageId } })),
      { role: "assistant", content: "the row that has to move" },
    ]);

    const ids = idsOf(mm.loadSession(SESSION));
    expect(ids).toHaveLength(9);
    expect(ids.slice(0, 8)).toEqual(squatters);
    expect(ids[8]).toBe(derivedRowId(8, 8));
    expect(new Set(ids).size).toBe(9);
  });

  it("leaves a session whose rows already have distinct ids untouched", () => {
    writeRawSession([
      { role: "user", content: "a", meta: { messageId: "row-aaa" } },
      { role: "assistant", content: "b", meta: { messageId: "row-bbb" } },
    ]);

    expect(idsOf(mm.loadSession(SESSION))).toEqual(["row-aaa", "row-bbb"]);
  });
});
