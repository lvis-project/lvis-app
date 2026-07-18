import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: childProcessMock.spawn,
    execFileSync: childProcessMock.execFileSync,
  };
});

import { BashTool } from "../bash.js";
import { PowerShellTool } from "../powershell.js";
import type { ToolExecutionContext } from "../types.js";
import {
  ApprovalGate,
  type ApprovalRequest,
} from "../../permissions/approval-gate.js";
import {
  buildHostShellExecutionPermitBinding,
  mintHostShellExecutionPermit,
  type HostShellToolName,
} from "../../permissions/host-shell-execution-permit.js";
import {
  getHostShellExecutionPlanAuditProjection,
  type HostShellExecutionPlan,
} from "../../permissions/host-shell-execution-plan.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxRequestedAtBootForTest,
  getHostShellExecutionPlan,
  isIssuedHostShellExecutionPlan,
  setActiveSandboxCapability,
  setSandboxRequestedAtBoot,
} from "../../permissions/sandbox-capability.js";
import { __resetShellResolverCache } from "../../lib/shell-resolver.js";
import { setProcessPlatform } from "../../testing/process-platform.js";

const ORIGINAL_PLATFORM = process.platform;
const CHILD_OUTPUT = "native Windows Plan-B child output";

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  exitCode: number | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(parser: boolean): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });

  queueMicrotask(() => {
    const output = parser
      ? JSON.stringify({
          errors: [],
          commands: [
            {
              name: "Write-Output",
              elements: ["Write-Output", "native-plan-b"],
              text: "Write-Output native-plan-b",
            },
          ],
        })
      : `${CHILD_OUTPUT}\n`;
    child.stdout.end(output);
    child.stderr.end();
    child.exitCode = 0;
    child.emit("close", 0);
  });
  return child;
}

function issueWindowsPlanB(): HostShellExecutionPlan {
  setProcessPlatform("win32");
  setActiveSandboxCapability({
    kind: "asrt",
    confidence: "verified",
    platform: "win32",
    reason: "srt-win partial",
    confines: { filesystem: true, process: false, network: true },
  });
  setSandboxRequestedAtBoot(true);
  return getHostShellExecutionPlan();
}

function issueRequestedUnavailable(platform: "darwin" | "linux" | "win32"): HostShellExecutionPlan {
  setProcessPlatform(platform);
  __resetActiveSandboxCapabilityForTest();
  setSandboxRequestedAtBoot(true);
  return getHostShellExecutionPlan();
}
let approvalSequence = 0;

async function mintOneShotPermit(input: {
  plan: HostShellExecutionPlan;
  toolName: HostShellToolName;
  toolUseId: string;
  rawInput: unknown;
  context: Pick<ToolExecutionContext, "cwd" | "extraAllowedDirectories">;
}) {
  const binding = buildHostShellExecutionPermitBinding({
    plan: input.plan,
    toolName: input.toolName,
    toolUseId: input.toolUseId,
    rawInput: input.rawInput,
    executionCwd: input.context.cwd,
    extraAllowedDirectories: input.context.extraAllowedDirectories,
  });
  if (binding === undefined) {
    throw new Error("test input did not produce a host-shell permit binding");
  }

  const webContents = { isDestroyed: vi.fn(() => false), send: vi.fn() };
  const gate = new ApprovalGate(webContents as never);
  const id = `native-plan-b-${++approvalSequence}`;
  const pending = gate.requestAndWait({
    id,
    category: "tool",
    toolCategory: "shell",
    toolName: input.toolName,
    args: input.rawInput,
    reason: "Windows partial shell requires an explicit one-shot approval",
    source: "builtin",
    createdAt: Date.now(),
    allowedChoices: ["allow-once", "deny-once"],
    forceExplicit: true,
    hostShellExecutionPermitBinding: binding,
  });
  const request = webContents.send.mock.calls[0]?.[1] as ApprovalRequest | undefined;
  if (request?.nonce === undefined || request.hmac === undefined) {
    throw new Error("ApprovalGate did not issue an HMAC-sealed approval request");
  }
  gate.resolve(id, {
    requestId: id,
    choice: "allow-once",
    nonce: request.nonce,
    hmac: request.hmac,
  });
  const decision = await pending;
  const permit = mintHostShellExecutionPermit({
    plan: input.plan,
    approvalDecision: decision,
    binding,
  });
  if (permit === undefined) {
    throw new Error("ApprovalGate allow-once did not mint a Plan-B permit");
  }
  return permit;
}

const SHELLS = [
  {
    label: "BashTool",
    toolName: "bash" as const,
    create: () => new BashTool(),
    input: { command: "echo native-plan-b", timeoutSeconds: 7 },
    expectedSpawnCount: 1,
  },
  {
    label: "PowerShellTool",
    toolName: "powershell" as const,
    create: () => new PowerShellTool(),
    input: { command: "Write-Output native-plan-b", timeoutSeconds: 7 },
    // One parser child validates the AST, then the approved plain child runs.
    expectedSpawnCount: 2,
  },
] as const;

