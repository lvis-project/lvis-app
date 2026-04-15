/**
 * Boot hooks wiring test — Tier A4 (W3).
 *
 * Verifies the §4.2 boot pathway that attaches an
 * {@link ExternalHookExecutor} to a {@link HookRunner} so that every
 * preToolUse / postToolUse event (from `~/.lvis/hooks.json` + admin-dir
 * `hooks.json`) fires inside the ToolExecutor's 8-step pipeline.
 *
 * This test mocks {@link loadHooksConfig} to return a single
 * {@link CommandHookDefinition}, constructs the same HookRunner +
 * ExternalHookExecutor pair that boot.ts builds, then drives
 * `runPreHooks()` through a mocked {@link ExternalHookExecutor.run} to
 * confirm:
 *   1. `setExternalExecutor` is honoured by the runner.
 *   2. `runPreHooks` delegates to the executor on tool-use events.
 *   3. A blocking external hook flips the pre-hook result to `deny`.
 *
 * No filesystem, no spawn, no electron.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock loadHooksConfig ─────────────────────────────

const mockLoadHooksConfig = vi.fn();
vi.mock("../hooks/config-loader.js", () => ({
  loadHooksConfig: () => mockLoadHooksConfig(),
}));

// ─── Mock ExternalHookExecutor ────────────────────────

const mockRun = vi.fn();
vi.mock("../hooks/external-executor.js", () => ({
  ExternalHookExecutor: vi.fn().mockImplementation(() => ({
    run: mockRun,
  })),
}));

// ─── Imports under test (after vi.mock) ───────────────

import { HookRunner } from "../hooks/hook-runner.js";
import { loadHooksConfig } from "../hooks/config-loader.js";
import { ExternalHookExecutor } from "../hooks/external-executor.js";

// ─── Tests ────────────────────────────────────────────

describe("boot — ExternalHookExecutor wiring (W3)", () => {
  beforeEach(() => {
    mockLoadHooksConfig.mockReset();
    mockRun.mockReset();
    (ExternalHookExecutor as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  it("attaches an ExternalHookExecutor built from loadHooksConfig() to a fresh HookRunner", async () => {
    // Fixture: one command hook that matches bash.
    mockLoadHooksConfig.mockReturnValue({
      preToolUse: [
        {
          type: "command" as const,
          command: "echo preToolUse",
          timeoutSeconds: 5,
          matcher: "bash",
          blockOnFailure: false,
        },
      ],
      postToolUse: [],
    });

    // Executor's run() returns a benign allow result.
    mockRun.mockResolvedValue({ blocked: false, results: [], reason: "" });

    // Replay the boot wiring:
    //   1. loadHooksConfig()
    //   2. new ExternalHookExecutor(cfg, cwd)
    //   3. hookRunner.setExternalExecutor(exec)
    const cfg = loadHooksConfig();
    const exec = new ExternalHookExecutor(cfg, process.cwd());
    const runner = new HookRunner();
    runner.setExternalExecutor(exec);

    expect(mockLoadHooksConfig).toHaveBeenCalledTimes(1);
    expect(ExternalHookExecutor).toHaveBeenCalledTimes(1);

    // Drive runPreHooks through the plumbed executor.
    const result = await runner.runPreHooks({
      toolName: "bash",
      toolInput: { command: "ls" },
    });

    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun).toHaveBeenCalledWith(
      "preToolUse",
      "bash",
      expect.objectContaining({ command: "ls" }),
    );
    expect(result.action).toBe("allow");
  });

  it("blocked external hook flips the pre-hook result to deny", async () => {
    mockLoadHooksConfig.mockReturnValue({
      preToolUse: [
        {
          type: "command" as const,
          command: "exit 1",
          timeoutSeconds: 5,
          blockOnFailure: true,
        },
      ],
      postToolUse: [],
    });

    mockRun.mockResolvedValue({
      blocked: true,
      results: [
        {
          hookType: "command",
          success: false,
          blocked: true,
          reason: "command hook exit 1",
        },
      ],
      reason: "command hook exit 1",
    });

    const cfg = loadHooksConfig();
    const exec = new ExternalHookExecutor(cfg, process.cwd());
    const runner = new HookRunner();
    runner.setExternalExecutor(exec);

    const result = await runner.runPreHooks({
      toolName: "bash",
      toolInput: { command: "rm -rf /" },
    });

    expect(result.action).toBe("deny");
    expect(result.reason).toContain("command hook exit 1");
  });

  it("postToolUse events also route through the external executor", async () => {
    mockLoadHooksConfig.mockReturnValue({
      preToolUse: [],
      postToolUse: [
        {
          type: "command" as const,
          command: "echo done",
          timeoutSeconds: 5,
          blockOnFailure: false,
        },
      ],
    });
    mockRun.mockResolvedValue({
      blocked: false,
      results: [{ hookType: "command", success: true, output: "done" }],
      reason: "",
    });

    const runner = new HookRunner();
    runner.setExternalExecutor(
      new ExternalHookExecutor(loadHooksConfig(), process.cwd()),
    );

    const feedback = await runner.runPostHooks({
      toolName: "bash",
      toolInput: { command: "ls" },
      toolOutput: "a\nb\n",
      isError: false,
    });

    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun).toHaveBeenCalledWith(
      "postToolUse",
      "bash",
      expect.objectContaining({ toolOutput: "a\nb\n", isError: false }),
    );
    expect(feedback).toContain("done");
  });
});
