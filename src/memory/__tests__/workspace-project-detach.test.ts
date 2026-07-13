import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryManager, type SessionMetadata } from "../memory-manager.js";

const SESSION_A = "workspace-detach-a";
const SESSION_B = "workspace-detach-b";
const SESSION_OTHER = "workspace-detach-other";
const ROOT = "C:\\Work\\Alpha";

let dir: string;
let memory: MemoryManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lvis-workspace-detach-"));
  memory = new MemoryManager({ lvisDir: dir });
});

afterEach(() => {
  memory.closeSearchIndex();
  rmSync(dir, { recursive: true, force: true });
});

async function seed(
  sessionId: string,
  projectRoot: string,
  title: string,
): Promise<string> {
  await memory.saveSession(sessionId, [{ role: "user", content: `message-${sessionId}` }]);
  await memory.saveSessionMetadata(sessionId, {
    sessionKind: "main",
    projectRoot,
    projectName: "Alpha",
    title,
    customFutureField: { preserved: true },
  } as SessionMetadata);
  return readFileSync(join(dir, "sessions", `${sessionId}.jsonl`), "utf-8");
}

describe("MemoryManager workspace project detachment", () => {
  it("preserves JSONL and unrelated metadata while detaching matching path variants", async () => {
    const originalA = await seed(SESSION_A, ROOT, "alpha-a");
    const originalB = await seed(SESSION_B, "c:/work/alpha/", "alpha-b");
    await seed(SESSION_OTHER, "C:\\Work\\Beta", "beta");

    expect(memory.searchSessions(`message-${SESSION_A}`, { projectRoot: ROOT })).toHaveLength(1);
    await expect(memory.detachSessionsFromProject(ROOT)).resolves.toBe(2);
    await expect(memory.detachSessionsFromProject(ROOT)).resolves.toBe(0);

    expect(memory.searchSessions(`message-${SESSION_A}`, { projectRoot: ROOT })).toHaveLength(0);
    expect(memory.searchSessions(`message-${SESSION_A}`)).toHaveLength(1);
    expect(readFileSync(join(dir, "sessions", `${SESSION_A}.jsonl`), "utf-8")).toBe(originalA);
    expect(readFileSync(join(dir, "sessions", `${SESSION_B}.jsonl`), "utf-8")).toBe(originalB);
    expect(memory.loadSessionMetadata(SESSION_A)).toMatchObject({ title: "alpha-a" });
    expect(memory.loadSessionMetadata(SESSION_A)?.projectRoot).toBeUndefined();
    expect(memory.loadSessionMetadata(SESSION_A)?.projectName).toBeUndefined();
    expect(memory.loadSessionMetadata(SESSION_OTHER)?.projectRoot).toBe("C:\\Work\\Beta");

    const raw = JSON.parse(
      readFileSync(join(dir, "sessions", `${SESSION_A}.meta.json`), "utf-8"),
    ) as Record<string, unknown>;
    expect(raw.customFutureField).toEqual({ preserved: true });
  });

  it("keeps old sessions detached after re-add while allowing new sessions to use the root", async () => {
    await seed(SESSION_A, ROOT, "alpha");
    const stale = memory.loadSessionMetadata(SESSION_A)!;

    await memory.detachSessionsFromProject(ROOT);
    await memory.saveSessionMetadata(SESSION_A, { ...stale, title: "late" });
    expect(memory.loadSessionMetadata(SESSION_A)?.projectRoot).toBeUndefined();

    memory.allowProjectRoot(ROOT);
    await memory.saveSessionMetadata(SESSION_A, stale);
    expect(memory.loadSessionMetadata(SESSION_A)?.projectRoot).toBeUndefined();

    await memory.saveSession(SESSION_B, [{ role: "user", content: "new-after-readd" }]);
    await memory.saveSessionMetadata(SESSION_B, {
      sessionKind: "main",
      projectRoot: ROOT,
      projectName: "Alpha",
    });
    expect(memory.loadSessionMetadata(SESSION_B)?.projectRoot).toBe(ROOT);
  });

  it("tombstones a session whose first stale metadata write arrives while the root is absent", async () => {
    await memory.saveSession(SESSION_A, [{ role: "user", content: "active-before-removal" }]);
    await memory.detachSessionsFromProject(ROOT);

    const stale: SessionMetadata = {
      sessionKind: "main",
      projectRoot: ROOT,
      projectName: "Alpha",
      title: "late",
    };
    await memory.saveSessionMetadata(SESSION_A, stale);
    expect(memory.loadSessionMetadata(SESSION_A)?.projectRoot).toBeUndefined();

    memory.allowProjectRoot(ROOT);
    await memory.saveSessionMetadata(SESSION_A, stale);
    expect(memory.loadSessionMetadata(SESSION_A)?.projectRoot).toBeUndefined();
  });

  it("removes an orphaned FTS row when project metadata exists without JSONL", async () => {
    await seed(SESSION_A, ROOT, "orphaned-index-row");
    rmSync(join(dir, "sessions", `${SESSION_A}.jsonl`));

    expect(memory.searchSessions(`message-${SESSION_A}`).map((entry) => entry.sessionId)).toEqual([
      SESSION_A,
    ]);

    await expect(memory.detachSessionsFromProject(ROOT)).resolves.toBe(1);

    expect(memory.loadSessionMetadata(SESSION_A)?.projectRoot).toBeUndefined();
    expect(memory.searchSessions(`message-${SESSION_A}`)).toEqual([]);
  });

  it("is idempotent under concurrent detach calls", async () => {
    await seed(SESSION_A, ROOT, "alpha");
    const counts = await Promise.all([
      memory.detachSessionsFromProject(ROOT),
      memory.detachSessionsFromProject(ROOT),
    ]);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(memory.loadSessionMetadata(SESSION_A)?.projectRoot).toBeUndefined();
  });

  it("reports malformed metadata instead of declaring detach success", async () => {
    await seed(SESSION_A, ROOT, "alpha");
    writeFileSync(
      join(dir, "sessions", `${SESSION_A}.meta.json`),
      `{"projectRoot":${JSON.stringify(ROOT)},`,
      "utf-8",
    );
    await expect(memory.detachSessionsFromProject(ROOT)).rejects.toMatchObject({
      code: "SESSION_METADATA_INVALID",
    });
  });
});
