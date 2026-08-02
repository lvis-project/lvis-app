import { describe, expect, it, vi } from "vitest";
import {
  MemoryCaptureService,
  type MemoryCaptureReviewer,
} from "../memory-capture-service.js";
import type { MemoryManager, NoteEntry } from "../memory-manager.js";

const SOURCE = "I prefer concise status updates in Korean.";

function reviewedCapture(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    v: 1,
    action: "active",
    title: "Communication preference",
    content: "The user prefers concise status updates in Korean.",
    kind: "preference",
    evidence: "I prefer concise status updates in Korean.",
    confidence: 0.94,
    ...overrides,
  });
}

function makeMemoryManager(existing: NoteEntry[] = []) {
  const saved: NoteEntry[] = [];
  const saveMemory = vi.fn(async (
    title: string,
    content: string,
    options: Partial<NoteEntry> = {},
  ): Promise<NoteEntry> => {
    const entry: NoteEntry = {
      id: `memory-${saved.length + 1}`,
      filename: `memory-${saved.length + 1}.md`,
      title,
      content,
      updatedAt: "2026-08-02T00:00:00.000Z",
      ...options,
    };
    saved.push(entry);
    return entry;
  });
  const listMemoryEntries = vi.fn(() => [...existing, ...saved]);
  return {
    manager: { saveMemory, listMemoryEntries } as unknown as Pick<
      MemoryManager,
      "saveMemory" | "listMemoryEntries"
    >,
    saveMemory,
    listMemoryEntries,
  };
}

function makeMemoryReviewer(raw = reviewedCapture()) {
  const review = vi.fn<MemoryCaptureReviewer["review"]>(async () => raw);
  return {
    memoryReviewer: { review } as MemoryCaptureReviewer,
    review,
  };
}

function enqueueTrustedAutomatic(service: MemoryCaptureService, input = SOURCE): void {
  service.enqueueAutomatic({
    sessionId: "session-1",
    input,
    inputOrigin: "user-keyboard",
    stopReason: "end_turn",
  });
}

describe("MemoryCaptureService", () => {
  it("host-validates a trusted automatic capture before saving it as active", async () => {
    const { manager, saveMemory } = makeMemoryManager();
    const { memoryReviewer, review } = makeMemoryReviewer();
    const service = new MemoryCaptureService({
      memoryManager: manager,
      getMode: () => "auto",
    });
    service.setMemoryReviewer(memoryReviewer);

    enqueueTrustedAutomatic(service);
    await service.runOnIdle();

    expect(review).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledWith(
      "capture",
      expect.stringContaining(SOURCE),
      expect.objectContaining({
        signal: expect.anything(),
        systemPrompt: "Return exactly the requested JSON object and nothing else.",
      }),
    );
    expect(saveMemory).toHaveBeenCalledWith(
      "Communication preference",
      "The user prefers concise status updates in Korean.",
      expect.objectContaining({
        kind: "preference",
        state: "active",
        source: "capture",
        capture: expect.objectContaining({
          v: 1,
          method: "llm-refined",
          trigger: "automatic",
          sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    );
  });

  it("keeps unattended captures as candidates in review mode", async () => {
    const { manager, saveMemory } = makeMemoryManager();
    const { memoryReviewer } = makeMemoryReviewer();
    const service = new MemoryCaptureService({
      memoryManager: manager,
      getMode: () => "review",
      memoryReviewer,
    });

    enqueueTrustedAutomatic(service);
    await service.runOnIdle();

    expect(saveMemory).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ state: "candidate", source: "capture" }),
    );
  });

  it("rejects tainted automatic turns before any model or storage call", async () => {
    const { manager, saveMemory } = makeMemoryManager();
    const { memoryReviewer, review } = makeMemoryReviewer();
    const service = new MemoryCaptureService({
      memoryManager: manager,
      getMode: () => "auto",
      memoryReviewer,
    });

    service.enqueueAutomatic({
      sessionId: "session-1",
      input: SOURCE,
      inputOrigin: "user-keyboard",
      stopReason: "end_turn",
      taintReasons: ["attachment"],
    });
    await service.runOnIdle();

    expect(review).not.toHaveBeenCalled();
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it("never falls back to raw automatic input after an invalid reviewer result", async () => {
    const { manager, saveMemory } = makeMemoryManager();
    const { memoryReviewer } = makeMemoryReviewer("not json");
    const service = new MemoryCaptureService({
      memoryManager: manager,
      getMode: () => "auto",
      memoryReviewer,
    });

    enqueueTrustedAutomatic(service);
    await service.runOnIdle();

    expect(saveMemory).not.toHaveBeenCalled();
  });

  it("diverts an automatic title collision with user memory to a candidate", async () => {
    const { manager, saveMemory } = makeMemoryManager([{
      filename: "user.md",
      title: "Communication preference",
      content: "Existing user-controlled preference.",
      source: "user",
      state: "active",
    }]);
    const { memoryReviewer } = makeMemoryReviewer();
    const service = new MemoryCaptureService({
      memoryManager: manager,
      getMode: () => "auto",
      memoryReviewer,
    });

    enqueueTrustedAutomatic(service);
    await service.runOnIdle();

    expect(saveMemory).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ state: "candidate", source: "capture" }),
    );
  });

  it("runs explicit user saves through the same reviewer even when auto capture is off", async () => {
    const { manager, saveMemory } = makeMemoryManager();
    const { memoryReviewer, review } = makeMemoryReviewer();
    const service = new MemoryCaptureService({
      memoryManager: manager,
      getMode: () => "off",
      memoryReviewer,
    });

    const result = await service.captureExplicit({
      title: "Status preference",
      content: SOURCE,
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
    });

    expect(result.status).toBe("saved");
    expect(review).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledWith(
      "capture",
      expect.stringContaining(SOURCE),
      expect.any(Object),
    );
    expect(saveMemory).toHaveBeenCalledWith(
      "Communication preference",
      "The user prefers concise status updates in Korean.",
      expect.objectContaining({
        state: "active",
        source: "user",
        projectRoot: "C:\\workspace\\alpha",
        projectName: "alpha",
        capture: expect.objectContaining({ trigger: "explicit" }),
      }),
    );
  });

  it("does not send explicit sensitive input to the reviewer", async () => {
    const { manager, saveMemory } = makeMemoryManager();
    const { memoryReviewer, review } = makeMemoryReviewer();
    const service = new MemoryCaptureService({
      memoryManager: manager,
      getMode: () => "off",
      memoryReviewer,
    });

    const result = await service.captureExplicit({
      content: "api_key=sk-abcdefghijklmnopqrst",
    });

    expect(result).toEqual({ status: "skipped", reason: "sensitive-input" });
    expect(review).not.toHaveBeenCalled();
    expect(saveMemory).not.toHaveBeenCalled();
  });
});
