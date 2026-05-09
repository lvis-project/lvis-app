/**
 * Q12 boot hook wiring regression.
 *
 * Production boot must not load legacy hooks.json command/http hooks. The
 * single external hook path is wireHookSystem() with discrete pre/post/perm
 * scripts and TOFU quarantine.
 */
import { describe, it, expect } from "vitest";
import { createHookRunner } from "../boot/conversation.js";

describe("boot hook runner wiring", () => {
  it("creates an in-process HookRunner without legacy external hooks", async () => {
    const runner = createHookRunner();

    const pre = await runner.runPreHooks({
      toolName: "bash",
      toolInput: { command: "ls" },
    });
    const post = await runner.runPostHooks({
      toolName: "bash",
      toolInput: { command: "ls" },
      toolOutput: "ok",
      isError: false,
    });

    expect(runner.preHookCount).toBe(0);
    expect(runner.postHookCount).toBe(0);
    expect(pre).toMatchObject({ action: "allow" });
    expect(post).toBeUndefined();
  });
});
