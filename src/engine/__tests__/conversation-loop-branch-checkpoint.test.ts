/**
 * C1 gap-lock — ConversationLoop.branchFromCheckpoint invalid-checkpoint paths.
 *
 * `branchFromCheckpoint` forks a new session from a numbered compaction
 * checkpoint. The three guard clauses that THROW on malformed input had no
 * coverage; this file locks each one against the CURRENT implementation:
 *   1. checkpoint number not present in session metadata
 *   2. checkpoint present but no persisted pre-compact snapshot
 *   3. snapshot shorter than the checkpoint's messageCountAtTrigger
 */
import { describe, expect, it, vi } from "vitest";

import { ConversationLoop, type ConversationLoopDeps } from "../conversation-loop.js";
import { makeConversationLoopDeps } from "./conversation-loop-test-helpers.js";

function makeLoop(
  memoryManager: ConversationLoopDeps["memoryManager"],
): ConversationLoop {
  return new ConversationLoop(makeConversationLoopDeps({ memoryManager }));
}

describe("ConversationLoop.branchFromCheckpoint invalid cases", () => {
  it("throws when the requested checkpoint number is not in session metadata", async () => {
    const memoryManager = {
      loadSessionMetadata: vi.fn(() => ({ checkpoints: [] })),
      loadCheckpointSnapshot: vi.fn(() => null),
    } as unknown as ConversationLoopDeps["memoryManager"];
    const loop = makeLoop(memoryManager);

    await expect(loop.branchFromCheckpoint(7)).rejects.toThrow(/Checkpoint #7 not found/);
  });

  it("throws when the checkpoint exists but no pre-compact snapshot was persisted", async () => {
    const memoryManager = {
      loadSessionMetadata: vi.fn(() => ({
        checkpoints: [{ compactNum: 3, messageCountAtTrigger: 2 }],
      })),
      loadCheckpointSnapshot: vi.fn(() => null),
    } as unknown as ConversationLoopDeps["memoryManager"];
    const loop = makeLoop(memoryManager);

    await expect(loop.branchFromCheckpoint(3)).rejects.toThrow(/no snapshot found for checkpoint #3/);
  });

  it("throws when the snapshot is shorter than the checkpoint's messageCountAtTrigger", async () => {
    const memoryManager = {
      loadSessionMetadata: vi.fn(() => ({
        checkpoints: [{ compactNum: 1, messageCountAtTrigger: 4 }],
      })),
      loadCheckpointSnapshot: vi.fn(() => []),
    } as unknown as ConversationLoopDeps["memoryManager"];
    const loop = makeLoop(memoryManager);

    await expect(loop.branchFromCheckpoint(1)).rejects.toThrow(/snapshot length 0 < checkpoint messageCountAtTrigger 4/);
  });
});
