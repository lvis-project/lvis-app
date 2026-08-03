/**
 * A Tailnet controller may request a conversation turn, but cannot use that
 * turn to execute owner-configured hook code. This covers every public hook
 * dispatch boundary independently of the ConversationLoop wiring.
 */
import { describe, expect, it, vi } from "vitest";

import { HookRunner } from "../hook-runner.js";
import {
  ScriptHookManager,
  type HookDispatchPayload,
} from "../script-hook-manager.js";
import type { HookConfigEntry } from "../hook-config.js";
import type { TailnetControllerAuthority } from "../../shared/chat-origin.js";
import {
  resolveTurnExtensionPolicy,
  turnExtensionPolicyContext,
} from "../../shared/turn-extension-policy.js";

const TAILNET_AUTHORITY = {
  kind: "tailnet-controller",
  actorId: "tailnet:policy-regression-test",
} as const satisfies TailnetControllerAuthority;

const TAILNET_POLICY = resolveTurnExtensionPolicy(TAILNET_AUTHORITY);
const SUPPRESSED_RESULT = {
  decision: "allow" as const,
  reason: "external hooks disabled for remote-controller turn",
  results: [],
};

const TOOL_PAYLOAD: HookDispatchPayload = {
  toolName: "fs_write",
  source: "builtin",
  category: "write",
  input: { path: "/tmp/remote-turn.txt" },
  sessionId: "tailnet-session",
  trustOrigin: "tailnet-surface",
};

const LIFECYCLE_EVENTS = [
  "PostToolUseFailure",
  "PermissionDenied",
  "SessionStart",
  "SessionEnd",
  "Notification",
  "Stop",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
] as const;

function inTailnetControllerTurn<T>(operation: () => Promise<T>): Promise<T> {
  return turnExtensionPolicyContext.run(TAILNET_POLICY, operation);
}

function deniedHook(event: HookConfigEntry["event"]): HookConfigEntry {
  return {
    id: `${event}#tailnet-regression`,
    event,
    // If the policy guard regresses, this command exits non-zero and the
    // dispatch is denied. A passing test proves it was not run at all.
    command: [process.execPath, "-e", "process.exit(1)"],
    timeoutMs: 1_000,
    source: "config",
  };
}

describe("Tailnet turn extension policy", () => {
  it("suppresses every ScriptHookManager public dispatch", async () => {
    const manager = new ScriptHookManager();
    manager.setTrustedRegistry([], [
      deniedHook("pre"),
      deniedHook("post"),
      deniedHook("perm"),
      deniedHook("UserPromptSubmit"),
      ...LIFECYCLE_EVENTS.map(deniedHook),
    ]);
    expect(manager.size()).toBeGreaterThan(0);

    await inTailnetControllerTurn(async () => {
      const toolDispatches = await Promise.all([
        manager.runPreToolUse(TOOL_PAYLOAD),
        manager.runPostToolUse({ ...TOOL_PAYLOAD, toolOutput: "ok", isError: false }),
        manager.runPermissionRequest(TOOL_PAYLOAD),
        manager.runUserPromptSubmit("tailnet-session", "tailnet-surface", {
          inputText: "remote prompt",
          inputOrigin: "tailnet-surface",
          route: "llm",
          classification: "general",
        }),
      ]);
      for (const result of toolDispatches) expect(result).toEqual(SUPPRESSED_RESULT);

      for (const event of LIFECYCLE_EVENTS) {
        await expect(
          manager.runLifecycleEvent(event, "tailnet-session", "tailnet-surface"),
        ).resolves.toEqual(SUPPRESSED_RESULT);
      }
    });
  });

  it("suppresses registered in-process pre and post hooks", async () => {
    const runner = new HookRunner();
    const preHook = vi.fn(() => ({ action: "deny" as const, reason: "must not run" }));
    const postHook = vi.fn(() => ({ feedback: "must not run" }));
    runner.registerPreHook("unexpected-pre", preHook);
    runner.registerPostHook("unexpected-post", postHook);

    const [pre, post] = await inTailnetControllerTurn(() =>
      Promise.all([
        runner.runPreHooks({ toolName: "fs_write", toolInput: { path: "/tmp/x" } }),
        runner.runPostHooks({
          toolName: "fs_write",
          toolInput: { path: "/tmp/x" },
          toolOutput: "ok",
          isError: false,
        }),
      ]),
    );

    expect(pre).toEqual({
      action: "allow",
      updatedInput: { path: "/tmp/x" },
      feedback: undefined,
    });
    expect(post).toBeUndefined();
    expect(preHook).not.toHaveBeenCalled();
    expect(postHook).not.toHaveBeenCalled();
  });
});
