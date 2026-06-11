/**
 * #811 command-hooks milestone — composition + back-compat through the manager.
 *
 * Spec ref: docs/architecture/hook-runtime-expansion-design.md §4.3 / §9.
 *
 * Covers: the ScriptHookManager dispatching the UNIFIED registry (trusted `.sh`
 * + trusted config entries), deny precedence across origins, the rule that a
 * later allow can never upgrade an earlier deny, and that with no config the
 * behavior is identical to today.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { ScriptHookManager, type HookDispatchPayload } from "../script-hook-manager.js";
import type { DiscoveredHook } from "../hook-discovery.js";
import type { HookConfigEntry } from "../hook-config.js";

const FIXTURE_ROOT = resolve(__dirname, "..", "..", "..", "test", "fixtures", "hooks");
const shellOpts = process.platform === "win32" ? { timeoutMs: 20_000 } : undefined;

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const HAS_PYTHON = hasPython();

function shHook(fileName: string, type: "pre" | "post" | "perm" = "pre"): DiscoveredHook {
  return {
    path: resolve(FIXTURE_ROOT, fileName),
    fileName,
    hookType: type,
    sha256: "test",
    size: 0,
  };
}

function configEntry(over: Partial<HookConfigEntry> & Pick<HookConfigEntry, "id" | "command">): HookConfigEntry {
  return {
    event: "pre",
    timeoutMs: 5000,
    source: "config",
    ...over,
  };
}

const payload: HookDispatchPayload = {
  toolName: "fs_write",
  source: "builtin",
  category: "write",
  input: { path: "/tmp/x" },
  sessionId: "sess-1",
  trustOrigin: "user-keyboard",
};

describe("#811 manager — unified registry dispatch", () => {
  it.skipIf(!HAS_PYTHON)("runs a trusted config command entry for matching tools", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry(
      [],
      [configEntry({ id: "PreToolUse#0.0", command: ["python3", resolve(FIXTURE_ROOT, "cmd-policy.py")] })],
    );
    const out = await m.runPreToolUse(payload);
    expect(out.decision).toBe("allow");
    expect(out.results).toHaveLength(1);
  });

  it.skipIf(!HAS_PYTHON)("deny precedence across .sh + config (config denies)", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry(
      [shHook("pre-allow.sh")],
      [configEntry({ id: "PreToolUse#0.0", command: ["python3", resolve(FIXTURE_ROOT, "cmd-policy.py")] })],
    );
    // toolName contains "blocked" → the python config hook denies.
    const out = await m.runPreToolUse({ ...payload, toolName: "blocked_thing" }, shellOpts);
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("blocked_thing");
  });

  it.skipIf(!HAS_PYTHON)("a later allow cannot upgrade an earlier deny", async () => {
    const m = new ScriptHookManager();
    // Order: .sh deny (runs first), then config allow. Chain must stop at deny.
    m.setTrustedRegistry(
      [shHook("pre-deny.sh")],
      [configEntry({ id: "PreToolUse#0.0", command: ["python3", resolve(FIXTURE_ROOT, "cmd-policy.py")] })],
    );
    const out = await m.runPreToolUse(payload, shellOpts);
    expect(out.decision).toBe("deny");
    // Only the first (denying) hook ran — the config allow never executed.
    expect(out.results).toHaveLength(1);
    expect(out.results[0].decision).toBe("deny");
  });

  it("matcher filters config entries by tool name", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry(
      [],
      [configEntry({ id: "PreToolUse#0.0", matcher: "mcp__*", command: ["./never-runs.sh"] })],
    );
    // fs_write does not match mcp__* → no matching hooks, allow with no results.
    const out = await m.runPreToolUse(payload);
    expect(out.decision).toBe("allow");
    expect(out.results).toEqual([]);
  });
});

describe("#811 manager — back-compat (no config)", () => {
  it("setTrustedHooks([]) yields zero-hook allow (identical to today)", async () => {
    const m = new ScriptHookManager();
    m.setTrustedHooks([]);
    const out = await m.runPreToolUse(payload);
    expect(out.decision).toBe("allow");
    expect(out.results).toEqual([]);
    expect(m.size()).toBe(0);
  });

  it("setTrustedRegistry(sh, []) behaves exactly like the legacy .sh-only path", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([shHook("pre-deny.sh")], []);
    const out = await m.runPreToolUse(payload, shellOpts);
    expect(out.decision).toBe("deny");
    expect(out.results).toHaveLength(1);
  });
});
