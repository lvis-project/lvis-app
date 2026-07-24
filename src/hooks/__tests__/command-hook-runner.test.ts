/**
 * #811 command-hooks milestone — generalized runner tests.
 *
 * Spec ref: docs/architecture/hook-runtime-expansion-design.md §4 / §6 / §9.
 *
 * Covers the STEP-4 generalization of `runOneHookScript`: an arbitrary
 * local-script `command` argv (python/node/shell) executes through the SAME
 * fail-closed / env-allowlist / timeout machinery as a legacy `.sh` file.
 *
 * These spawn real interpreters; they are skipped when the interpreter is
 * absent so CI without python3/node still passes the rest of the suite.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  runOneHookScript,
  type RunnableHook,
} from "../script-hook-runner.js";
import type { ScriptHookStdin } from "../script-hook-types.js";

const FIXTURE_ROOT = resolve(__dirname, "..", "..", "..", "test", "fixtures", "hooks");

function hasInterpreter(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const HAS_PYTHON = hasInterpreter("python3");
const HAS_NODE = hasInterpreter("node");

function cmdHook(over: Partial<RunnableHook> & Pick<RunnableHook, "command">): RunnableHook {
  return {
    id: "config:PreToolUse#0.0",
    hookType: "pre",
    hookPath: over.command[0],
    ...over,
  };
}

const samplePayload: ScriptHookStdin = {
  hookType: "pre",
  toolName: "fs_write",
  source: "builtin",
  category: "write",
  input: { path: "/tmp/x" },
  sessionId: "sess-1",
  trustOrigin: "user-keyboard",
};

describe("#811 generalized runner — python command hook", () => {
  it.skipIf(!HAS_PYTHON)("runs a python3 <script> command and parses allow", async () => {
    const r = await runOneHookScript(
      cmdHook({ command: ["python3", resolve(FIXTURE_ROOT, "cmd-policy.py")] }),
      samplePayload,
    );
    expect(r.decision).toBe("allow");
    expect(r.reason).toContain("python policy ok");
  });

  it.skipIf(!HAS_PYTHON)("a python command can deny (deny precedence)", async () => {
    const r = await runOneHookScript(
      cmdHook({ command: ["python3", resolve(FIXTURE_ROOT, "cmd-policy.py")] }),
      { ...samplePayload, toolName: "blocked_tool" },
    );
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("blocked_tool");
  });

  it.skipIf(!HAS_PYTHON)("nonzero exit fails closed → deny", async () => {
    const r = await runOneHookScript(
      cmdHook({ command: ["python3", resolve(FIXTURE_ROOT, "cmd-exit-fail.py")] }),
      samplePayload,
    );
    expect(r.decision).toBe("deny");
    expect(r.exitCode).toBe(3);
    expect(r.reason).toMatch(/non-zero/);
  });

  it.skipIf(!HAS_PYTHON)("malformed stdout fails closed → deny", async () => {
    const r = await runOneHookScript(
      cmdHook({ command: ["python3", resolve(FIXTURE_ROOT, "cmd-badjson.py")] }),
      samplePayload,
    );
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/not valid/);
  });

  it.skipIf(!HAS_PYTHON)("timeout fails closed → deny (per-runnable budget)", async () => {
    const r = await runOneHookScript(
      cmdHook({ command: ["python3", resolve(FIXTURE_ROOT, "cmd-slow.py")], timeoutMs: 200 }),
      samplePayload,
    );
    expect(r.decision).toBe("deny");
    expect(r.timedOut).toBe(true);
    expect(r.reason).toMatch(/timed out/);
  });

  it.skipIf(!HAS_PYTHON)("env carries NO secrets — only LVIS_HOOK_* + allowlist", async () => {
    const prev = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      LVIS_SECRET_PROBE: process.env.LVIS_SECRET_PROBE,
    };
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    process.env.GITHUB_TOKEN = "ghp-should-not-leak";
    process.env.LVIS_SECRET_PROBE = "lvis-internal-should-not-leak";
    try {
      const r = await runOneHookScript(
        cmdHook({ command: ["python3", resolve(FIXTURE_ROOT, "cmd-noenv.py")] }),
        samplePayload,
      );
      expect(r.decision).toBe("allow");
      expect(r.reason).toBe("no secret env");
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("#811 generalized runner — node command hook", () => {
  it.skipIf(!HAS_NODE)("runs a node <script> command and round-trips stdin", async () => {
    const r = await runOneHookScript(
      cmdHook({ command: ["node", resolve(FIXTURE_ROOT, "cmd-node.js")] }),
      { ...samplePayload, trustOrigin: "llm-tool-arg" },
    );
    expect(r.decision).toBe("allow");
    // Proves the wire-shape JSON reached the child and parsed.
    expect(r.reason).toContain("origin=llm-tool-arg");
  });
});

describe("#811 generalized runner — spawn error fails closed", () => {
  it("an unresolvable program → deny (spawn error)", async () => {
    const r = await runOneHookScript(
      cmdHook({ command: ["this-binary-does-not-exist-xyz", "./x.py"] }),
      samplePayload,
    );
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/spawn error/);
  });
});

describe("#811 generalized runner — legacy .sh path preserved", () => {
  it("a single .sh argv still runs through the shell (back-compat)", async () => {
    const r = await runOneHookScript(
      cmdHook({ command: [resolve(FIXTURE_ROOT, "pre-allow.sh")], hookType: "pre" }),
      samplePayload,
      process.platform === "win32" ? { timeoutMs: 20_000 } : undefined,
    );
    expect(r.decision).toBe("allow");
    expect(r.reason).toContain("fixture allow");
  });
});
