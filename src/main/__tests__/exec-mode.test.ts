/**
 * Headless one-shot CLI: flag parsing, the stdout contract, the auto-deny
 * approval policy, and the exit-code mapping.
 *
 * The turn tests drive the REAL `runStreamedTurn` over a stub ConversationLoop
 * rather than a second event mapping, because the property under test is that
 * the events a benchmark reads on stdout are the events the host produced.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  EXEC_USAGE_EXIT_CODE,
  execModeRequested,
  execTurnRequested,
  parseExecFlags,
  runExecTurn,
  type ExecDeps,
  type ExecRequest,
} from "../exec-mode.js";
import {
  SecretDocumentValidationError,
  SecretEncryptionUnavailableError,
} from "../../data/secret-document-store.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { ApprovalGate } from "../../permissions/approval-gate.js";
import type { PermissionManager } from "../../permissions/permission-manager.js";
import type { SettingsService } from "../../data/settings-store.js";
import type { ConversationLoop, TurnResult } from "../../engine/conversation-loop.js";

const COMPLETED_TURN: TurnResult = {
  text: "done",
  toolCalls: [],
  route: "default",
  stopReason: "end_turn",
};

function collectingStream() {
  const chunks: string[] = [];
  const stream = {
    write(chunk: string): boolean {
      chunks.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return {
    stream,
    text: () => chunks.join(""),
    lines: () => chunks.join("").split("\n").filter((line) => line.length > 0),
  };
}

function makeDeps(overrides: {
  turnResult?: TurnResult;
  runTurn?: () => Promise<TurnResult>;
  approvalGate?: ApprovalGate | undefined;
  permissionManager?: PermissionManager | undefined;
  setSecret?: (key: string, value: string) => Promise<void>;
  stdin?: string;
  isAuthorizedProjectRoot?: (projectRoot: string) => boolean;
} = {}) {
  const turnImpl = overrides.runTurn ?? (async () => overrides.turnResult ?? COMPLETED_TURN);
  const runTurn = vi.fn(async (..._args: unknown[]) => turnImpl());
  const newConversation = vi.fn();
  const conversationLoop = { runTurn, newConversation } as unknown as ConversationLoop;

  const setMode = vi.fn();
  const permissionManager = "permissionManager" in overrides
    ? overrides.permissionManager
    : ({ setMode } as unknown as PermissionManager);

  const stdout = collectingStream();
  const stderr = collectingStream();
  const approvalGate = "approvalGate" in overrides
    ? overrides.approvalGate
    : new ApprovalGate(null, undefined, undefined, undefined, undefined, undefined, {
      onDenied: (requestId, toolName) => {
        stderr.stream.write(`exec: auto-denied approval ${requestId} tool=${toolName}\n`);
      },
    });

  const setSecret = vi.fn(overrides.setSecret ?? (async () => undefined));
  const settingsService = { setSecret } as unknown as SettingsService;

  const deps: ExecDeps = {
    conversationLoop,
    permissionManager,
    approvalGate,
    settingsService,
    stdout: stdout.stream,
    stderr: stderr.stream,
    readStdin: async () => overrides.stdin ?? "",
    isAuthorizedProjectRoot: overrides.isAuthorizedProjectRoot ?? (() => true),
  };
  return {
    deps,
    stdout,
    stderr,
    runTurn,
    newConversation,
    setMode,
    setSecret,
  };
}

function turnRequest(overrides: Partial<NonNullable<ExecRequest["turn"]>> = {}): ExecRequest {
  return {
    secret: null,
    turn: {
      prompt: "hello",
      cwd: process.cwd(),
      approveMode: "default",
      output: "stream-json",
      ...overrides,
    },
  };
}

function expectRequest(parsed: ReturnType<typeof parseExecFlags>): ExecRequest {
  expect(parsed).not.toBeNull();
  expect(parsed).not.toHaveProperty("error");
  return parsed as ExecRequest;
}

describe("execModeRequested", () => {
  it.each([
    ["--exec"],
    ["--exec=say hi"],
    ["--exec=-"],
    ["--set-secret"],
    ["--set-secret=llm.apiKey.claude"],
  ])("is true for %s", (flag) => {
    expect(execModeRequested(["electron", "main.js", flag])).toBe(true);
  });

  it.each([
    ["--exec-cwd=/tmp"],
    ["--exec-output=json"],
    ["--plugin-smoke=meeting"],
    ["--executable"],
  ])("is false for %s alone", (flag) => {
    expect(execModeRequested(["electron", "main.js", flag])).toBe(false);
  });
});

describe("execTurnRequested", () => {
  it.each([["--exec"], ["--exec=say hi"], ["--exec=-"]])(
    "is true for %s",
    (flag) => {
      expect(execTurnRequested(["electron", "main.js", flag])).toBe(true);
    },
  );

  it.each([
    ["--set-secret"],
    ["--set-secret=llm.apiKey.claude"],
    ["--exec-cwd=/tmp"],
    ["--executable"],
  ])("is false for %s alone", (flag) => {
    // The secret writer is headless but runs no model and builds no prompt, so
    // it is not a turn — the two questions have to stay separable.
    expect(execTurnRequested(["electron", "main.js", flag])).toBe(false);
  });
});

const LAUNCH_CWD = "/launched/from/here";

describe("parseExecFlags", () => {
  it("returns null for an ordinary launch", () => {
    expect(parseExecFlags(["electron", "main.js"], LAUNCH_CWD)).toBeNull();
  });

  it("reads an inline prompt and roots the session where the process was launched", () => {
    const request = expectRequest(parseExecFlags(["--exec=count to three"], LAUNCH_CWD));
    expect(request.secret).toBeNull();
    expect(request.turn).toEqual({
      prompt: "count to three",
      cwd: LAUNCH_CWD,
      approveMode: "default",
      output: "stream-json",
    });
  });

  it.each([["--exec"], ["--exec=-"]])("defers the prompt to stdin for %s", (flag) => {
    expect(expectRequest(parseExecFlags([flag], LAUNCH_CWD)).turn?.prompt).toBeNull();
  });

  it("accepts every modifier", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exec-cwd-"));
    try {
      const request = expectRequest(parseExecFlags([
        "--exec=hi",
        `--exec-cwd=${dir}`,
        "--exec-approve=allow",
        "--exec-output=json",
        "--exec-max-rounds=4",
      ], LAUNCH_CWD));
      expect(request.turn).toEqual({
        prompt: "hi",
        cwd: dir,
        approveMode: "allow",
        output: "json",
        maxRounds: 4,
      });
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("resolves a relative --exec-cwd against the launch directory, not the process cwd", async () => {
    const launch = mkdtempSync(join(tmpdir(), "exec-launch-"));
    const sub = join(launch, "project");
    mkdirSync(sub);
    try {
      const request = expectRequest(parseExecFlags(["--exec=hi", "--exec-cwd=project"], launch));
      expect(request.turn?.cwd).toBe(sub);
      expect(parseExecFlags(["--exec=hi", "--exec-cwd=project"], process.cwd()))
        .toEqual({ error: expect.stringContaining("does not exist") });
    } finally {
      await cleanupTmpDir(launch);
    }
  });

  it("refuses a turn whose launch directory was never captured", () => {
    expect(parseExecFlags(["--exec=hi"], null))
      .toEqual({ error: expect.stringContaining("launch directory") });
    expect(parseExecFlags(["--exec=hi", "--exec-cwd=/tmp"], null))
      .toEqual({ error: expect.stringContaining("needs --exec") });
  });

  it("reads a secret key without a turn", () => {
    const request = expectRequest(parseExecFlags(["--set-secret=llm.apiKey.claude"], LAUNCH_CWD));
    expect(request).toEqual({ secret: { key: "llm.apiKey.claude" }, turn: null });
  });

  it("rejects a cwd that is a file rather than a directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exec-cwd-"));
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "x");
    try {
      expect(parseExecFlags(["--exec=hi", `--exec-cwd=${file}`], LAUNCH_CWD))
        .toEqual({ error: expect.stringContaining("not a directory") });
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it.each([
    [["--exec=hi", "--exec-cwd=/definitely/not/here"], "does not exist"],
    [["--exec=hi", "--exec-approve=auto"], "--exec-approve"],
    [["--exec=hi", "--exec-output=yaml"], "--exec-output"],
    [["--exec=hi", "--exec-max-rounds=0"], "--exec-max-rounds"],
    [["--exec=hi", "--exec-max-rounds=two"], "--exec-max-rounds"],
    [["--exec=hi", "--exec-quiet"], "unknown flag"],
    [["--exec="], "empty prompt"],
    [["--set-secret"], "needs a key"],
    [["--set-secret="], "empty key"],
    [["--exec", "--set-secret=k"], "consumes stdin"],
  ])("rejects %j", (argv, fragment) => {
    expect(parseExecFlags(argv, LAUNCH_CWD)).toEqual({ error: expect.stringContaining(fragment) });
  });

  it("allows a secret beside an inline prompt", () => {
    const request = expectRequest(parseExecFlags(["--exec=hi", "--set-secret=k"], LAUNCH_CWD));
    expect(request.secret).toEqual({ key: "k" });
    expect(request.turn?.prompt).toBe("hi");
  });
});

describe("runExecTurn — stream-json output", () => {
  it("writes one JSON event per line and nothing else on stdout", async () => {
    const harness = makeDeps();
    const code = await runExecTurn(harness.deps, turnRequest());

    expect(code).toBe(0);
    const text = harness.stdout.text();
    expect(text.endsWith("\n")).toBe(true);
    const events = harness.stdout.lines().map((line) => JSON.parse(line) as { kind: string });
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((event) => event.kind)).toContain("turn.started");
    expect(events.at(-1)?.kind).toBe("turn.completed");
    expect(text).toBe(events.map((event) => `${JSON.stringify(event)}\n`).join(""));
  });

  it("refuses a project root the workspace has not authorized instead of re-rooting it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exec-project-"));
    try {
      const harness = makeDeps({ isAuthorizedProjectRoot: () => false });
      const code = await runExecTurn(harness.deps, turnRequest({ cwd: dir }));
      expect(code).toBe(64);
      expect(harness.newConversation).not.toHaveBeenCalled();
      expect(harness.runTurn).not.toHaveBeenCalled();
      expect(harness.stderr.text()).toContain("not an authorized workspace project");
      expect(harness.stderr.text()).toContain(dir);
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("opens the session on the requested project root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exec-project-"));
    try {
      const harness = makeDeps();
      await runExecTurn(harness.deps, turnRequest({ cwd: dir }));
      expect(harness.newConversation).toHaveBeenCalledWith("main", {
        projectRoot: dir,
        projectName: basename(dir),
      });
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("threads the round budget into the turn options", async () => {
    const harness = makeDeps();
    await runExecTurn(harness.deps, turnRequest({ maxRounds: 3 }));
    const options = harness.runTurn.mock.calls[0]![3] as { maxRounds?: number };
    expect(options.maxRounds).toBe(3);
  });

  it("reads the prompt from stdin when none was given inline", async () => {
    const harness = makeDeps({ stdin: "prompt from stdin\n" });
    await runExecTurn(harness.deps, turnRequest({ prompt: null }));
    expect(harness.runTurn.mock.calls[0]![0]).toBe("prompt from stdin");
  });

  it("refuses an empty prompt", async () => {
    const harness = makeDeps({ stdin: "   \n" });
    const code = await runExecTurn(harness.deps, turnRequest({ prompt: null }));
    expect(code).toBe(EXEC_USAGE_EXIT_CODE);
    expect(harness.runTurn).not.toHaveBeenCalled();
    expect(harness.stderr.text()).toContain("empty prompt");
  });
});

describe("runExecTurn — json output", () => {
  it("writes exactly one line carrying the turn result", async () => {
    const harness = makeDeps();
    const code = await runExecTurn(harness.deps, turnRequest({ output: "json" }));

    expect(code).toBe(0);
    const lines = harness.stdout.lines();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(COMPLETED_TURN);
  });
});

describe("runExecTurn — permission mode", () => {
  it("switches the permission manager to allow only when asked", async () => {
    const allowed = makeDeps();
    await runExecTurn(allowed.deps, turnRequest({ approveMode: "allow" }));
    expect(allowed.setMode).toHaveBeenCalledWith("allow");
    expect(allowed.setMode).toHaveBeenCalledTimes(1);

    const byDefault = makeDeps();
    await runExecTurn(byDefault.deps, turnRequest());
    expect(byDefault.setMode).not.toHaveBeenCalled();
  });

  it("refuses to run a turn when boot produced no approval gate", async () => {
    const harness = makeDeps({ approvalGate: undefined });
    const code = await runExecTurn(harness.deps, turnRequest());
    expect(code).toBe(1);
    expect(harness.runTurn).not.toHaveBeenCalled();
    expect(harness.stderr.text()).toContain("approval gate");
  });
});

describe("runExecTurn — headless approvals", () => {
  it("uses the headless gate to deny requests and note them on stderr", async () => {
    const harness = makeDeps({
      runTurn: async () => {
        const decision = await harness.deps.approvalGate!.requestAndWait({
          id: "req-1",
          toolName: "bash",
          category: "tool",
          toolCategory: "shell",
          args: { command: "echo hello" },
          reason: "Approval required",
          createdAt: Date.now(),
        });
        expect(decision.choice).toBe("deny-once");
        return COMPLETED_TURN;
      },
    });

    await runExecTurn(harness.deps, turnRequest());

    expect(harness.stderr.text()).toContain("auto-denied approval req-1 tool=bash");
    expect(harness.stdout.text()).not.toContain("auto-denied");
  });

  it("rejects a gate that was not constructed for headless execution", async () => {
    const harness = makeDeps({ approvalGate: new ApprovalGate(null) });
    expect(await runExecTurn(harness.deps, turnRequest())).toBe(1);
    expect(harness.runTurn).not.toHaveBeenCalled();
    expect(harness.stderr.text()).toContain("not configured for headless execution");
  });
});

describe("runExecTurn — exit codes", () => {
  it("returns 0 for a completed turn", async () => {
    const harness = makeDeps();
    expect(await runExecTurn(harness.deps, turnRequest())).toBe(0);
  });

  it.each([["context-error"], ["stream-error"], ["blocked"]] as const)(
    "returns 1 for a turn that stopped with %s",
    async (stopReason) => {
      const harness = makeDeps({ turnResult: { ...COMPLETED_TURN, stopReason } });
      expect(await runExecTurn(harness.deps, turnRequest())).toBe(1);
    },
  );

  it("returns 1 when the turn throws, and says so on stderr", async () => {
    const harness = makeDeps({
      runTurn: async () => {
        throw new Error("provider unreachable");
      },
    });
    expect(await runExecTurn(harness.deps, turnRequest())).toBe(1);
    expect(harness.stderr.text()).toContain("provider unreachable");
  });

  it("returns 2 when the turn ended asking for input", async () => {
    const harness = makeDeps({
      turnResult: {
        ...COMPLETED_TURN,
        stopReason: "input-required",
        inputRequired: { reason: "question", prompt: "which file?" },
      },
    });
    expect(await runExecTurn(harness.deps, turnRequest())).toBe(2);
  });
});

describe("runExecTurn — --set-secret", () => {
  const secretRequest: ExecRequest = { secret: { key: "llm.apiKey.claude" }, turn: null };

  it("writes the stdin value through the settings service", async () => {
    const harness = makeDeps({ stdin: "sk-value\n" });
    expect(await runExecTurn(harness.deps, secretRequest)).toBe(0);
    expect(harness.setSecret).toHaveBeenCalledWith("llm.apiKey.claude", "sk-value");
    expect(harness.stdout.text()).toBe("");
  });

  it("refuses an empty value", async () => {
    const harness = makeDeps({ stdin: "\n" });
    expect(await runExecTurn(harness.deps, secretRequest)).toBe(EXEC_USAGE_EXIT_CODE);
    expect(harness.setSecret).not.toHaveBeenCalled();
    expect(harness.stderr.text()).toContain("empty value");
  });

  it("reports an invalid key as a usage error", async () => {
    const harness = makeDeps({
      stdin: "sk-value",
      setSecret: async () => {
        throw new SecretDocumentValidationError("Secret document contains an invalid key");
      },
    });
    expect(await runExecTurn(harness.deps, secretRequest)).toBe(EXEC_USAGE_EXIT_CODE);
    expect(harness.stderr.text()).toContain("rejected the key");
  });

  it("reports unusable encryption as a run failure naming the keyring", async () => {
    const harness = makeDeps({
      stdin: "sk-value",
      setSecret: async () => {
        throw new SecretEncryptionUnavailableError();
      },
    });
    expect(await runExecTurn(harness.deps, secretRequest)).toBe(1);
    expect(harness.stderr.text()).toContain("OS keyring");
  });

  it("applies the secret before running a combined turn", async () => {
    const order: string[] = [];
    const harness = makeDeps({
      stdin: "sk-value",
      setSecret: async () => {
        order.push("secret");
      },
      runTurn: async () => {
        order.push("turn");
        return COMPLETED_TURN;
      },
    });
    const code = await runExecTurn(harness.deps, {
      secret: { key: "llm.apiKey.claude" },
      turn: turnRequest().turn,
    });
    expect(code).toBe(0);
    expect(order).toEqual(["secret", "turn"]);
  });

  it("does not run the turn when the secret could not be stored", async () => {
    const harness = makeDeps({
      stdin: "sk-value",
      setSecret: async () => {
        throw new SecretEncryptionUnavailableError();
      },
    });
    const code = await runExecTurn(harness.deps, {
      secret: { key: "llm.apiKey.claude" },
      turn: turnRequest().turn,
    });
    expect(code).toBe(1);
    expect(harness.runTurn).not.toHaveBeenCalled();
  });
});
