import { randomUUID } from "node:crypto";
import { constants, promises as nodeFs, type Stats } from "node:fs";
import { posix as pathPosix } from "node:path";
import { sha256Hex } from "../lib/hex-digest-equal.js";
import { canonicalStringify } from "../shared/canonical-json.js";

const CAPABILITY_VERSION = "linux-workload-cgroup-capability/v1" as const;
const HANDLE_VERSION = "linux-workload-cgroup-handle/v1" as const;
const REQUIRED_CONTROLLERS = Object.freeze(["cpu", "memory", "pids"] as const);
const DEFAULT_CLEANUP_TIMEOUT_MS = 2_000;
const DEFAULT_CLEANUP_POLL_MS = 20;
const MAX_CREATE_ATTEMPTS = 4;
const { isAbsolute, join, relative, resolve, sep } = pathPosix;

/**
 * This script is trusted host code launched with an empty environment. The
 * delegated cgroup path and every workload argument are positional parameters;
 * none are interpolated into the script source. Target environment handoff is
 * intentionally outside this unwired foundation because putting secrets in
 * trampoline argv would expose them through process listings.
 */
export const LINUX_CGROUP_ARGV_TRAMPOLINE = [
  "set -eu",
  "cgroup_dir=$1",
  "shift",
  "printf '%s\\n' \"$$\" > \"$cgroup_dir/cgroup.procs\"",
  "exec \"$@\"",
].join("\n");

export interface LinuxWorkloadCgroupFs {
  realpath(path: string): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  access(path: string, mode: number): Promise<void>;
  stat(path: string): Promise<Pick<Stats, "dev" | "ino" | "isDirectory">>;
}

