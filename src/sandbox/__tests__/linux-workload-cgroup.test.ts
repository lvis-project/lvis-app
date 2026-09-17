import { spawnSync } from "node:child_process";
import {
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { posix as pathPosix } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LINUX_CGROUP_ARGV_TRAMPOLINE,
  classifyLinuxWorkloadOutcome,
  createLinuxWorkloadCgroup,
  isIssuedLinuxWorkloadCgroupCapability,
  issueLinuxWorkloadCgroupCapability,
  type LinuxCgroupMetricDelta,
  type LinuxWorkloadCgroupCapability,
  type LinuxWorkloadCgroupDependencies,
  type LinuxWorkloadCgroupFs,
} from "../linux-workload-cgroup.js";

const { join } = pathPosix;

const MOUNT = "/sys/fs/cgroup";
const ROOT = `${MOUNT}/lvis/workloads`;
const CONTROLLER = `${MOUNT}/lvis/controller`;
const LIMITS = Object.freeze({
  memoryMaxBytes: 268_435_456,
  pidsMax: 64,
  cpuMax: Object.freeze({ quotaMicros: 50_000, periodMicros: 100_000 }),
});

class FakeCgroupHost {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>([ROOT, CONTROLLER]);
  readonly writes: Array<readonly [string, string]> = [];
  readonly accesses: Array<readonly [string, number]> = [];
  readonly removed: string[] = [];
  readonly collisions = new Set<string>();
  readonly deniedAccess = new Set<string>();
  readonly uuids = ["uuid-1", "uuid-2", "uuid-3", "uuid-4"];
  platform: NodeJS.Platform = "linux";
  currentCgroup = "/lvis/controller";
  nowMs = 0;
  supportsCgroupKill = true;
  denyCgroupKillWrite = false;
  supportsMemoryPeak = true;
  supportsOomGroup = true;
  rootIno = 99;
  failNextRmdir: Error | undefined;
  repopulateOnNextRmdir = false;

  constructor() {
    this.files.set(join(ROOT, "cgroup.controllers"), "cpu io memory pids\n");
    this.files.set(join(ROOT, "cgroup.subtree_control"), "cpu memory pids\n");
    this.files.set(join(ROOT, "cgroup.procs"), "");
    this.files.set(join(ROOT, "cgroup.events"), "populated 0\nfrozen 0\n");
    this.files.set(join(ROOT, "cgroup.stat"), "nr_descendants 0\nnr_dying_descendants 0\n");
    this.files.set(join(ROOT, "cgroup.type"), "domain\n");
  }

  static error(code: string, message = code): Error & { code: string } {
    return Object.assign(new Error(message), { code });
  }

