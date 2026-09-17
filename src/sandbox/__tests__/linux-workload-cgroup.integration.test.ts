import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createLinuxWorkloadCgroup,
  issueLinuxWorkloadCgroupCapability,
  type LinuxWorkloadCgroupHandle,
  type LinuxWorkloadTermination,
} from "../linux-workload-cgroup.js";

const delegatedRoot = process.env.CGROUP_V2_DELEGATED_TEST_ROOT?.trim() ?? "";
const nodeExecutable = process.env.LVIS_TEST_NODE_EXEC_PATH?.trim() ?? "";
const integrationRequested = process.env.CGROUP_V2_INTEGRATION === "1";

async function runWorkload(
  handle: LinuxWorkloadCgroupHandle,
  targetArgv: readonly string[],
  timeoutMs = 20_000,
): Promise<{
  termination: LinuxWorkloadTermination;
  stdout: string;
  stderr: string;
}> {
  const launch = handle.buildTrampolineLaunch(targetArgv);
  const child = spawn(launch.executable, launch.args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: launch.env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });

  return new Promise((resolveResult, rejectResult) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectResult(new Error(`cgroup integration workload exceeded ${timeoutMs} ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectResult(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const termination: LinuxWorkloadTermination = signal === null
        ? { kind: "exited", code: code ?? 1 }
        : { kind: "signaled", signal };
      resolveResult({ termination, stdout, stderr });
    });
  });
}

describe.runIf(integrationRequested)("Linux workload cgroup real integration", () => {
  beforeAll(() => {
    if (process.platform !== "linux") {
      throw new Error("CGROUP_V2_INTEGRATION=1 requires a Linux test host");
    }
    if (!isAbsolute(delegatedRoot)) {
      throw new Error("CGROUP_V2_DELEGATED_TEST_ROOT must be an explicit absolute path");
    }
    if (!isAbsolute(nodeExecutable)) {
      throw new Error("LVIS_TEST_NODE_EXEC_PATH must be an explicit absolute plain-Node path");
    }
  });

  it("attaches before target execution and removes the empty invocation cgroup", async () => {
    const capability = await issueLinuxWorkloadCgroupCapability({
      delegatedRoot,
      generation: `integration-${process.pid}`,
    });
    const handle = await createLinuxWorkloadCgroup({
      capability,
      invocationId: "integration-membership",
      limits: {
        memoryMaxBytes: 256 * 1024 * 1024,
        memorySwapMaxBytes: 0,
        pidsMax: 64,
        cpuMax: { quotaMicros: "max", periodMicros: 100_000 },
      },
    });
    try {
      const result = await runWorkload(handle, [
        nodeExecutable,
        "-e",
        "process.stdout.write(require('node:fs').readFileSync('/proc/self/cgroup','utf8'))",
      ]);
      expect(result.termination).toEqual({ kind: "exited", code: 0 });
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`/${basename(handle.cgroupPath)}`);
      const finalized = await handle.finalize(result.termination);
      expect(finalized.outcome).toEqual({ kind: "exited", code: 0 });
      expect(finalized.cleanup.removed).toBe(true);
    } finally {
      await handle.cleanup();
    }
  });

  it("keeps the controller alive, reports child OOM from counters, and runs a follow-up", async () => {
    const controllerPid = process.pid;
    const capability = await issueLinuxWorkloadCgroupCapability({
      delegatedRoot,
      generation: `integration-oom-${controllerPid}`,
    });
    const oomHandle = await createLinuxWorkloadCgroup({
      capability,
      invocationId: "integration-oom",
      limits: {
        memoryMaxBytes: 64 * 1024 * 1024,
        memorySwapMaxBytes: 0,
        pidsMax: 64,
        cpuMax: { quotaMicros: "max", periodMicros: 100_000 },
      },
    });
    try {
      const result = await runWorkload(oomHandle, [
        nodeExecutable,
        "--max-old-space-size=512",
        "-e",
        [
          "const held=[];",
          "function grow(){ held.push(Buffer.alloc(8*1024*1024, 0x7f)); setImmediate(grow); }",
          "grow();",
        ].join(""),
      ]);
      const finalized = await oomHandle.finalize(result.termination);
      expect(finalized.outcome).toEqual({
        kind: "resource_exhausted",
        resource: "memory",
        observedTermination: result.termination,
      });
      expect(finalized.cleanup.evidence.delta.memoryEvents.oom_kill).not.toBe("0");
      expect(process.pid).toBe(controllerPid);
    } finally {
      await oomHandle.cleanup();
    }

    const followup = await createLinuxWorkloadCgroup({
      capability,
      invocationId: "integration-followup",
      limits: {
        memoryMaxBytes: 256 * 1024 * 1024,
        memorySwapMaxBytes: 0,
        pidsMax: 64,
        cpuMax: { quotaMicros: "max", periodMicros: 100_000 },
      },
    });
    try {
      const result = await runWorkload(followup, [
        nodeExecutable,
        "-e",
        "process.stdout.write('followup-ok')",
      ]);
      expect(result.termination).toEqual({ kind: "exited", code: 0 });
      expect(result.stdout).toBe("followup-ok");
      expect((await followup.finalize(result.termination)).outcome).toEqual({
        kind: "exited",
        code: 0,
      });
    } finally {
      await followup.cleanup();
    }
  }, 30_000);

  it("keeps the controller loop alive when a workload descendant exhausts the subtree", async () => {
    const controllerPid = process.pid;
    const controllerMembership = await readFile("/proc/self/cgroup", "utf8");
    const capability = await issueLinuxWorkloadCgroupCapability({
      delegatedRoot,
      generation: `integration-descendant-oom-${controllerPid}`,
    });
    const oomHandle = await createLinuxWorkloadCgroup({
      capability,
      invocationId: "integration-descendant-oom",
      limits: {
        memoryMaxBytes: 128 * 1024 * 1024,
        memorySwapMaxBytes: 0,
        pidsMax: 64,
        cpuMax: { quotaMicros: "max", periodMicros: 100_000 },
      },
    });
    try {
      const result = await runWorkload(oomHandle, [
        nodeExecutable,
        "-e",
        [
          "const {spawn}=require('node:child_process');",
          "const allocator=spawn(process.execPath,['--max-old-space-size=512','-e',",
          "'const held=[];function grow(){held.push(Buffer.alloc(8*1024*1024,0x7f));setImmediate(grow)}grow()'",
          "],{stdio:'ignore'});",
          "allocator.once('exit',(code,signal)=>process.exit(code??(signal?137:1)));",
          "setInterval(()=>{},1000);",
        ].join(""),
      ]);
      const finalized = await oomHandle.finalize(result.termination);
      expect(finalized.outcome.kind).toBe("resource_exhausted");
      expect(finalized.cleanup.evidence.delta.memoryEvents.oom_kill).not.toBe("0");
      expect(process.pid).toBe(controllerPid);
      expect(await readFile("/proc/self/cgroup", "utf8")).toBe(controllerMembership);
    } finally {
      await oomHandle.cleanup();
    }

    const followup = await createLinuxWorkloadCgroup({
      capability,
      invocationId: "integration-descendant-oom-followup",
      limits: {
        memoryMaxBytes: 256 * 1024 * 1024,
        memorySwapMaxBytes: 0,
        pidsMax: 64,
        cpuMax: { quotaMicros: "max", periodMicros: 100_000 },
      },
    });
    try {
      const result = await runWorkload(followup, [
        nodeExecutable,
        "-e",
        "process.stdout.write('descendant-followup-ok')",
      ]);
      expect(result.termination).toEqual({ kind: "exited", code: 0 });
      expect(result.stdout).toBe("descendant-followup-ok");
      expect((await followup.finalize(result.termination)).outcome).toEqual({
        kind: "exited",
        code: 0,
      });
    } finally {
      await followup.cleanup();
    }
  }, 30_000);

  it("kills a still-populated invocation with cgroup.kill before removal", async () => {
    const capability = await issueLinuxWorkloadCgroupCapability({
      delegatedRoot,
      generation: `integration-forced-cleanup-${process.pid}`,
    });
    const handle = await createLinuxWorkloadCgroup({
      capability,
      invocationId: "integration-forced-cleanup",
      limits: {
        memoryMaxBytes: 256 * 1024 * 1024,
        memorySwapMaxBytes: 0,
        pidsMax: 64,
        cpuMax: { quotaMicros: "max", periodMicros: 100_000 },
      },
    });
    const launch = handle.buildTrampolineLaunch([
      nodeExecutable,
      "-e",
      "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
    ]);
    const child = spawn(launch.executable, launch.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: launch.env,
    });
    const closed = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>(
      (resolveClosed, rejectClosed) => {
        child.once("error", rejectClosed);
        child.once("close", (code, signal) => resolveClosed({ code, signal }));
      },
    );
    try {
      child.stdout.setEncoding("utf8");
      await new Promise<void>((resolveReady, rejectReady) => {
        const timer = setTimeout(() => rejectReady(new Error("forced-cleanup target was not ready")), 10_000);
        child.stdout.once("data", (chunk: string) => {
          clearTimeout(timer);
          if (chunk.includes("ready")) resolveReady();
          else rejectReady(new Error(`unexpected target output: ${chunk}`));
        });
      });
      const cleanup = await handle.cleanup();
      expect(cleanup.killMethod).toBe("cgroup.kill");
      expect(cleanup.removed).toBe(true);
      expect((await closed).signal).toBe("SIGKILL");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await handle.cleanup();
    }
  }, 20_000);
});
