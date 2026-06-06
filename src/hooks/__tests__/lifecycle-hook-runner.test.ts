/**
 * #811 milestone-2 — lifecycle stdin/env through the generalized runner.
 *
 * Proves the SAME fail-closed / env-allowlist machinery carries the lifecycle
 * wire shape: LVIS_HOOK_EVENT + LVIS_HOOK_SESSION_ID are injected, the tool-name
 * env is omitted for session-only events, and the env allowlist still strips
 * secrets (design §6.2 — env allowlist unchanged).
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { runOneHookScript, type RunnableHook } from "../script-hook-runner.js";
import type { LifecycleHookStdin } from "../script-hook-types.js";

const FIXTURE_ROOT = resolve(__dirname, "..", "..", "..", "test", "fixtures", "hooks");
const ENV_FIXTURE = resolve(FIXTURE_ROOT, "cmd-lifecycle-env.js");

function hasNode(): boolean {
  try {
    execFileSync("node", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const HAS_NODE = hasNode();

function lifecycleRunnable(command: string[]): RunnableHook {
  return {
    id: "config:Stop#0.0",
    hookType: "Stop",
    hookPath: command[0],
    command,
    source: "config",
  };
}

describe("#811 m2 — lifecycle runner env injection", () => {
  it.skipIf(!HAS_NODE)("injects LVIS_HOOK_EVENT + LVIS_HOOK_SESSION_ID; omits tool env for session-only events", async () => {
    const stdin: LifecycleHookStdin = {
      hookType: "Stop",
      event: "Stop",
      sessionId: "sess-99",
      trustOrigin: "unknown",
      stopReason: "end_turn",
    };
    const r = await runOneHookScript(lifecycleRunnable(["node", ENV_FIXTURE]), stdin);
    expect(r.decision).toBe("allow");
    expect(r.reason).toContain("EVENT=Stop");
    expect(r.reason).toContain("TYPE=Stop");
    expect(r.reason).toContain("SESSION=sess-99");
    // No toolName on a session-only lifecycle event ⇒ env var omitted.
    expect(r.reason).toContain("TOOL=<unset>");
    expect(r.reason).toContain("ORIGIN=unknown");
  });

  it.skipIf(!HAS_NODE)("sets LVIS_HOOK_TOOL_NAME for tool-bearing lifecycle events", async () => {
    const stdin: LifecycleHookStdin = {
      hookType: "PostToolUseFailure",
      event: "PostToolUseFailure",
      sessionId: "s1",
      trustOrigin: "unknown",
      toolName: "bash",
    };
    const r = await runOneHookScript(
      { ...lifecycleRunnable(["node", ENV_FIXTURE]), hookType: "PostToolUseFailure" },
      stdin,
    );
    expect(r.reason).toContain("EVENT=PostToolUseFailure");
    expect(r.reason).toContain("TOOL=bash");
  });

  it.skipIf(!HAS_NODE)("env allowlist still strips secrets on a lifecycle dispatch", async () => {
    const prev = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      LVIS_SECRET_PROBE: process.env.LVIS_SECRET_PROBE,
    };
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    process.env.LVIS_SECRET_PROBE = "lvis-internal-should-not-leak";
    try {
      const stdin: LifecycleHookStdin = {
        hookType: "SessionStart",
        event: "SessionStart",
        sessionId: "s1",
        trustOrigin: "unknown",
      };
      const r = await runOneHookScript(
        { ...lifecycleRunnable(["node", ENV_FIXTURE]), hookType: "SessionStart" },
        stdin,
      );
      expect(r.reason).toContain("SECRET=clean");
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