  readonly fs: LinuxWorkloadCgroupFs = {
    realpath: async (path) => {
      if (!this.directories.has(path)) throw FakeCgroupHost.error("ENOENT");
      return path;
    },
    readFile: async (path) => {
      if (!this.files.has(path)) throw FakeCgroupHost.error("ENOENT");
      return this.files.get(path)!;
    },
    writeFile: async (path, data) => {
      if (path.endsWith("/cgroup.kill")) {
        if (!this.supportsCgroupKill) throw FakeCgroupHost.error("ENOENT");
        if (this.denyCgroupKillWrite) throw FakeCgroupHost.error("EACCES");
        const child = path.slice(0, -"/cgroup.kill".length);
        this.files.set(join(child, "cgroup.procs"), "");
        this.files.set(join(child, "cgroup.events"), "populated 0\nfrozen 0\n");
        this.refreshRootEvents();
      } else if (path.endsWith("/memory.oom.group") && !this.supportsOomGroup) {
        throw FakeCgroupHost.error("ENOENT");
      } else {
        this.files.set(path, data);
      }
      this.writes.push(Object.freeze([path, data]));
    },
    mkdir: async (path) => {
      if (this.collisions.delete(path) || this.directories.has(path)) {
        throw FakeCgroupHost.error("EEXIST");
      }
      this.directories.add(path);
      this.initializeChild(path);
      this.refreshRootStat();
    },
    rmdir: async (path) => {
      if (this.repopulateOnNextRmdir) {
        this.repopulateOnNextRmdir = false;
        this.markPopulated(path, [8001]);
        this.files.set(join(path, "memory.events"), [
          "low 0", "high 0", "max 1", "oom 1", "oom_kill 1", "oom_group_kill 1", "",
        ].join("\n"));
        throw FakeCgroupHost.error("EBUSY");
      }
      if (this.failNextRmdir) {
        const error = this.failNextRmdir;
        this.failNextRmdir = undefined;
        throw error;
      }
      if (!this.directories.has(path)) throw FakeCgroupHost.error("ENOENT");
      if (this.files.get(join(path, "cgroup.events"))?.includes("populated 1")) {
        throw FakeCgroupHost.error("EBUSY");
      }
      if ([...this.directories].some((candidate) => candidate.startsWith(`${path}/`))) {
        throw FakeCgroupHost.error("ENOTEMPTY");
      }
      this.directories.delete(path);
      for (const key of [...this.files.keys()]) {
        if (key.startsWith(`${path}/`)) this.files.delete(key);
      }
      this.removed.push(path);
      this.refreshRootStat();
      this.refreshRootEvents();
    },
    access: async (path, mode) => {
      this.accesses.push(Object.freeze([path, mode]));
      if (path.endsWith("/cgroup.kill") && !this.supportsCgroupKill) {
        throw FakeCgroupHost.error("ENOENT");
      }
      if (this.deniedAccess.has(path)) throw FakeCgroupHost.error("EACCES");
      if (path === ROOT || path.startsWith(`${ROOT}/`)) return;
      throw FakeCgroupHost.error("ENOENT");
    },
    stat: async (path) => {
      if (!this.directories.has(path)) throw FakeCgroupHost.error("ENOENT");
      return {
        dev: 42,
        ino: path === ROOT ? this.rootIno : 100,
        isDirectory: () => true,
      } as Pick<Stats, "dev" | "ino" | "isDirectory">;
    },
  };

  readonly deps: LinuxWorkloadCgroupDependencies = {
    fs: this.fs,
    process: {
      platform: this.platform,
      readSelfMountInfo: async () =>
        `31 25 0:28 / ${MOUNT} rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw\n`,
      readSelfCgroup: async () => `0::${this.currentCgroup}\n`,
      randomUUID: () => this.uuids.shift() ?? "uuid-fallback",
      now: () => this.nowMs,
      sleep: async (milliseconds) => { this.nowMs += milliseconds; },
    },
  };

  private initializeChild(path: string): void {
    this.files.set(join(path, "memory.events"), [
      "low 0", "high 0", "max 0", "oom 0", "oom_kill 0", "oom_group_kill 0", "",
    ].join("\n"));
    if (this.supportsMemoryPeak) this.files.set(join(path, "memory.peak"), "0\n");
    this.files.set(join(path, "pids.events"), "max 0\n");
    this.files.set(join(path, "cpu.stat"), "usage_usec 0\nuser_usec 0\nsystem_usec 0\n");
    this.files.set(join(path, "cgroup.events"), "populated 0\nfrozen 0\n");
    this.files.set(join(path, "cgroup.procs"), "");
    if (this.supportsCgroupKill) this.files.set(join(path, "cgroup.kill"), "");
    if (this.supportsOomGroup) this.files.set(join(path, "memory.oom.group"), "0\n");
  }

  private refreshRootStat(): void {
    const descendants = [...this.directories]
      .filter((path) => path.startsWith(`${ROOT}/`)).length;
    this.files.set(
      join(ROOT, "cgroup.stat"),
      `nr_descendants ${descendants}\nnr_dying_descendants 0\n`,
    );
  }

  private refreshRootEvents(): void {
    const populated = [...this.directories]
      .filter((path) => path.startsWith(`${ROOT}/`))
      .some((path) => this.files.get(join(path, "cgroup.events"))?.includes("populated 1"));
    this.files.set(join(ROOT, "cgroup.events"), `populated ${populated ? 1 : 0}\nfrozen 0\n`);
  }

