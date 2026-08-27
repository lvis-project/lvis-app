/**
 * The three fields a conversation ROW can change: its name, whether it is
 * archived, and whether it is marked unread.
 *
 * `saveSessionMetadata` writes the whole metadata file, so the risk these
 * tests exist for is a field-level update silently erasing everything it did
 * not mention — the project binding especially, which would detach a
 * conversation from its folder as a side effect of renaming it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../memory-manager.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const SESSION = "aaaaaaaa-1111-2222-3333-444444444444";

let dir: string;
let mm: MemoryManager;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "lvis-session-row-fields-"));
  mm = new MemoryManager({ lvisDir: dir });
  await mm.saveSession(SESSION, [{ role: "user", content: "hello" }]);
});

afterEach(async () => {
  await cleanupTmpDir(dir);
});

describe("updateSessionRowFields", () => {
  it("keeps the rest of the metadata when one field changes", async () => {
    await mm.saveSessionMetadata(SESSION, {
      sessionKind: "main",
      projectRoot: "/ws/alpha",
      projectName: "alpha",
    });
    await mm.updateSessionRowFields(SESSION, { title: "이름 바꾼 대화" });

    const metadata = mm.loadSessionMetadata(SESSION);
    expect(metadata?.title).toBe("이름 바꾼 대화");
    // The whole point: renaming must not detach the conversation.
    expect(metadata?.projectRoot).toBe("/ws/alpha");
    expect(metadata?.projectName).toBe("alpha");
  });

  it("round-trips archived and unread through the listing", async () => {
    await mm.updateSessionRowFields(SESSION, { archivedAt: "2026-08-27T00:00:00.000Z" });
    await mm.updateSessionRowFields(SESSION, { unreadSince: "2026-08-27T01:00:00.000Z" });

    const listed = mm.listSessions().find((entry) => entry.id === SESSION);
    expect(listed?.archivedAt).toBe("2026-08-27T00:00:00.000Z");
    expect(listed?.unreadSince).toBe("2026-08-27T01:00:00.000Z");
  });

  it("clears a flag with null and leaves the other one alone", async () => {
    await mm.updateSessionRowFields(SESSION, {
      archivedAt: "2026-08-27T00:00:00.000Z",
      unreadSince: "2026-08-27T01:00:00.000Z",
    });
    await mm.updateSessionRowFields(SESSION, { archivedAt: null });

    const metadata = mm.loadSessionMetadata(SESSION);
    expect(metadata?.archivedAt).toBeUndefined();
    // `undefined` means "not mentioned", so unread must survive untouched —
    // that distinction is what lets one call unarchive without also marking read.
    expect(metadata?.unreadSince).toBe("2026-08-27T01:00:00.000Z");
  });

  it("keeps a title the user typed rather than cutting it to a few words", async () => {
    const typed = "회의록 정리와 후속 액션 아이템 추출까지 한 번에 처리한 대화";
    await mm.updateSessionRowFields(SESSION, { title: typed });
    expect(mm.loadSessionMetadata(SESSION)?.title).toBe(typed);
  });

  it("refuses a malformed session id instead of writing somewhere else", async () => {
    await expect(
      mm.updateSessionRowFields("../escape", { title: "x" }),
    ).rejects.toThrow(/invalid sessionId/);
  });
});
