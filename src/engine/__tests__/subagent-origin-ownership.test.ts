import { describe, expect, it, vi } from "vitest";
import { SubAgentRunner } from "../subagent-runner.js";

/**
 * `isPersistedSpawnOfOrigin` is an authorization predicate: it decides whether a
 * parent may read a child's transcript. These cases pin the boundary — it must
 * accept only a sub-agent session whose host-written `originSessionId` names
 * exactly this parent, and reject everything else, including a MAIN session id
 * (which would otherwise be a way to read another conversation).
 */
function runnerWith(metadataById: Record<string, unknown>) {
  const subAgentMemoryManager = {
    loadSessionMetadata: vi.fn((id: string) => metadataById[id] ?? null),
  };
  // Only the two members the predicate touches are needed; the rest of the
  // runner's dependency surface is irrelevant to this decision.
  return new SubAgentRunner({ subAgentMemoryManager } as never);
}

const PARENT = "11111111-1111-4111-8111-111111111111";
const OTHER_PARENT = "22222222-2222-4222-8222-222222222222";
const CHILD = "sub-11111111-33333333-3333-4333-8333-333333333333";

describe("SubAgentRunner.isPersistedSpawnOfOrigin", () => {
  it("accepts a sub-agent whose originSessionId names this parent", () => {
    const runner = runnerWith({
      [CHILD]: { sessionKind: "subagent", originSessionId: PARENT },
    });
    expect(runner.isPersistedSpawnOfOrigin(PARENT, CHILD)).toBe(true);
  });

  it("rejects a sub-agent owned by a different parent", () => {
    const runner = runnerWith({
      [CHILD]: { sessionKind: "subagent", originSessionId: OTHER_PARENT },
    });
    expect(runner.isPersistedSpawnOfOrigin(PARENT, CHILD)).toBe(false);
  });

  it("rejects a session that is not a sub-agent even if origin matches", () => {
    // A main session must never be readable through the sub-agent transcript
    // path, whatever its metadata claims about an origin.
    const runner = runnerWith({
      [CHILD]: { sessionKind: "main", originSessionId: PARENT },
    });
    expect(runner.isPersistedSpawnOfOrigin(PARENT, CHILD)).toBe(false);
  });

  it("rejects a child with no recorded origin", () => {
    // Older children predate origin recording; absent ownership is not
    // ownership, and the transcript-scan path remains their only route.
    const runner = runnerWith({ [CHILD]: { sessionKind: "subagent" } });
    expect(runner.isPersistedSpawnOfOrigin(PARENT, CHILD)).toBe(false);
  });

  it("rejects an unknown child", () => {
    expect(runnerWith({}).isPersistedSpawnOfOrigin(PARENT, CHILD)).toBe(false);
  });

  it("rejects malformed ids without touching storage", () => {
    const metadata = { [CHILD]: { sessionKind: "subagent", originSessionId: PARENT } };
    const subAgentMemoryManager = { loadSessionMetadata: vi.fn(() => metadata[CHILD]) };
    const runner = new SubAgentRunner({ subAgentMemoryManager } as never);

    expect(runner.isPersistedSpawnOfOrigin("../escape", CHILD)).toBe(false);
    expect(runner.isPersistedSpawnOfOrigin(PARENT, "../escape")).toBe(false);
    expect(runner.isPersistedSpawnOfOrigin("", "")).toBe(false);
    expect(subAgentMemoryManager.loadSessionMetadata).not.toHaveBeenCalled();
  });
});