  lastChild(): string {
    const children = [...this.directories].filter((path) => path.startsWith(`${ROOT}/`));
    if (children.length !== 1) throw new Error(`Expected one child cgroup, found ${children.length}`);
    return children[0]!;
  }

  markPopulated(child: string, pids: readonly number[]): void {
    this.files.set(join(child, "cgroup.procs"), `${pids.join("\n")}\n`);
    this.files.set(join(child, "cgroup.events"), "populated 1\nfrozen 0\n");
    this.refreshRootEvents();
  }
}

function host(): FakeCgroupHost {
  return new FakeCgroupHost();
}

async function capability(fake: FakeCgroupHost): Promise<LinuxWorkloadCgroupCapability> {
  return issueLinuxWorkloadCgroupCapability({
    delegatedRoot: ROOT,
    generation: "launcher-generation-1",
  }, fake.deps);
}

async function workload(fake: FakeCgroupHost) {
  const issued = await capability(fake);
  fake.writes.length = 0;
  fake.removed.length = 0;
  return createLinuxWorkloadCgroup({
    capability: issued,
    invocationId: "tool-call-1",
    limits: LIMITS,
    cleanupTimeoutMs: 100,
    cleanupPollMs: 10,
  });
}

function delta(memoryEvents: Record<string, string>): LinuxCgroupMetricDelta {
  return Object.freeze({
    memoryEvents: Object.freeze(memoryEvents),
    pidsEvents: Object.freeze({ max: "0" }),
    cpuStat: Object.freeze({ usage_usec: "0" }),
  });
}