interface LinuxWorkloadCgroupProcess {
  readonly platform: NodeJS.Platform;
  readSelfMountInfo(): Promise<string>;
  readSelfCgroup(): Promise<string>;
  randomUUID(): string;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export interface LinuxWorkloadCgroupDependencies {
  readonly fs: LinuxWorkloadCgroupFs;
  readonly process: LinuxWorkloadCgroupProcess;
}

export interface LinuxWorkloadCgroupCapability {
  readonly version: typeof CAPABILITY_VERSION;
  readonly identity: string;
  readonly generation: string;
  readonly delegatedRoot: string;
  readonly mountId: string;
  readonly mountPoint: string;
  readonly controllerCgroup: string;
  readonly controllers: readonly (typeof REQUIRED_CONTROLLERS)[number][];
}

export interface LinuxWorkloadLimits {
  readonly memoryMaxBytes: number;
  /** Defaults to zero so a workload cannot evade memory.max through swap. */
  readonly memorySwapMaxBytes?: number | "max";
  readonly pidsMax: number;
  readonly cpuMax:
    | Readonly<{ readonly quotaMicros: number; readonly periodMicros: number }>
    | Readonly<{ readonly quotaMicros: "max"; readonly periodMicros: number }>;
}

interface LinuxCgroupMetricSnapshot {
  readonly memoryEvents: Readonly<Record<string, string>>;
  readonly memoryPeakBytes: string | null;
  readonly pidsEvents: Readonly<Record<string, string>>;
  readonly cpuStat: Readonly<Record<string, string>>;
}

export interface LinuxCgroupMetricDelta {
  readonly memoryEvents: Readonly<Record<string, string>>;
  readonly pidsEvents: Readonly<Record<string, string>>;
  readonly cpuStat: Readonly<Record<string, string>>;
}

export interface LinuxWorkloadResourceEvidence {
  readonly capabilityIdentity: string;
  readonly capabilityGeneration: string;
  readonly invocationIdentity: string;
  readonly baseline: LinuxCgroupMetricSnapshot;
  readonly final: LinuxCgroupMetricSnapshot;
  readonly delta: LinuxCgroupMetricDelta;
}

export type LinuxWorkloadTermination =
  | Readonly<{ readonly kind: "exited"; readonly code: number }>
  | Readonly<{ readonly kind: "signaled"; readonly signal: NodeJS.Signals }>
  | Readonly<{ readonly kind: "timed_out"; readonly signal: NodeJS.Signals | null }>
  | Readonly<{ readonly kind: "cancelled"; readonly signal: NodeJS.Signals | null }>;

export type LinuxWorkloadOutcome =
  | Readonly<{
      readonly kind: "resource_exhausted";
      readonly resource: "memory";
      readonly observedTermination: LinuxWorkloadTermination;
    }>
  | LinuxWorkloadTermination;

interface LinuxWorkloadCleanupReceipt {
  readonly killMethod: "not-needed" | "cgroup.kill";
  readonly removed: true;
  readonly evidence: LinuxWorkloadResourceEvidence;
}

interface LinuxWorkloadFinalization {
  readonly outcome: LinuxWorkloadOutcome;
  readonly cleanup: LinuxWorkloadCleanupReceipt;
}

interface LinuxWorkloadTrampolineLaunch {
  readonly executable: "/bin/sh";
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface LinuxWorkloadCgroupHandle {
  readonly version: typeof HANDLE_VERSION;
  readonly identity: string;
  readonly invocationIdentity: string;
  readonly cgroupPath: string;
  readonly capabilityIdentity: string;
  buildTrampolineLaunch(
    argv: readonly string[],
  ): LinuxWorkloadTrampolineLaunch;
  readEvidence(): Promise<LinuxWorkloadResourceEvidence>;
  cleanup(): Promise<LinuxWorkloadCleanupReceipt>;
  finalize(termination: LinuxWorkloadTermination): Promise<LinuxWorkloadFinalization>;
}

interface RootIdentity {
  readonly dev: string;
  readonly ino: string;
}

interface MountInfo {
  readonly id: string;
  readonly root: string;
  readonly mountPoint: string;
  readonly mountOptions: readonly string[];
  readonly superOptions: readonly string[];
}

interface CapabilityContext {
  readonly deps: LinuxWorkloadCgroupDependencies;
  readonly rootIdentity: RootIdentity;
  readonly mount: MountInfo;
}

interface HandleContext {
  readonly capability: LinuxWorkloadCgroupCapability;
  readonly deps: LinuxWorkloadCgroupDependencies;
  readonly baseline: LinuxCgroupMetricSnapshot;
  readonly cleanupTimeoutMs: number;
  readonly cleanupPollMs: number;
  trampolineIssued?: boolean;
  cleanupReceipt?: LinuxWorkloadCleanupReceipt;
  cleanupInFlight?: Promise<LinuxWorkloadCleanupReceipt>;
  finalization?: Readonly<{
    terminationKey: string;
    promise: Promise<LinuxWorkloadFinalization>;
  }>;
}

interface RootGenerationState {
  active: string;
  readonly seen: Set<string>;
}

const capabilityContexts = new WeakMap<LinuxWorkloadCgroupCapability, CapabilityContext>();
const handleContexts = new WeakMap<LinuxWorkloadCgroupHandle, HandleContext>();
const generationStateByDependencies = new WeakMap<
  LinuxWorkloadCgroupDependencies,
  Map<string, RootGenerationState>
>();
const rootLockTailsByDependencies = new WeakMap<
  LinuxWorkloadCgroupDependencies,
  Map<string, Promise<void>>
>();

const defaultDependencies: LinuxWorkloadCgroupDependencies = Object.freeze({
  fs: Object.freeze({
    realpath: (path: string) => nodeFs.realpath(path),
    readFile: (path: string) => nodeFs.readFile(path, "utf8"),
    writeFile: (path: string, data: string) => nodeFs.writeFile(path, data, "utf8"),
    mkdir: (path: string) => nodeFs.mkdir(path),
    rmdir: (path: string) => nodeFs.rmdir(path),
    access: (path: string, mode: number) => nodeFs.access(path, mode),
    stat: (path: string) => nodeFs.stat(path),
  }),
  process: Object.freeze({
    platform: process.platform,
    readSelfMountInfo: () => nodeFs.readFile("/proc/self/mountinfo", "utf8"),
    readSelfCgroup: () => nodeFs.readFile("/proc/self/cgroup", "utf8"),
    randomUUID,
    now: () => performance.now(),
    sleep: (milliseconds: number) => new Promise<void>((resolveSleep) => {
      setTimeout(resolveSleep, milliseconds);
    }),
  }),
});

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\(040|011|012|134)/g, (_match, code: string) => {
    switch (code) {
      case "040": return " ";
      case "011": return "\t";
      case "012": return "\n";
      case "134": return "\\";
      default: return _match;
    }
  });
}

function isWithin(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" ||
    (pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent));
}

function parseCgroup2Mounts(mountInfo: string): readonly MountInfo[] {
  const mounts: MountInfo[] = [];
  for (const line of mountInfo.split("\n")) {
    if (line.length === 0) continue;
    const separatorIndex = line.indexOf(" - ");
    if (separatorIndex < 0) continue;
    const before = line.slice(0, separatorIndex).split(" ");
    const after = line.slice(separatorIndex + 3).split(" ");
    if (before.length < 6 || after[0] !== "cgroup2") continue;
    mounts.push(Object.freeze({
      id: before[0]!,
      root: decodeMountInfoPath(before[3]!),
      mountPoint: decodeMountInfoPath(before[4]!),
      mountOptions: Object.freeze(before[5]!.split(",")),
      superOptions: Object.freeze((after[2] ?? "").split(",").filter(Boolean)),
    }));
  }
  return Object.freeze(mounts);
}

