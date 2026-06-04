/**
 * Sprint 4-B §B-7 — createCallLlmForPlugin per-plugin rate-limit + audit.
 */
import { describe, expect, it, vi } from "vitest";
import { createCallLlmForPlugin } from "../conversation.js";

describe("createCallLlmForPlugin (Sprint 4-B §B-7)", () => {
  function makeFakeLoop(): { generateText: ReturnType<typeof vi.fn> } {
    return { generateText: vi.fn(async () => "ok") };
  }
  function makeFakeAudit(): {
    log: ReturnType<typeof vi.fn>;
    entries: unknown[];
  } {
    const entries: unknown[] = [];
    return {
      log: vi.fn((e: unknown) => {
        entries.push(e);
      }),
      entries,
    };
  }

  it("permits up to maxCalls within the window", async () => {
    const loop = makeFakeLoop();
    const audit = makeFakeAudit();
    const callLlm = createCallLlmForPlugin(loop as never, audit as never, {
      maxCalls: 3,
      windowMs: 10_000,
    });
    for (let i = 0; i < 3; i += 1) {
      await expect(callLlm("p1", "hello")).resolves.toBe("ok");
    }
    expect(loop.generateText).toHaveBeenCalledTimes(3);
  });

  it("rejects the (maxCalls+1)-th call with rate-limit error and audits", async () => {
    const loop = makeFakeLoop();
    const audit = makeFakeAudit();
    const callLlm = createCallLlmForPlugin(loop as never, audit as never, {
      maxCalls: 2,
      windowMs: 10_000,
    });
    await callLlm("p1", "a");
    await callLlm("p1", "b");
    await expect(callLlm("p1", "c")).rejects.toThrow(/rate-limit exceeded/);
    const msgs = audit.entries
      .map((e) => (e as { input?: string }).input ?? "")
      .join("|");
    expect(msgs).toMatch(/rate-limit exceeded/);
  });

  it("buckets are per-plugin: one plugin's saturation does not block another", async () => {
    const loop = makeFakeLoop();
    const audit = makeFakeAudit();
    const callLlm = createCallLlmForPlugin(loop as never, audit as never, {
      maxCalls: 1,
      windowMs: 10_000,
    });
    await callLlm("p1", "a");
    await expect(callLlm("p1", "b")).rejects.toThrow();
    await expect(callLlm("p2", "c")).resolves.toBe("ok");
  });

  it("emits an audit entry per successful call including promptLen", async () => {
    const loop = makeFakeLoop();
    const audit = makeFakeAudit();
    const callLlm = createCallLlmForPlugin(loop as never, audit as never, {
      maxCalls: 5,
      windowMs: 10_000,
    });
    await callLlm("p1", "hello world");
    const msgs = audit.entries
      .map((e) => (e as { input?: string }).input ?? "")
      .join("|");
    expect(msgs).toMatch(/promptLen=11/);
  });

  it("passes abort signal through to ConversationLoop.generateText", async () => {
    const loop = makeFakeLoop();
    const audit = makeFakeAudit();
    const callLlm = createCallLlmForPlugin(loop as never, audit as never, {
      maxCalls: 5,
      windowMs: 10_000,
    });
    const controller = new AbortController();

    await callLlm("p1", "hello", { signal: controller.signal });
    expect(loop.generateText).toHaveBeenCalledWith(
      "hello",
      undefined,
      controller.signal,
    );
  });
});