describe("Linux workload cgroup capability", () => {
  it("issues one frozen, generation-bound capability only after verifying delegation", async () => {
    const fake = host();
    fake.files.set(
      join(ROOT, "cgroup.stat"),
      "nr_descendants 0\nnr_dying_descendants 2\n",
    );
    const issued = await capability(fake);

    expect(issued).toMatchObject({
      version: "linux-workload-cgroup-capability/v1",
      generation: "launcher-generation-1",
      delegatedRoot: ROOT,
      mountPoint: MOUNT,
      controllerCgroup: CONTROLLER,
      controllers: ["cpu", "memory", "pids"],
    });
    expect(Object.isFrozen(issued)).toBe(true);
    expect(Object.isFrozen(issued.controllers)).toBe(true);
    expect(isIssuedLinuxWorkloadCgroupCapability(issued)).toBe(true);
    expect(isIssuedLinuxWorkloadCgroupCapability({ ...issued })).toBe(false);
  });

  it("rejects non-Linux, read-only, incomplete, occupied, and controller-inside delegations", async () => {
    const nonLinux = host();
    (nonLinux.deps.process as { platform: NodeJS.Platform }).platform = "darwin";
    await expect(capability(nonLinux)).rejects.toThrow("only on Linux");

    const readOnly = host();
    readOnly.deniedAccess.add(ROOT);
    await expect(capability(readOnly)).rejects.toMatchObject({ code: "EACCES" });

    const incomplete = host();
    incomplete.files.set(join(ROOT, "cgroup.subtree_control"), "cpu memory\n");
    await expect(capability(incomplete)).rejects.toThrow("has not enabled 'pids'");

    const threaded = host();
    threaded.files.set(join(ROOT, "cgroup.type"), "threaded\n");
    await expect(capability(threaded)).rejects.toThrow("must be a domain cgroup");

    const occupied = host();
    occupied.files.set(join(ROOT, "cgroup.procs"), "9000\n");
    await expect(capability(occupied)).rejects.toThrow("must not contain");

    const populatedDescendant = host();
    populatedDescendant.files.set(join(ROOT, "cgroup.events"), "populated 1\nfrozen 0\n");
    await expect(capability(populatedDescendant)).rejects.toThrow("live descendant");

    const staleDescendant = host();
    staleDescendant.directories.add(join(ROOT, "stale-empty-leaf"));
    staleDescendant.files.set(
      join(ROOT, "cgroup.stat"),
      "nr_descendants 1\nnr_dying_descendants 0\n",
    );
    await expect(capability(staleDescendant)).rejects.toThrow("existing descendants");

    const controllerInside = host();
    controllerInside.currentCgroup = "/lvis/workloads/controller";
    controllerInside.directories.add(`${ROOT}/controller`);
    await expect(capability(controllerInside)).rejects.toThrow("must remain outside");
  });

  it("rejects a capability after the delegated root generation identity changes", async () => {
    const fake = host();
    const issued = await capability(fake);
    fake.rootIno += 1;
    await expect(createLinuxWorkloadCgroup({
      capability: issued,
      invocationId: "stale",
      limits: LIMITS,
    })).rejects.toThrow("generation is stale");
  });

  it("invalidates an older capability when the host rotates the root generation", async () => {
    const fake = host();
    const oldCapability = await capability(fake);
    await issueLinuxWorkloadCgroupCapability({
      delegatedRoot: ROOT,
      generation: "launcher-generation-2",
    }, fake.deps);
    await expect(createLinuxWorkloadCgroup({
      capability: oldCapability,
      invocationId: "old-generation",
      limits: LIMITS,
    })).rejects.toThrow("capability generation is stale");
    await expect(issueLinuxWorkloadCgroupCapability({
      delegatedRoot: ROOT,
      generation: "launcher-generation-1",
    }, fake.deps)).rejects.toThrow("must be fresh");
    await expect(createLinuxWorkloadCgroup({
      capability: oldCapability,
      invocationId: "aba-must-stay-stale",
      limits: LIMITS,
    })).rejects.toThrow("capability generation is stale");
  });

  it("requires a fresh generation for each capability issuance", async () => {
    const fake = host();
    const issued = await capability(fake);
    await expect(capability(fake)).rejects.toThrow("must be fresh");
    const handle = await createLinuxWorkloadCgroup({
      capability: issued,
      invocationId: "still-current",
      limits: LIMITS,
    });
    await handle.cleanup();
  });

  it("serializes generation rotation ahead of a concurrent stale create", async () => {
    const fake = host();
    const oldCapability = await capability(fake);
    const originalRead = fake.fs.readFile;
    let signalPaused!: () => void;
    let resumeRotation!: () => void;
    const paused = new Promise<void>((resolvePaused) => { signalPaused = resolvePaused; });
    const resume = new Promise<void>((resolveResume) => { resumeRotation = resolveResume; });
    let blockNextRootStat = true;
    fake.fs.readFile = async (path) => {
      const value = await originalRead(path);
      if (blockNextRootStat && path === join(ROOT, "cgroup.stat")) {
        blockNextRootStat = false;
        signalPaused();
        await resume;
      }
      return value;
    };

    const rotating = issueLinuxWorkloadCgroupCapability({
      delegatedRoot: ROOT,
      generation: "launcher-generation-2",
    }, fake.deps);
    await paused;
    const staleCreate = createLinuxWorkloadCgroup({
      capability: oldCapability,
      invocationId: "concurrent-stale-create",
      limits: LIMITS,
    });
    const staleRejection = expect(staleCreate).rejects.toThrow("capability generation is stale");
    resumeRotation();
    await expect(rotating).resolves.toMatchObject({ generation: "launcher-generation-2" });
    await staleRejection;
    expect([...fake.directories].filter((path) => path.includes("invocation-"))).toEqual([]);
  });

  it("probes real child limit writes before issuing authority and removes a failed probe", async () => {
    const fake = host();
    const originalWrite = fake.fs.writeFile;
    fake.fs.writeFile = async (path, data) => {
      if (path.includes("capability-probe-") && path.endsWith("/cpu.max")) {
        throw FakeCgroupHost.error("EACCES", "cpu controller is not delegated");
      }
      await originalWrite(path, data);
    };
    await expect(capability(fake)).rejects.toThrow("cpu controller is not delegated");
    expect(fake.removed).toEqual([join(ROOT, "capability-probe-uuid-1")]);
  });
});

