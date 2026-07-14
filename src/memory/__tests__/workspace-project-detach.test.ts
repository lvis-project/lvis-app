import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    expect(memory.searchSessions(`message-${SESSION_OTHER}`, {
      projectRoot: "C:\\Work\\Beta",
    })).toHaveLength(1);

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

  it("cancels a detached wire task while preserving its host-visible identity", async () => {
    const originSessionId = "wire-origin-session";
    const wireMetadata: SessionMetadata = {
      sessionKind: "subagent",
      projectRoot: ROOT,
      projectName: "Alpha",
      sourceTools: ["noop"],
      originSessionId,
      a2aWireHandlerId: "wire-handler",
      a2aWireInternalOrigin: originSessionId,
      subAgentTitle: "wire task",
      subAgentTaskState: "TASK_STATE_INPUT_REQUIRED",
      subAgentSuspensionReason: "question",
      subAgentSuspensionPrompt: "Continue?",
    };
    await memory.saveSession(SESSION_A, [{ role: "user", content: "wire transcript" }]);
    await memory.saveSessionMetadata(SESSION_A, wireMetadata);
    const transcript = readFileSync(
      join(dir, "sessions", `${SESSION_A}.jsonl`),
      "utf-8",
    );

    await expect(memory.detachSessionsFromProject(ROOT)).resolves.toBe(1);

    const assertDetachedWireTask = (): void => {
      const metadata = memory.loadSessionMetadata(SESSION_A);
      expect(metadata).toMatchObject({
        sessionKind: "subagent",
        originSessionId,
        a2aWireHandlerId: "wire-handler",
        a2aWireInternalOrigin: originSessionId,
        sourceTools: ["noop"],
        subAgentTaskState: "TASK_STATE_CANCELED",
      });
      expect(metadata?.projectRoot).toBeUndefined();
      expect(metadata?.projectName).toBeUndefined();
      expect(metadata?.subAgentSuspensionReason).toBeUndefined();
      expect(metadata?.subAgentSuspensionPrompt).toBeUndefined();
    };
    assertDetachedWireTask();
    expect(readFileSync(join(dir, "sessions", `${SESSION_A}.jsonl`), "utf-8"))
      .toBe(transcript);

    memory.allowProjectRoot(ROOT);
    await memory.saveSessionMetadata(SESSION_A, wireMetadata);
    assertDetachedWireTask();

    memory.closeSearchIndex();
    memory = new MemoryManager({ lvisDir: dir });
    assertDetachedWireTask();
  });

  it.each([
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_REJECTED",
    "TASK_STATE_CANCELED",
  ] as const)("preserves the first terminal wire outcome after detach and stale writes (%s)", async (
    terminalState,
  ) => {
    const originSessionId = "wire-terminal-origin";
    const terminalMetadata: SessionMetadata = {
      sessionKind: "subagent",
      projectRoot: ROOT,
      projectName: "Alpha",
      sourceTools: ["noop"],
      originSessionId,
      a2aWireHandlerId: "wire-terminal-handler",
      a2aWireInternalOrigin: originSessionId,
      subAgentTitle: "terminal wire task",
      subAgentTaskState: terminalState,
    };
    await memory.saveSession(SESSION_A, [{ role: "user", content: "terminal transcript" }]);
    await memory.saveSessionMetadata(SESSION_A, terminalMetadata);

    await expect(memory.detachSessionsFromProject(ROOT)).resolves.toBe(1);
    expect(memory.loadSessionMetadata(SESSION_A)).toMatchObject({
      projectRoot: undefined,
      a2aWireHandlerId: "wire-terminal-handler",
      subAgentTaskState: terminalState,
    });

    memory.allowProjectRoot(ROOT);
    await memory.saveSessionMetadata(SESSION_A, {
      ...terminalMetadata,
      subAgentTaskState: "TASK_STATE_INPUT_REQUIRED",
      subAgentSuspensionReason: "question",
      subAgentSuspensionPrompt: "stale writer",
    });
    const afterStaleWrite = memory.loadSessionMetadata(SESSION_A);
    expect(afterStaleWrite).toMatchObject({
      projectRoot: undefined,
      a2aWireHandlerId: "wire-terminal-handler",
      subAgentTaskState: terminalState,
    });
    expect(afterStaleWrite?.subAgentSuspensionReason).toBeUndefined();
    expect(afterStaleWrite?.subAgentSuspensionPrompt).toBeUndefined();
  });

  it.each([
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_REJECTED",
    "TASK_STATE_CANCELED",
  ] as const)("accepts a rootless terminal wire record (%s)", async (terminalState) => {
    const originSessionId = "rootless-wire-origin";
    await memory.saveSessionMetadata(SESSION_A, {
      sessionKind: "subagent",
      sourceTools: [],
      originSessionId,
      a2aWireHandlerId: "rootless-wire-handler",
      a2aWireInternalOrigin: originSessionId,
      subAgentTitle: "rootless terminal",
      subAgentTaskState: terminalState,
    });

    expect(memory.loadSessionMetadata(SESSION_A)).toMatchObject({
      projectRoot: undefined,
      sourceTools: [],
      a2aWireHandlerId: "rootless-wire-handler",
      subAgentTaskState: terminalState,
    });
  });

  it("does not treat explicitly undefined wire fields as a wire binding", async () => {
    await memory.saveSession(SESSION_A, [{ role: "user", content: "ordinary sub-agent" }]);
    await memory.saveSessionMetadata(SESSION_A, {
      sessionKind: "subagent",
      projectRoot: ROOT,
      sourceTools: ["noop"],
      originSessionId: "ordinary-origin",
      a2aWireHandlerId: undefined,
      a2aWireInternalOrigin: undefined,
      subAgentTitle: "ordinary sub-agent",
      subAgentTaskState: "TASK_STATE_INPUT_REQUIRED",
      subAgentSuspensionReason: "question",
      subAgentSuspensionPrompt: "ordinary question",
    });

    await expect(memory.detachSessionsFromProject(ROOT)).resolves.toBe(1);
    expect(memory.loadSessionMetadata(SESSION_A)).toMatchObject({
      projectRoot: undefined,
      a2aWireHandlerId: undefined,
      a2aWireInternalOrigin: undefined,
      subAgentTaskState: "TASK_STATE_INPUT_REQUIRED",
      subAgentSuspensionReason: "question",
      subAgentSuspensionPrompt: "ordinary question",
    });
  });

  it("clears detached wire terminal tombstones when a session is deleted", async () => {
    const originSessionId = "wire-delete-origin";
    await memory.saveSessionMetadata(SESSION_A, {
      sessionKind: "subagent",
      projectRoot: ROOT,
      sourceTools: ["noop"],
      originSessionId,
      a2aWireHandlerId: "wire-delete-handler",
      a2aWireInternalOrigin: originSessionId,
      subAgentTitle: "wire delete",
      subAgentTaskState: "TASK_STATE_COMPLETED",
    });
    await memory.detachSessionsFromProject(ROOT);
    memory.allowProjectRoot(ROOT);
    await memory.deleteSession(SESSION_A);

    await memory.saveSessionMetadata(SESSION_A, {
      sessionKind: "main",
      projectRoot: ROOT,
      title: "replacement",
    });
    expect(memory.loadSessionMetadata(SESSION_A)).toMatchObject({
      sessionKind: "main",
      projectRoot: ROOT,
      title: "replacement",
    });
  });

  it("fails closed when matching metadata has a partial wire identity", async () => {
    await seed(SESSION_A, ROOT, "partial-wire");
    const metadataPath = join(dir, "sessions", `${SESSION_A}.meta.json`);
    const raw = JSON.parse(readFileSync(metadataPath, "utf-8")) as Record<string, unknown>;
    writeFileSync(
      metadataPath,
      JSON.stringify({
        ...raw,
        sessionKind: "subagent",
        sourceTools: ["noop"],
        originSessionId: "wire-origin-session",
        a2aWireHandlerId: "wire-handler",
        subAgentTaskState: "TASK_STATE_INPUT_REQUIRED",
      }),
      "utf-8",
    );

    await expect(memory.detachSessionsFromProject(ROOT)).rejects.toMatchObject({
      code: "SESSION_METADATA_INVALID",
    });
  });

  it("preflights every metadata file before rewriting any matching session", async () => {
    await seed(SESSION_A, ROOT, "valid-first");
    await seed(SESSION_B, ROOT, "malformed-second");
    writeFileSync(
      join(dir, "sessions", `${SESSION_B}.meta.json`),
      `{"projectRoot":${JSON.stringify(ROOT)},`,
      "utf8",
    );

    await expect(memory.detachSessionsFromProject(ROOT)).rejects.toMatchObject({
      code: "SESSION_METADATA_INVALID",
    });

    expect(memory.loadSessionMetadata(SESSION_A)?.projectRoot).toBe(ROOT);
    expect(memory.searchSessions(`message-${SESSION_A}`, { projectRoot: ROOT }))
      .toHaveLength(1);
  });

  it("repairs every FTS row on a zero-change detach retry", async () => {
    await seed(SESSION_A, ROOT, "stale-index");
    await expect(memory.detachSessionsFromProject(ROOT)).resolves.toBe(1);
    const searchIndex = (memory as unknown as {
      searchIndex: {
        open(): boolean;
        close(): void;
        upsertSession(input: {
          sessionId: string;
          content: string;
          timestamp: string;
          sessionKind: "main";
          projectRoot: string;
          title: string;
        }): void;
      };
    }).searchIndex;
    expect(searchIndex.open()).toBe(true);
    searchIndex.upsertSession({
      sessionId: SESSION_A,
      content: `message-${SESSION_A}`,
      timestamp: new Date().toISOString(),
      sessionKind: "main",
      projectRoot: ROOT,
      title: "stale-index",
    });
    searchIndex.close();
    expect(memory.searchSessions(`message-${SESSION_A}`, { projectRoot: ROOT }))
      .toHaveLength(1);

    await expect(memory.detachSessionsFromProject(ROOT)).resolves.toBe(0);

    expect(memory.searchSessions(`message-${SESSION_A}`, { projectRoot: ROOT }))
      .toHaveLength(0);
    expect(memory.searchSessions(`message-${SESSION_A}`)).toHaveLength(1);
  });

  it("preserves a retryable error when full FTS repair cannot open", async () => {
    await seed(SESSION_A, ROOT, "repair-retry");
    const searchIndex = (memory as unknown as {
      searchIndex: { open(): boolean };
    }).searchIndex;
    const openSpy = vi.spyOn(searchIndex, "open").mockReturnValueOnce(false);

    await expect(memory.detachSessionsFromProject(ROOT)).rejects.toMatchObject({
      code: "SESSION_SEARCH_INDEX_REPAIR_FAILED",
    });
    expect(memory.loadSessionMetadata(SESSION_A)?.projectRoot).toBeUndefined();

    openSpy.mockRestore();
    await expect(memory.detachSessionsFromProject(ROOT)).resolves.toBe(0);
    expect(memory.searchSessions(`message-${SESSION_A}`)).toHaveLength(1);
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
