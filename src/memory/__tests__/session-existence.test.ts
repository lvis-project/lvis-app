/**
 * `hasSessionTranscript` is the cheap existence check callers use instead of
 * scanning and stat-ing every session. Its whole value is that it agrees with
 * `listSessions`, so these tests assert the agreement rather than asserting the
 * two independently — a check that disagreed with the list the user can see
 * would tell a caller a conversation exists that does not, or the reverse.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../memory-manager.js";
import { cleanupTmpDir } from "../../testing/tmp-dir-teardown.js";

const SESSION_A = "aaaaaaaa-1111-2222-3333-444444444444";
const SESSION_B = "bbbbbbbb-1111-2222-3333-444444444444";
const NEVER_WRITTEN = "cccccccc-1111-2222-3333-444444444444";

let dir: string;
let mm: MemoryManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lvis-session-existence-"));
  mm = new MemoryManager({ lvisDir: dir });
});

afterEach(async () => {
  await cleanupTmpDir(dir);
});

/** What `listSessions` reports, which is what the user's conversation list shows. */
function listedIds(): string[] {
  return mm.listSessions().map((entry) => entry.id).sort();
}

describe("hasSessionTranscript", () => {
  it("answers the same question listSessions answers", async () => {
    await mm.saveSession(SESSION_A, [{ role: "user", content: "first conversation" }]);
    await mm.saveSession(SESSION_B, [{ role: "user", content: "second conversation" }]);
    expect(listedIds()).toEqual([SESSION_A, SESSION_B]);

    for (const id of listedIds()) {
      expect(mm.hasSessionTranscript(id)).toBe(true);
    }
    // The negative half: an id the list does not carry must not be claimed.
    expect(mm.hasSessionTranscript(NEVER_WRITTEN)).toBe(false);
  });

  it("stops claiming a conversation the moment its transcript is deleted", async () => {
    await mm.saveSession(SESSION_A, [{ role: "user", content: "about to be deleted" }]);
    await mm.saveSession(SESSION_B, [{ role: "user", content: "survives" }]);
    expect(mm.hasSessionTranscript(SESSION_A)).toBe(true);

    unlinkSync(join(dir, "sessions", `${SESSION_A}.jsonl`));

    expect(mm.hasSessionTranscript(SESSION_A)).toBe(false);
    // Still in step with the list, and the deletion did not take the other one
    // with it — an over-broad answer would pass the first assertion alone.
    expect(listedIds()).toEqual([SESSION_B]);
    expect(mm.hasSessionTranscript(SESSION_B)).toBe(true);
  });

  it("answers false for a malformed id instead of throwing at its caller", () => {
    // The callers are snapshot projections that must not throw, and an id that
    // is not well-formed names no conversation, so false is the whole answer.
    for (const malformed of ["", "not-a-uuid", "../escape", 42, null, undefined]) {
      expect(mm.hasSessionTranscript(malformed)).toBe(false);
    }
  });
});