function selectCgroup2Mount(mountInfo: string, delegatedRoot: string): MountInfo {
  const mount = parseCgroup2Mounts(mountInfo)
    .filter((candidate) => isWithin(candidate.mountPoint, delegatedRoot))
    .sort((left, right) => right.mountPoint.length - left.mountPoint.length)[0];
  if (!mount) throw new Error("Delegated workload root is not on a cgroup-v2 mount");
  if (!mount.mountOptions.includes("rw") || mount.mountOptions.includes("ro") ||
      mount.superOptions.includes("ro")) {
    throw new Error("Delegated workload cgroup-v2 mount is read-only");
  }
  return mount;
}

function parseUnifiedCgroupPath(cgroupText: string): string {
  for (const line of cgroupText.split("\n")) {
    if (line.startsWith("0::")) {
      const membership = line.slice(3);
      if (!membership.startsWith("/")) break;
      return membership;
    }
  }
  throw new Error("Current process has no unified cgroup-v2 membership");
}

function resolveControllerCgroup(mount: MountInfo, membership: string): string {
  const membershipFromMountRoot = relative(mount.root, membership);
  if (membershipFromMountRoot === ".." || membershipFromMountRoot.startsWith(`..${sep}`)) {
    throw new Error("Current cgroup-v2 membership is outside the selected mount root");
  }
  return resolve(mount.mountPoint, membershipFromMountRoot);
}

function parseWordSet(value: string): ReadonlySet<string> {
  return new Set(value.trim().split(/\s+/).filter(Boolean).map((word) => word.replace(/^\+/, "")));
}

function rootIdentity(stats: Pick<Stats, "dev" | "ino">): RootIdentity {
  return Object.freeze({
    dev: String(stats.dev),
    ino: String(stats.ino),
  });
}

function sameRootIdentity(left: RootIdentity, right: RootIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function freezeStringMap(values: Record<string, string>): Readonly<Record<string, string>> {
  return Object.freeze({ ...values });
}

function validateGeneration(generation: string): void {
  if (generation.length === 0 || generation.trim() !== generation || generation.length > 256) {
    throw new Error("Workload cgroup generation must be a non-empty host value of at most 256 characters");
  }
}

async function withDelegatedRootLock<T>(
  deps: LinuxWorkloadCgroupDependencies,
  canonicalRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  let rootTails = rootLockTailsByDependencies.get(deps);
  if (!rootTails) {
    rootTails = new Map<string, Promise<void>>();
    rootLockTailsByDependencies.set(deps, rootTails);
  }
  const previous = rootTails.get(canonicalRoot) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolveRelease) => { release = resolveRelease; });
  const currentTail = previous.then(() => held);
  rootTails.set(canonicalRoot, currentTail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (rootTails.get(canonicalRoot) === currentTail) rootTails.delete(canonicalRoot);
  }
}

async function assertDelegatedRootEmpty(
  fs: LinuxWorkloadCgroupFs,
  canonicalRoot: string,
): Promise<void> {
  if ((await fs.readFile(join(canonicalRoot, "cgroup.procs"))).trim().length > 0) {
    throw new Error("Delegated workload cgroup root must not contain controller or workload processes");
  }
  if (await readPopulated(fs, canonicalRoot)) {
    throw new Error("Delegated workload cgroup root must not contain live descendant processes");
  }
  const rootStat = parseCounterFile(
    await fs.readFile(join(canonicalRoot, "cgroup.stat")),
    "cgroup.stat",
  );
  if (rootStat.nr_descendants !== "0") {
    throw new Error("Delegated workload cgroup root must not contain existing descendants");
  }
}