describe("Linux workload cgroup lifecycle", () => {
  it.runIf(process.platform !== "win32")(
    "attaches before executing exact argv without shell interpolation",
    () => {
      const cgroup = mkdtempSync(join(tmpdir(), "lvis-cgroup-trampoline-"));
      try {
        writeFileSync(join(cgroup, "cgroup.procs"), "", "utf8");
        const injection = "$(exit 99); echo model-controlled";
        const result = spawnSync("/bin/sh", [
          "-c",
          LINUX_CGROUP_ARGV_TRAMPOLINE,
          "lvis-cgroup-trampoline",
          cgroup,
          "/bin/sh",
          "-c",
          "printf '%s\\0' \"$$\" \"$1\" \"$2\"",
          "target-after-attach",
          injection,
          "literal\nnewline",
        ], {
          encoding: "utf8",
          env: {},
        });
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        const [pid, first, second] = result.stdout.split("\0");
        expect([first, second]).toEqual([injection, "literal\nnewline"]);
        expect(readFileSync(join(cgroup, "cgroup.procs"), "utf8").trim()).toBe(pid);
      } finally {
        rmSync(cgroup, { recursive: true, force: true });
      }
    },
  );

  it("writes bounded limits and builds an argv-only pre-exec attachment trampoline", async () => {
    const fake = host();
    const handle = await workload(fake);
    const child = fake.lastChild();
    expect(fake.writes).toEqual([
      [join(child, "memory.max"), "268435456\n"],
      [join(child, "memory.swap.max"), "0\n"],
      [join(child, "pids.max"), "64\n"],
      [join(child, "cpu.max"), "50000 100000\n"],
      [join(child, "memory.oom.group"), "1\n"],
    ]);

    const executable = "/opt/tool with spaces";
    const injection = "$(touch /tmp/never) ; echo owned";
    const launch = handle.buildTrampolineLaunch([executable, injection, "literal\nnewline"]);
    expect(launch).toEqual({
      executable: "/bin/sh",
      args: [
        "-c", LINUX_CGROUP_ARGV_TRAMPOLINE, "lvis-cgroup-trampoline", child,
        executable, injection, "literal\nnewline",
      ],
      env: {},
    });
    expect(Object.isFrozen(launch)).toBe(true);
    expect(Object.isFrozen(launch.args)).toBe(true);
    expect(Object.isFrozen(launch.env)).toBe(true);
    expect(LINUX_CGROUP_ARGV_TRAMPOLINE).not.toContain(child);
    expect(LINUX_CGROUP_ARGV_TRAMPOLINE).not.toContain(executable);
    expect(LINUX_CGROUP_ARGV_TRAMPOLINE).not.toContain(injection);
    expect(() => handle.buildTrampolineLaunch([executable])).toThrow("already issued");
    await handle.cleanup();
    expect(() => handle.buildTrampolineLaunch([executable])).toThrow("closing or closed");
  });

  it("supports unbounded CPU and kernels without memory.peak or memory.oom.group", async () => {
    const fake = host();
    fake.supportsMemoryPeak = false;
    fake.supportsOomGroup = false;
    const handle = await createLinuxWorkloadCgroup({
      capability: await capability(fake),
      invocationId: "unlimited",
      limits: {
        memoryMaxBytes: 268_435_456,
        pidsMax: 64,
        cpuMax: { quotaMicros: "max", periodMicros: 100_000 },
      },
    });
    const child = fake.lastChild();
    expect(fake.files.get(join(child, "memory.max"))).toBe("268435456\n");
    expect(fake.files.get(join(child, "memory.swap.max"))).toBe("0\n");
    expect(fake.files.get(join(child, "pids.max"))).toBe("64\n");
    expect(fake.files.get(join(child, "cpu.max"))).toBe("max 100000\n");
    expect((await handle.readEvidence()).final.memoryPeakBytes).toBeNull();
    await handle.cleanup();
  });

  it("classifies memory exhaustion only from cgroup counter deltas", async () => {
    const fake = host();
    const handle = await workload(fake);
    const child = fake.lastChild();
    fake.files.set(join(child, "memory.events"), [
      "low 0", "high 0", "max 1", "oom 1", "oom_kill 1", "oom_group_kill 1", "",
    ].join("\n"));
    fake.files.set(join(child, "memory.peak"), "268435456\n");

    const first = await handle.finalize({ kind: "exited", code: 137 });
    const second = await handle.finalize({ kind: "exited", code: 137 });
    expect(first).toBe(second);
    expect(first.outcome).toEqual({
      kind: "resource_exhausted",
      resource: "memory",
      observedTermination: { kind: "exited", code: 137 },
    });
    expect(first.cleanup.evidence.delta.memoryEvents).toMatchObject({
      oom: "1",
      oom_kill: "1",
    });
    expect(first.cleanup.evidence.final.memoryPeakBytes).toBe("268435456");
    expect(JSON.stringify(first)).not.toContain("retry");
    expect(fake.removed).toEqual([child]);
    expect(await handle.cleanup()).toBe(first.cleanup);
  });

  it("does not call exit 137 or SIGKILL an OOM without counter evidence", () => {
    const evidence = { delta: delta({ oom: "0", oom_kill: "0" }) };
    expect(classifyLinuxWorkloadOutcome({ kind: "exited", code: 137 }, evidence)).toEqual({
      kind: "exited",
      code: 137,
    });
    expect(classifyLinuxWorkloadOutcome({ kind: "signaled", signal: "SIGKILL" }, evidence)).toEqual({
      kind: "signaled",
      signal: "SIGKILL",
    });
  });

  it("keeps timeout and cancellation distinct when memory counters did not move", () => {
    const evidence = { delta: delta({ oom: "0", oom_kill: "0" }) };
    expect(classifyLinuxWorkloadOutcome({ kind: "timed_out", signal: "SIGKILL" }, evidence)).toEqual({
      kind: "timed_out",
      signal: "SIGKILL",
    });
    expect(classifyLinuxWorkloadOutcome({ kind: "cancelled", signal: null }, evidence)).toEqual({
      kind: "cancelled",
      signal: null,
    });
  });

  it("uses cgroup.kill, waits for empty, then removes the cgroup", async () => {
    const fake = host();
    const handle = await workload(fake);
    const child = fake.lastChild();
    fake.markPopulated(child, [5001, 5002]);
    const receipt = await handle.cleanup();
    expect(receipt.killMethod).toBe("cgroup.kill");
    expect(fake.writes).toContainEqual([join(child, "cgroup.kill"), "1\n"]);
    expect(fake.removed).toEqual([child]);
  });

  it("refuses to issue cleanup authority when cgroup.kill is unavailable", async () => {
    const fake = host();
    fake.supportsCgroupKill = false;
    await expect(capability(fake)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("proves cgroup.kill with the actual write required by cleanup", async () => {
    const fake = host();
    fake.denyCgroupKillWrite = true;
    await expect(capability(fake)).rejects.toMatchObject({ code: "EACCES" });
    expect(fake.removed).toEqual([join(ROOT, "capability-probe-uuid-1")]);
  });

  it("does not downgrade a permission failure on cgroup.kill into a pid sweep", async () => {
    const fake = host();
    const handle = await workload(fake);
    const originalWrite = fake.fs.writeFile;
    fake.fs.writeFile = async (path, data) => {
      if (path.endsWith("/cgroup.kill")) throw FakeCgroupHost.error("EACCES");
      await originalWrite(path, data);
    };
    fake.markPopulated(fake.lastChild(), [7001]);
    await expect(handle.cleanup()).rejects.toMatchObject({ code: "EACCES" });
  });

  it("keeps cleanup ownership and allows retry after a non-transient removal failure", async () => {
    const fake = host();
    const handle = await workload(fake);
    const child = fake.lastChild();
    fake.failNextRmdir = FakeCgroupHost.error("EACCES");
    await expect(handle.finalize({ kind: "exited", code: 0 })).rejects.toMatchObject({ code: "EACCES" });
    const retried = await handle.finalize({ kind: "exited", code: 0 });
    expect(retried.outcome).toEqual({ kind: "exited", code: 0 });
    expect(fake.removed).toEqual([child]);
  });

  it("re-drains a repopulated cgroup and captures final OOM evidence before removal", async () => {
    const fake = host();
    const handle = await workload(fake);
    const child = fake.lastChild();
    fake.repopulateOnNextRmdir = true;
    const finalized = await handle.finalize({ kind: "exited", code: 137 });
    expect(finalized.outcome).toEqual({
      kind: "resource_exhausted",
      resource: "memory",
      observedTermination: { kind: "exited", code: 137 },
    });
    expect(finalized.cleanup.killMethod).toBe("cgroup.kill");
    expect(finalized.cleanup.evidence.delta.memoryEvents.oom_kill).toBe("1");
    expect(fake.writes).toContainEqual([join(child, "cgroup.kill"), "1\n"]);
    expect(fake.removed).toEqual([child]);
  });

  it("fails immediately and retains ownership when an empty nested cgroup blocks removal", async () => {
    const fake = host();
    const handle = await workload(fake);
    const child = fake.lastChild();
    const nested = join(child, "model-created-child");
    await fake.fs.mkdir(nested);
    await expect(handle.cleanup()).rejects.toThrow("nested descendants; isolated recovery is required");
    expect(fake.nowMs).toBe(0);
    expect(fake.directories.has(child)).toBe(true);
    expect(fake.directories.has(nested)).toBe(true);
    await fake.fs.rmdir(nested);
    expect((await handle.cleanup()).removed).toBe(true);
    expect(fake.removed).toEqual([nested, child]);
  });

  it("rolls back an unstarted cgroup if limit setup fails", async () => {
    const fake = host();
    const originalWrite = fake.fs.writeFile;
    fake.fs.writeFile = async (path, data) => {
      if (path.endsWith("/pids.max")) throw FakeCgroupHost.error("EACCES", "limit denied");
      await originalWrite(path, data);
    };
    await expect(workload(fake)).rejects.toThrow("limit denied");
    expect(fake.removed).toHaveLength(1);
  });

  it("retries an opaque UUID collision without using the caller id in the path", async () => {
    const fake = host();
    fake.collisions.add(join(ROOT, "invocation-uuid-2"));
    const handle = await createLinuxWorkloadCgroup({
      capability: await capability(fake),
      invocationId: "../../model-provided-path",
      limits: LIMITS,
    });
    expect(handle.cgroupPath).toBe(join(ROOT, "invocation-uuid-3"));
    expect(handle.cgroupPath).not.toContain("model-provided-path");
    await handle.cleanup();
  });

  it("validates limits and argv before granting lifecycle operations", async () => {
    const fake = host();
    const issued = await capability(fake);
    await expect(createLinuxWorkloadCgroup({
      capability: issued,
      invocationId: "bad",
      limits: { ...LIMITS, memoryMaxBytes: 0 },
    })).rejects.toThrow("memory.max");
    const handle = await createLinuxWorkloadCgroup({
      capability: issued,
      invocationId: "good",
      limits: LIMITS,
    });
    expect(() => handle.buildTrampolineLaunch([])).toThrow("must contain an executable");
    expect(() => handle.buildTrampolineLaunch(["printf", "ok"])).toThrow("absolute path");
    expect(() => handle.buildTrampolineLaunch(["/usr/bin/printf", "bad\0arg"])).toThrow("NUL-free");
    await handle.cleanup();
  });

  it("uses the required writable delegation checks", async () => {
    const fake = host();
    await capability(fake);
    expect(fake.accesses).toEqual([
      [ROOT, constants.W_OK | constants.X_OK],
      [join(ROOT, "cgroup.procs"), constants.W_OK],
      [join(ROOT, "cgroup.subtree_control"), constants.W_OK],
    ]);
    expect(fake.writes).toContainEqual([
      join(ROOT, "capability-probe-uuid-1", "cgroup.kill"),
      "1\n",
    ]);
  });
});
