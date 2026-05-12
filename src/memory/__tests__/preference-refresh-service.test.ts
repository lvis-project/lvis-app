import { describe, expect, it, vi } from "vitest";
import { PreferenceRefreshService } from "../preference-refresh-service.js";
import type { MemoryManager } from "../memory-manager.js";
import type { IdleStateChangeListener } from "../../main/idle-scheduler.js";

function makeMemoryManager() {
  return {
    listMemoryEntries: vi.fn(() => [
      {
        filename: "project.md",
        title: "Project",
        content: "User prefers direct status updates.",
        updatedAt: "2026-05-13T00:00:00Z",
      },
    ]),
    getAgentsMd: vi.fn(() => "# Agents\nUse Korean."),
    getUserPreferences: vi.fn(() => "# User Preferences\nExisting."),
    getMemoryIndex: vi.fn(() => "# Memory Index\n- Project"),
    updateUserPreferences: vi.fn(async () => undefined),
    updateUserPreferencesIfUnchanged: vi.fn(async () => true),
    saveMemory: vi.fn(),
  } as unknown as MemoryManager & {
    updateUserPreferences: ReturnType<typeof vi.fn>;
    updateUserPreferencesIfUnchanged: ReturnType<typeof vi.fn>;
    saveMemory: ReturnType<typeof vi.fn>;
  };
}

describe("PreferenceRefreshService", () => {
  it("refreshes user-preferences.md with preferences only", async () => {
    const memoryManager = makeMemoryManager();
    const generateText = vi.fn(async () => `# User Preferences
## Summary
- Direct Korean answers.
## Urgent Memory
급히 기억할 내용은 상태 업데이트를 짧게 자주 주고, 작업 누락을 막기 위해 task로 등록하며 진행하는 것이다.
## Communication Style
- Be direct.
## Workflow Preferences
- Track tasks.
## Standing Constraints
- Avoid unsupported claims.
## Source Links
- ~/.lvis/AGENTS.md`);

    const service = new PreferenceRefreshService({ memoryManager, generateText });
    const result = await service.refresh({ reason: "manual" });

    expect(result.content).not.toContain("## Urgent Memory");
    expect(result.content).not.toContain("급히 기억할 내용");
    expect(result.content).not.toContain("## Source Links");
    expect(memoryManager.updateUserPreferencesIfUnchanged).toHaveBeenCalledWith(
      "# User Preferences\nExisting.",
      result.content,
    );
    expect(memoryManager.updateUserPreferences).not.toHaveBeenCalled();
    expect(memoryManager.saveMemory).not.toHaveBeenCalled();
  });

  it("runs refresh when the idle scheduler enters IDLE_SCAN", async () => {
    let listener: IdleStateChangeListener | null = null;
    const idleScheduler = {
      addStateChangeListener: vi.fn((handler: IdleStateChangeListener) => {
        listener = handler;
        return () => undefined;
      }),
    };
    const memoryManager = makeMemoryManager();
    const generateText = vi.fn(async () => `# User Preferences
## Summary
## Communication Style
## Workflow Preferences
## Standing Constraints`);

    const service = new PreferenceRefreshService({
      memoryManager,
      generateText,
      idleScheduler: idleScheduler as never,
      minIdleRefreshIntervalMs: 0,
    });
    service.start();
    listener?.("IDLE_SCAN", "RUNNING", "test");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(generateText).toHaveBeenCalledOnce();
  });

  it("does not overwrite preferences when they changed during refresh", async () => {
    const memoryManager = makeMemoryManager();
    let resolveGenerate: ((value: string) => void) | null = null;
    const generateText = vi.fn(() => new Promise<string>((resolve) => {
      resolveGenerate = resolve;
    }));

    const service = new PreferenceRefreshService({ memoryManager, generateText });
    const pending = service.refresh({ reason: "manual" });
    expect(generateText).toHaveBeenCalledOnce();

    (memoryManager.updateUserPreferencesIfUnchanged as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    resolveGenerate?.(`# User Preferences
## Summary
stale
## Communication Style
## Workflow Preferences
## Standing Constraints`);

    await expect(pending).rejects.toThrow("user-preferences-changed-during-refresh");
    expect(memoryManager.updateUserPreferences).not.toHaveBeenCalled();
    expect(memoryManager.saveMemory).not.toHaveBeenCalled();
  });
});