async function validateDelegatedRoot(
  delegatedRoot: string,
  generation: string,
  deps: LinuxWorkloadCgroupDependencies,
): Promise<{
  delegatedRoot: string;
  mount: MountInfo;
  controllerCgroup: string;
  identity: RootIdentity;
}> {
  if (deps.process.platform !== "linux") {
    throw new Error("Linux workload cgroups are available only on Linux");
  }
  validateGeneration(generation);
  if (!isAbsolute(delegatedRoot)) throw new Error("Delegated workload cgroup root must be absolute");

  const canonicalRoot = await deps.fs.realpath(delegatedRoot);
  const stats = await deps.fs.stat(canonicalRoot);
  if (!stats.isDirectory()) throw new Error("Delegated workload cgroup root is not a directory");
  const mount = selectCgroup2Mount(await deps.process.readSelfMountInfo(), canonicalRoot);
  const controllerCgroup = await deps.fs.realpath(resolveControllerCgroup(
    mount,
    parseUnifiedCgroupPath(await deps.process.readSelfCgroup()),
  ));
  if (isWithin(canonicalRoot, controllerCgroup)) {
    throw new Error("LVIS controller process must remain outside the delegated workload cgroup root");
  }

  await deps.fs.access(canonicalRoot, constants.W_OK | constants.X_OK);
  await deps.fs.access(join(canonicalRoot, "cgroup.procs"), constants.W_OK);
  await deps.fs.access(join(canonicalRoot, "cgroup.subtree_control"), constants.W_OK);

  const cgroupType = (await deps.fs.readFile(join(canonicalRoot, "cgroup.type"))).trim();
  if (cgroupType !== "domain") {
    throw new Error(`Delegated workload cgroup root must be a domain cgroup (received '${cgroupType}')`);
  }

  const available = parseWordSet(await deps.fs.readFile(join(canonicalRoot, "cgroup.controllers")));
  const enabled = parseWordSet(await deps.fs.readFile(join(canonicalRoot, "cgroup.subtree_control")));
  for (const controller of REQUIRED_CONTROLLERS) {
    if (!available.has(controller)) {
      throw new Error(`Delegated workload cgroup root lacks '${controller}' controller`);
    }
    if (!enabled.has(controller)) {
      throw new Error(`Delegated workload cgroup root has not enabled '${controller}' for child cgroups`);
    }
  }
  await assertDelegatedRootEmpty(deps.fs, canonicalRoot);

  // Access checks on the parent do not prove that controller files can be
  // configured on a child. Probe the exact writes this backend needs before
  // issuing any capability, then remove the empty probe leaf.
  const probeNonce = deps.process.randomUUID();
  if (!/^[0-9A-Za-z-]+$/.test(probeNonce)) {
    throw new Error("Host random UUID source returned an invalid value");
  }
  const probePath = join(canonicalRoot, `capability-probe-${probeNonce}`);
  await deps.fs.mkdir(probePath);
  let probeError: unknown;
  try {
    await deps.fs.writeFile(join(probePath, "memory.max"), "max\n");
    await deps.fs.writeFile(join(probePath, "memory.swap.max"), "0\n");
    await deps.fs.writeFile(join(probePath, "pids.max"), "max\n");
    await deps.fs.writeFile(join(probePath, "cpu.max"), "max 100000\n");
    await deps.fs.writeFile(join(probePath, "cgroup.kill"), "1\n");
    try {
      await deps.fs.writeFile(join(probePath, "memory.oom.group"), "1\n");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  } catch (error) {
    probeError = error;
  }
  try {
    await deps.fs.rmdir(probePath);
  } catch (cleanupError) {
    if (probeError !== undefined) {
      throw new AggregateError(
        [probeError, cleanupError],
        "Workload cgroup delegation probe and cleanup both failed",
      );
    }
    throw cleanupError;
  }
  if (probeError !== undefined) throw probeError;
  return {
    delegatedRoot: canonicalRoot,
    mount,
    controllerCgroup,
    identity: rootIdentity(stats),
  };
}

/**
 * Issue a capability from explicit host bootstrap state. This function never
 * reads environment variables or accepts tool/model input, and consumers must
 * present the exact issued object rather than a structural copy.
 */
export async function issueLinuxWorkloadCgroupCapability(input: {
  readonly delegatedRoot: string;
  readonly generation: string;
}, dependencies: LinuxWorkloadCgroupDependencies = defaultDependencies): Promise<LinuxWorkloadCgroupCapability> {
  if (dependencies.process.platform !== "linux") {
    throw new Error("Linux workload cgroups are available only on Linux");
  }
  validateGeneration(input.generation);
  if (!isAbsolute(input.delegatedRoot)) {
    throw new Error("Delegated workload cgroup root must be absolute");
  }
  const lockRoot = await dependencies.fs.realpath(input.delegatedRoot);
  return withDelegatedRootLock(dependencies, lockRoot, async () => {
    let generationStates = generationStateByDependencies.get(dependencies);
    if (!generationStates) {
      generationStates = new Map<string, RootGenerationState>();
      generationStateByDependencies.set(dependencies, generationStates);
    }
    const existingGeneration = generationStates.get(lockRoot);
    if (existingGeneration?.seen.has(input.generation)) {
      throw new Error("Workload cgroup generation must be fresh for each capability issuance");
    }

    const validated = await validateDelegatedRoot(input.delegatedRoot, input.generation, dependencies);
    if (validated.delegatedRoot !== lockRoot) {
      throw new Error("Delegated workload cgroup root changed while acquiring issuance ownership");
    }
    await assertDelegatedRootEmpty(dependencies.fs, validated.delegatedRoot);

    const fields = {
      version: CAPABILITY_VERSION,
      generation: input.generation,
      delegatedRoot: validated.delegatedRoot,
      mountId: validated.mount.id,
      mountPoint: validated.mount.mountPoint,
      controllerCgroup: validated.controllerCgroup,
      controllers: REQUIRED_CONTROLLERS,
      rootIdentity: validated.identity,
    } as const;
    const capability: LinuxWorkloadCgroupCapability = Object.freeze({
      version: CAPABILITY_VERSION,
      identity: sha256Hex(canonicalStringify(fields)),
      generation: input.generation,
      delegatedRoot: validated.delegatedRoot,
      mountId: validated.mount.id,
      mountPoint: validated.mount.mountPoint,
      controllerCgroup: validated.controllerCgroup,
      controllers: REQUIRED_CONTROLLERS,
    });
    capabilityContexts.set(capability, Object.freeze({
      deps: dependencies,
      rootIdentity: validated.identity,
      mount: validated.mount,
    }));
    if (existingGeneration) {
      existingGeneration.active = input.generation;
      existingGeneration.seen.add(input.generation);
    } else {
      generationStates.set(validated.delegatedRoot, {
        active: input.generation,
        seen: new Set([input.generation]),
      });
    }
    return capability;
  });
}

export function isIssuedLinuxWorkloadCgroupCapability(
  value: unknown,
): value is LinuxWorkloadCgroupCapability {
  return typeof value === "object" && value !== null &&
    capabilityContexts.has(value as LinuxWorkloadCgroupCapability);
}

function formatLimit(value: number | "max", label: string): string {
  if (value === "max") return value;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer or 'max'`);
  }
  return String(value);
}

function formatNonnegativeLimit(value: number | "max", label: string): string {
  if (value === "max") return value;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer or 'max'`);
  }
  return String(value);
}

