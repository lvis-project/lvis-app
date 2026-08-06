import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_REVIEWER_MAX_TOKENS,
  MemoryReviewerService,
  MemoryReviewerUnavailableError,
  type ActiveChatOneShot,
  type MemoryReviewTask,
} from "../memory-reviewer-service.js";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("MemoryReviewerService", () => {
  it("uses the task-specific bounded, toolless one-shot contract for every memory task", async () => {
    const oneShot = vi.fn<ActiveChatOneShot>(async () => "reviewed");
    const service = new MemoryReviewerService({ resolveActiveChatOneShot: () => oneShot });
    const tasks: MemoryReviewTask[] = ["capture", "preference", "consolidation", "recap"];

    for (const task of tasks) {
      await expect(service.review(task, `${task} source`, {
        maxTokens: 99_999,
        systemPrompt: `Return ${task} output only.`,
      })).resolves.toBe("reviewed");
    }

    expect(oneShot).toHaveBeenCalledTimes(tasks.length);
    for (const [index, task] of tasks.entries()) {
      const [prompt, options] = oneShot.mock.calls[index]!;
      expect(prompt).toBe(`${task} source`);
      expect(options).toMatchObject({
        maxTokens: MEMORY_REVIEWER_MAX_TOKENS[task],
      });
      expect(options.systemPrompt).toContain(`Return ${task} output only.`);
      expect(options.systemPrompt).toContain("no tools");
      expect(options.systemPrompt).toContain("no storage authority");
      expect(options.systemPrompt).toContain("no permission authority");
      expect(options).not.toHaveProperty("tools");
    }
  });

  it("resolves the active one-shot caller only when a queued task starts", async () => {
    let resolveFirst: ((value: string) => void) | undefined;
    const firstCaller = vi.fn<ActiveChatOneShot>(() => new Promise<string>((resolve) => {
      resolveFirst = resolve;
    }));
    const replacementCaller = vi.fn<ActiveChatOneShot>(async () => "replacement result");
    let activeCaller: ActiveChatOneShot | null = firstCaller;
    const service = new MemoryReviewerService({
      resolveActiveChatOneShot: () => activeCaller,
    });

    const first = service.review("capture", "first");
    await flushMicrotasks();
    const second = service.review("preference", "second");
    activeCaller = replacementCaller;

    expect(firstCaller).toHaveBeenCalledOnce();
    expect(replacementCaller).not.toHaveBeenCalled();
    resolveFirst?.("first result");

    await expect(first).resolves.toBe("first result");
    await expect(second).resolves.toBe("replacement result");
    expect(replacementCaller).toHaveBeenCalledWith(
      "second",
      expect.objectContaining({ maxTokens: MEMORY_REVIEWER_MAX_TOKENS.preference }),
    );
  });

  it("serializes concurrent background calls and releases the lane after a failure", async () => {
    let resolveFirst: ((value: string) => void) | undefined;
    const started: string[] = [];
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const oneShot = vi.fn<ActiveChatOneShot>((prompt) => {
      started.push(prompt);
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      if (prompt === "first") {
        return new Promise<string>((resolve) => {
          resolveFirst = (value) => {
            activeCalls -= 1;
            resolve(value);
          };
        });
      }
      activeCalls -= 1;
      return Promise.resolve("second");
    });
    const service = new MemoryReviewerService({ resolveActiveChatOneShot: () => oneShot });

    const first = service.review("capture", "first");
    const second = service.review("consolidation", "second");
    await flushMicrotasks();

    expect(started).toEqual(["first"]);
    expect(service.pendingCount).toBe(2);
    resolveFirst?.("first result");

    await expect(first).resolves.toBe("first result");
    await expect(second).resolves.toBe("second");
    expect(started).toEqual(["first", "second"]);
    expect(maxActiveCalls).toBe(1);
    expect(service.pendingCount).toBe(0);

    const failingCaller = vi.fn<ActiveChatOneShot>()
      .mockRejectedValueOnce(new Error("upstream failed"))
      .mockResolvedValueOnce("after failure");
    const recovering = new MemoryReviewerService({
      resolveActiveChatOneShot: () => failingCaller,
    });
    const failed = recovering.review("capture", "bad");
    const recovered = recovering.review("recap", "good");

    await expect(failed).rejects.toThrow("upstream failed");
    await expect(recovered).resolves.toBe("after failure");
    expect(failingCaller).toHaveBeenCalledTimes(2);
  });


  it("runs a queued recap ahead of idle background maintenance", async () => {
    let resolveFirst: ((value: string) => void) | undefined;
    const started: string[] = [];
    const oneShot = vi.fn<ActiveChatOneShot>((prompt) => {
      started.push(prompt);
      if (prompt === "first") {
        return new Promise<string>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(prompt);
    });
    const service = new MemoryReviewerService({ resolveActiveChatOneShot: () => oneShot });

    const first = service.review("capture", "first");
    await flushMicrotasks();
    const maintenance = service.review("consolidation", "maintenance");
    const recap = service.review("recap", "recap");

    expect(started).toEqual(["first"]);
    resolveFirst?.("first result");

    await expect(first).resolves.toBe("first result");
    await expect(recap).resolves.toBe("recap");
    await expect(maintenance).resolves.toBe("maintenance");
    expect(started).toEqual(["first", "recap", "maintenance"]);
  });

  it("forwards an active call's AbortSignal and releases the serial lane", async () => {
    let observedSignal: AbortSignal | undefined;
    const oneShot = vi.fn<ActiveChatOneShot>(
      (_prompt, options) => new Promise<string>((_resolve, reject) => {
        observedSignal = options.signal;
        options.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason),
          { once: true },
        );
      }),
    );
    const service = new MemoryReviewerService({ resolveActiveChatOneShot: () => oneShot });
    const controller = new AbortController();

    const active = service.review("capture", "active", { signal: controller.signal });
    await flushMicrotasks();
    expect(observedSignal).toBe(controller.signal);

    controller.abort(new Error("cancelled while running"));
    await expect(active).rejects.toThrow("cancelled while running");
    await flushMicrotasks();
    expect(service.pendingCount).toBe(0);
  });
  it("rejects unavailable and cancelled queued work without calling the model", async () => {
    const unavailable = new MemoryReviewerService({ resolveActiveChatOneShot: () => null });
    await expect(unavailable.review("capture", "source"))
      .rejects.toBeInstanceOf(MemoryReviewerUnavailableError);

    let resolveFirst: ((value: string) => void) | undefined;
    const oneShot = vi.fn<ActiveChatOneShot>((prompt) => {
      if (prompt === "first") {
        return new Promise<string>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve("unexpected");
    });
    const service = new MemoryReviewerService({ resolveActiveChatOneShot: () => oneShot });
    const first = service.review("capture", "first");
    await flushMicrotasks();
    const controller = new AbortController();
    const cancelled = service.review("recap", "cancelled", { signal: controller.signal });
    controller.abort(new Error("cancelled by caller"));

    await expect(cancelled).rejects.toThrow("cancelled by caller");
    resolveFirst?.("first result");
    await expect(first).resolves.toBe("first result");
    await flushMicrotasks();
    expect(oneShot).toHaveBeenCalledTimes(1);
    expect(service.pendingCount).toBe(0);
  });
});