describe("builtin shell - Windows partial Plan-B native execution", () => {
  beforeEach(() => {
    __resetShellResolverCache();
    childProcessMock.spawn.mockReset();
    childProcessMock.execFileSync.mockReset();
    // Bash resolves a POSIX shell by probing it synchronously on Windows.
    // Keep that probe fully mocked too: no real host child is started.
    childProcessMock.execFileSync.mockReturnValue("__lvis_shell_ok__");
    childProcessMock.spawn.mockImplementation(
      (
        _command: string,
        _args: readonly string[],
        options?: { stdio?: unknown },
      ) => {
        const parser = Array.isArray(options?.stdio) && options.stdio[0] === "pipe";
        return fakeChild(parser);
      },
    );
  });

  afterEach(() => {
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
    __resetShellResolverCache();
    setProcessPlatform(ORIGINAL_PLATFORM);
    childProcessMock.spawn.mockReset();
    childProcessMock.execFileSync.mockReset();
  });

  it.each(SHELLS)(
    "runs an HMAC-approved one-shot plain child for $label",
    async ({ toolName, create, input, expectedSpawnCount }) => {
      const plan = issueWindowsPlanB();
      expect(plan.platform).toBe("win32");
      expect(isIssuedHostShellExecutionPlan(plan)).toBe(true);

      const toolUseId = `${toolName}-native-plan-b`;
      const baseContext = {
        cwd: process.cwd(),
        extraAllowedDirectories: [] as const,
      };
      const permit = await mintOneShotPermit({
        plan,
        toolName,
        toolUseId,
        rawInput: input,
        context: baseContext,
      });
      const context: ToolExecutionContext = {
        ...baseContext,
        hostShellExecutionPlan: plan,
        hostShellExecutionPermit: permit,
        metadata: { toolUseId },
      };

      const first = await create().execute(input, context);

      expect(first).toMatchObject({
        output: CHILD_OUTPUT,
        isError: false,
        metadata: {
          returncode: 0,
          sandboxed: false,
          isolation: "none",
        },
      });
      expect(first.metadata?.sandboxExecutionPlan).toBe(
        getHostShellExecutionPlanAuditProjection(plan),
      );
      expect(childProcessMock.spawn).toHaveBeenCalledTimes(expectedSpawnCount);

      const nativeCall = childProcessMock.spawn.mock.calls.find((call) => {
        const options = call[2] as { stdio?: unknown } | undefined;
        return Array.isArray(options?.stdio) && options.stdio[0] === "ignore";
      });
      if (nativeCall === undefined) throw new Error("native child spawn was not observed");
      const nativeArgs = nativeCall[1] as readonly string[];
      const nativeOptions = nativeCall[2] as {
        cwd?: string;
        shell?: boolean;
        stdio?: unknown;
      };
      expect(nativeArgs).toContain(input.command);
      expect(nativeOptions).toMatchObject({
        cwd: baseContext.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      // The same opaque permit is irreversibly consumed before the first spawn.
      const spawnCountAfterFirst = childProcessMock.spawn.mock.calls.length;
      const replay = await create().execute(input, context);
      expect(replay).toMatchObject({
        isError: true,
        metadata: { sandboxed: false, isolation: "none" },
      });
      expect(replay.output).toContain("one-shot host approval permit");
      expect(childProcessMock.spawn).toHaveBeenCalledTimes(spawnCountAfterFirst);
    },
  );
});


describe.each(["darwin", "linux", "win32"] as const)(
  "builtin shell - requested-unavailable %s native execution",
  (platform) => {
    beforeEach(() => {
      __resetShellResolverCache();
      childProcessMock.spawn.mockReset();
      childProcessMock.execFileSync.mockReset();
      childProcessMock.execFileSync.mockReturnValue("__lvis_shell_ok__");
      childProcessMock.spawn.mockImplementation(
        (
          _command: string,
          _args: readonly string[],
          options?: { stdio?: unknown },
        ) => {
          const parser = Array.isArray(options?.stdio) && options.stdio[0] === "pipe";
          return fakeChild(parser);
        },
      );
    });

    afterEach(() => {
      __resetActiveSandboxCapabilityForTest();
      __resetSandboxRequestedAtBootForTest();
      __resetShellResolverCache();
      setProcessPlatform(ORIGINAL_PLATFORM);
      childProcessMock.spawn.mockReset();
      childProcessMock.execFileSync.mockReset();
    });

    it.each(SHELLS)(
      "runs $label once with a generic permit and rejects its replay",
      async ({ toolName, create, input, expectedSpawnCount }) => {
        const plan = issueRequestedUnavailable(platform);
        expect(plan).toMatchObject({
          platform,
          requestedSandbox: true,
          mode: "plain",
          fallbackReason: "requested-sandbox-unavailable",
          requiresExplicitUserApproval: true,
        });
        const toolUseId = `${toolName}-requested-unavailable-${platform}`;
        const baseContext = {
          cwd: process.cwd(),
          extraAllowedDirectories: [] as const,
        };
        const permit = await mintOneShotPermit({
          plan,
          toolName,
          toolUseId,
          rawInput: input,
          context: baseContext,
        });
        const context: ToolExecutionContext = {
          ...baseContext,
          hostShellExecutionPlan: plan,
          hostShellExecutionPermit: permit,
          metadata: { toolUseId },
        };

        const first = await create().execute(input, context);
        expect(first).toMatchObject({
          output: CHILD_OUTPUT,
          isError: false,
          metadata: { sandboxed: false, isolation: "none" },
        });
        expect(childProcessMock.spawn).toHaveBeenCalledTimes(expectedSpawnCount);

        const spawnCountAfterFirst = childProcessMock.spawn.mock.calls.length;
        const replay = await create().execute(input, context);
        expect(replay).toMatchObject({
          isError: true,
          metadata: { sandboxed: false, isolation: "none" },
        });
        expect(replay.output).toContain("one-shot host approval permit");
        expect(childProcessMock.spawn).toHaveBeenCalledTimes(spawnCountAfterFirst);
      },
    );
  },
);