function formatCpuMax(value: LinuxWorkloadLimits["cpuMax"]): string {
  const period = formatLimit(value.periodMicros, "cpu.max period");
  const quota = formatLimit(value.quotaMicros, "cpu.max quota");
  return `${quota} ${period}`;
}

function validateCleanupTiming(timeoutMs: number, pollMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new Error("Workload cgroup cleanup timeout must be an integer from 1 to 60000 ms");
  }
  if (!Number.isSafeInteger(pollMs) || pollMs <= 0 || pollMs > timeoutMs) {
    throw new Error("Workload cgroup cleanup poll interval must be positive and no larger than its timeout");
  }
}

async function assertCapabilityFresh(
  capability: LinuxWorkloadCgroupCapability,
  context: CapabilityContext,
): Promise<void> {
  assertCapabilityGenerationActive(capability, context.deps);
  const canonicalRoot = await context.deps.fs.realpath(capability.delegatedRoot);
  if (canonicalRoot !== capability.delegatedRoot) {
    throw new Error("Delegated workload cgroup root changed after capability issuance");
  }
  const currentMount = selectCgroup2Mount(
    await context.deps.process.readSelfMountInfo(),
    canonicalRoot,
  );
  if (currentMount.id !== context.mount.id ||
      currentMount.root !== context.mount.root ||
      currentMount.mountPoint !== context.mount.mountPoint) {
    throw new Error("Delegated workload cgroup mount generation is stale");
  }
  const stats = await context.deps.fs.stat(canonicalRoot);
  if (!stats.isDirectory() || !sameRootIdentity(rootIdentity(stats), context.rootIdentity)) {
    throw new Error("Delegated workload cgroup generation is stale");
  }
  const currentControllerCgroup = await context.deps.fs.realpath(resolveControllerCgroup(
    context.mount,
    parseUnifiedCgroupPath(await context.deps.process.readSelfCgroup()),
  ));
  if (currentControllerCgroup !== capability.controllerCgroup ||
      isWithin(capability.delegatedRoot, currentControllerCgroup)) {
    throw new Error("LVIS controller cgroup changed after capability issuance");
  }
  if ((await context.deps.fs.readFile(join(canonicalRoot, "cgroup.procs"))).trim().length > 0) {
    throw new Error("Delegated workload cgroup root no longer has an empty controller boundary");
  }
  if ((await context.deps.fs.readFile(join(canonicalRoot, "cgroup.type"))).trim() !== "domain") {
    throw new Error("Delegated workload cgroup root is no longer a domain cgroup");
  }
  const available = parseWordSet(
    await context.deps.fs.readFile(join(canonicalRoot, "cgroup.controllers")),
  );
  const enabled = parseWordSet(
    await context.deps.fs.readFile(join(canonicalRoot, "cgroup.subtree_control")),
  );
  for (const controller of REQUIRED_CONTROLLERS) {
    if (!available.has(controller) || !enabled.has(controller)) {
      throw new Error(`Delegated workload cgroup controller '${controller}' became unavailable`);
    }
  }
}

function assertCapabilityGenerationActive(
  capability: LinuxWorkloadCgroupCapability,
  deps: LinuxWorkloadCgroupDependencies,
): void {
  if (generationStateByDependencies.get(deps)?.get(capability.delegatedRoot)?.active !==
      capability.generation) {
    throw new Error("Delegated workload cgroup capability generation is stale");
  }
}

function parseCounterFile(value: string, label: string): Readonly<Record<string, string>> {
  const parsed: Record<string, string> = {};
  for (const line of value.trim().split("\n")) {
    if (line.length === 0) continue;
    const [key, raw, ...extra] = line.trim().split(/\s+/);
    if (!key || raw === undefined || extra.length > 0 || !/^\d+$/.test(raw)) {
      throw new Error(`Invalid ${label} counter line`);
    }
    parsed[key] = raw;
  }
  return freezeStringMap(parsed);
}

async function readOptionalUnsigned(
  fs: LinuxWorkloadCgroupFs,
  path: string,
): Promise<string | null> {
  try {
    const value = (await fs.readFile(path)).trim();
    if (!/^\d+$/.test(value)) throw new Error(`Invalid unsigned cgroup value at ${path}`);
    return value;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function readMetricSnapshot(
  fs: LinuxWorkloadCgroupFs,
  cgroupPath: string,
): Promise<LinuxCgroupMetricSnapshot> {
  const [memoryEvents, memoryPeakBytes, pidsEvents, cpuStat] = await Promise.all([
    fs.readFile(join(cgroupPath, "memory.events")),
    readOptionalUnsigned(fs, join(cgroupPath, "memory.peak")),
    fs.readFile(join(cgroupPath, "pids.events")),
    fs.readFile(join(cgroupPath, "cpu.stat")),
  ]);
  const parsedMemory = parseCounterFile(memoryEvents, "memory.events");
  if (parsedMemory.oom === undefined || parsedMemory.oom_kill === undefined) {
    throw new Error("memory.events lacks oom or oom_kill evidence counters");
  }
  return Object.freeze({
    memoryEvents: parsedMemory,
    memoryPeakBytes,
    pidsEvents: parseCounterFile(pidsEvents, "pids.events"),
    cpuStat: parseCounterFile(cpuStat, "cpu.stat"),
  });
}

function counterDelta(
  baseline: Readonly<Record<string, string>>,
  final: Readonly<Record<string, string>>,
  label: string,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const key of new Set([...Object.keys(baseline), ...Object.keys(final)])) {
    const before = BigInt(baseline[key] ?? "0");
    const after = BigInt(final[key] ?? "0");
    if (after < before) throw new Error(`${label} counter '${key}' moved backwards`);
    result[key] = String(after - before);
  }
  return freezeStringMap(result);
}

function buildEvidence(
  capability: LinuxWorkloadCgroupCapability,
  invocationIdentity: string,
  baseline: LinuxCgroupMetricSnapshot,
  final: LinuxCgroupMetricSnapshot,
): LinuxWorkloadResourceEvidence {
  return Object.freeze({
    capabilityIdentity: capability.identity,
    capabilityGeneration: capability.generation,
    invocationIdentity,
    baseline,
    final,
    delta: Object.freeze({
      memoryEvents: counterDelta(baseline.memoryEvents, final.memoryEvents, "memory.events"),
      pidsEvents: counterDelta(baseline.pidsEvents, final.pidsEvents, "pids.events"),
      cpuStat: counterDelta(baseline.cpuStat, final.cpuStat, "cpu.stat"),
    }),
  });
}

export function classifyLinuxWorkloadOutcome(
  termination: LinuxWorkloadTermination,
  evidence: Pick<LinuxWorkloadResourceEvidence, "delta">,
): LinuxWorkloadOutcome {
  const oom = BigInt(evidence.delta.memoryEvents.oom ?? "0");
  const oomKill = BigInt(evidence.delta.memoryEvents.oom_kill ?? "0");
  if (oom > 0n || oomKill > 0n) {
    return Object.freeze({
      kind: "resource_exhausted" as const,
      resource: "memory" as const,
      observedTermination: Object.freeze({ ...termination }),
    });
  }
  return Object.freeze({ ...termination });
}

function assertArgv(argv: readonly string[]): void {
  if (argv.length === 0 || argv.some((part) => typeof part !== "string" || part.includes("\0"))) {
    throw new Error("Workload argv must contain an executable and NUL-free string arguments");
  }
  if (!isAbsolute(argv[0]!)) {
    throw new Error("Workload executable must be an absolute path captured by the host");
  }
}

function terminationKey(termination: LinuxWorkloadTermination): string {
  return canonicalStringify(termination);
}

async function readPopulated(fs: LinuxWorkloadCgroupFs, cgroupPath: string): Promise<boolean> {
  const events = parseCounterFile(await fs.readFile(join(cgroupPath, "cgroup.events")), "cgroup.events");
  if (events.populated !== "0" && events.populated !== "1") {
    throw new Error("cgroup.events lacks a valid populated value");
  }
  return events.populated === "1";
}

async function terminatePopulatedCgroup(
  context: HandleContext,
  cgroupPath: string,
  deadline: number,
): Promise<LinuxWorkloadCleanupReceipt["killMethod"]> {
  if (!await readPopulated(context.deps.fs, cgroupPath)) return "not-needed";
  const killMethod: LinuxWorkloadCleanupReceipt["killMethod"] = "cgroup.kill";
  await context.deps.fs.writeFile(join(cgroupPath, "cgroup.kill"), "1\n");

  while (await readPopulated(context.deps.fs, cgroupPath)) {
    if (context.deps.process.now() >= deadline) {
      throw new Error("Workload cgroup remained populated after forced termination");
    }
    await context.deps.process.sleep(context.cleanupPollMs);
  }
  return killMethod;
}

function makeHandle(
  capability: LinuxWorkloadCgroupCapability,
  cgroupPath: string,
  invocationIdentity: string,
  baseline: LinuxCgroupMetricSnapshot,
  cleanupTimeoutMs: number,
  cleanupPollMs: number,
  deps: LinuxWorkloadCgroupDependencies,
): LinuxWorkloadCgroupHandle {
  let handle!: LinuxWorkloadCgroupHandle;
  const context: HandleContext = {
    capability,
    deps,
    baseline,
    cleanupTimeoutMs,
    cleanupPollMs,
  };

  const readEvidence = async (): Promise<LinuxWorkloadResourceEvidence> => {
    const current = handleContexts.get(handle);
    if (!current) throw new Error("Workload cgroup handle was not issued by the host");
    if (current.cleanupReceipt) return current.cleanupReceipt.evidence;
    return buildEvidence(
      current.capability,
      invocationIdentity,
      current.baseline,
      await readMetricSnapshot(current.deps.fs, cgroupPath),
    );
  };

  const cleanup = async (): Promise<LinuxWorkloadCleanupReceipt> => {
    const current = handleContexts.get(handle);
    if (!current) throw new Error("Workload cgroup handle was not issued by the host");
    if (current.cleanupReceipt) return current.cleanupReceipt;
    if (current.cleanupInFlight) return current.cleanupInFlight;
    const attempt = (async () => {
      const deadline = current.deps.process.now() + current.cleanupTimeoutMs;
      let observedKill = false;
      while (true) {
        const killMethod = await terminatePopulatedCgroup(current, cgroupPath, deadline);
        observedKill ||= killMethod === "cgroup.kill";
        const evidence = buildEvidence(
          current.capability,
          invocationIdentity,
          current.baseline,
          await readMetricSnapshot(current.deps.fs, cgroupPath),
        );
        try {
          await current.deps.fs.rmdir(cgroupPath);
          const receipt: LinuxWorkloadCleanupReceipt = Object.freeze({
            killMethod: observedKill ? "cgroup.kill" : "not-needed",
            removed: true as const,
            evidence,
          });
          current.cleanupReceipt = receipt;
          return receipt;
        } catch (error) {
          if (errorCode(error) === "ENOTEMPTY") {
            throw new Error(
              "Workload cgroup contains nested descendants; isolated recovery is required",
              { cause: error },
            );
          }
          if (errorCode(error) !== "EBUSY" || current.deps.process.now() >= deadline) {
            throw error;
          }
          await current.deps.process.sleep(current.cleanupPollMs);
        }
      }
    })();
    current.cleanupInFlight = attempt;
    try {
      return await attempt;
    } finally {
      if (!current.cleanupReceipt) current.cleanupInFlight = undefined;
    }
  };

  const finalize = async (
    termination: LinuxWorkloadTermination,
  ): Promise<LinuxWorkloadFinalization> => {
    const current = handleContexts.get(handle);
    if (!current) throw new Error("Workload cgroup handle was not issued by the host");
    const key = terminationKey(termination);
    if (current.finalization) {
      if (current.finalization.terminationKey !== key) {
        throw new Error("Workload cgroup was already finalized with different termination evidence");
      }
      return current.finalization.promise;
    }
    const promise = cleanup().then((cleanupReceipt) => Object.freeze({
      outcome: classifyLinuxWorkloadOutcome(termination, cleanupReceipt.evidence),
      cleanup: cleanupReceipt,
    })).catch((error: unknown) => {
      if (!current.cleanupReceipt) current.finalization = undefined;
      throw error;
    });
    current.finalization = Object.freeze({ terminationKey: key, promise });
    return promise;
  };

  handle = Object.freeze({
    version: HANDLE_VERSION,
    identity: sha256Hex(canonicalStringify({
      version: HANDLE_VERSION,
      capabilityIdentity: capability.identity,
      invocationIdentity,
      cgroupPath,
    })),
    invocationIdentity,
    cgroupPath,
    capabilityIdentity: capability.identity,
    buildTrampolineLaunch: (argv: readonly string[]): LinuxWorkloadTrampolineLaunch => {
      const current = handleContexts.get(handle);
      if (!current) throw new Error("Workload cgroup handle was not issued by the host");
      if (current.cleanupInFlight || current.cleanupReceipt) {
        throw new Error("Workload cgroup lifecycle is already closing or closed");
      }
      if (current.trampolineIssued) {
        throw new Error("Workload cgroup trampoline argv was already issued");
      }
      assertCapabilityGenerationActive(current.capability, current.deps);
      assertArgv(argv);
      current.trampolineIssued = true;
      return Object.freeze({
        executable: "/bin/sh" as const,
        args: Object.freeze([
          "-c",
          LINUX_CGROUP_ARGV_TRAMPOLINE,
          "lvis-cgroup-trampoline",
          cgroupPath,
          ...argv,
        ]),
        env: Object.freeze({}),
      });
    },
    readEvidence,
    cleanup,
    finalize,
  });
  handleContexts.set(handle, context);
  return handle;
}

async function removeUnstartedCgroup(
  fs: LinuxWorkloadCgroupFs,
  path: string,
  creationError: unknown,
): Promise<never> {
  try {
    await fs.rmdir(path);
  } catch (cleanupError) {
    throw new AggregateError(
      [creationError, cleanupError],
      "Workload cgroup creation and rollback both failed",
    );
  }
  throw creationError;
}

export async function createLinuxWorkloadCgroup(input: {
  readonly capability: LinuxWorkloadCgroupCapability;
  readonly invocationId: string;
  readonly limits: LinuxWorkloadLimits;
  readonly cleanupTimeoutMs?: number;
  readonly cleanupPollMs?: number;
}): Promise<LinuxWorkloadCgroupHandle> {
  const context = capabilityContexts.get(input.capability);
  if (!context) throw new Error("Workload cgroup capability was not issued by the host");
  if (input.invocationId.length === 0) throw new Error("Workload invocation id must be non-empty");
  const cleanupTimeoutMs = input.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  const cleanupPollMs = input.cleanupPollMs ?? DEFAULT_CLEANUP_POLL_MS;
  validateCleanupTiming(cleanupTimeoutMs, cleanupPollMs);
  const memoryMax = formatLimit(input.limits.memoryMaxBytes, "memory.max");
  const memorySwapMax = formatNonnegativeLimit(input.limits.memorySwapMaxBytes ?? 0, "memory.swap.max");
  const pidsMax = formatLimit(input.limits.pidsMax, "pids.max");
  const cpuMax = formatCpuMax(input.limits.cpuMax);
  return withDelegatedRootLock(context.deps, input.capability.delegatedRoot, async () => {
    await assertCapabilityFresh(input.capability, context);

    let cgroupPath = "";
    let nonce = "";
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      nonce = context.deps.process.randomUUID();
      if (!/^[0-9A-Za-z-]+$/.test(nonce)) {
        throw new Error("Host random UUID source returned an invalid value");
      }
      cgroupPath = join(input.capability.delegatedRoot, `invocation-${nonce}`);
      try {
        await context.deps.fs.mkdir(cgroupPath);
        break;
      } catch (error) {
        if (errorCode(error) !== "EEXIST" || attempt === MAX_CREATE_ATTEMPTS - 1) throw error;
      }
    }
    if (cgroupPath.length === 0) throw new Error("Failed to allocate a workload cgroup path");

    try {
      await context.deps.fs.writeFile(join(cgroupPath, "memory.max"), `${memoryMax}\n`);
      await context.deps.fs.writeFile(join(cgroupPath, "memory.swap.max"), `${memorySwapMax}\n`);
      await context.deps.fs.writeFile(join(cgroupPath, "pids.max"), `${pidsMax}\n`);
      await context.deps.fs.writeFile(join(cgroupPath, "cpu.max"), `${cpuMax}\n`);
      try {
        await context.deps.fs.writeFile(join(cgroupPath, "memory.oom.group"), "1\n");
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      const invocationIdentity = sha256Hex(canonicalStringify({
        capabilityIdentity: input.capability.identity,
        generation: input.capability.generation,
        invocationId: input.invocationId,
        nonce,
      }));
      const baseline = await readMetricSnapshot(context.deps.fs, cgroupPath);
      return makeHandle(
        input.capability,
        cgroupPath,
        invocationIdentity,
        baseline,
        cleanupTimeoutMs,
        cleanupPollMs,
        context.deps,
      );
    } catch (error) {
      return removeUnstartedCgroup(context.deps.fs, cgroupPath, error);
    }
  });
}
