import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PluginToolOperationPolicy } from "../plugins/types.js";

export interface PluginOperationPrincipal {
  ownerPluginId: string;
  ownerVersion: string;
  generationId: string;
  appSessionId: string;
  accountHash: string;
}

export interface PluginOperationGrantBinding extends PluginOperationPrincipal {
  contractVersion: 1;
  toolName: string;
  operation: string;
  intentHash: string;
  /**
   * Fresh read receipt for read-backed writes. `null` deliberately represents
   * a write with no truthful read prerequisite; the grant is still one-shot
   * and bound to the full intent, principal, and active generation.
   */
  readRevision: string | null;
  expiresAt: number;
  nonce: string;
}

export interface PluginReadSnapshotKey extends PluginOperationPrincipal {
  readTool: string;
  readOperation: string;
}

export interface PluginRequiredReadReservation {
  readTool: string;
  readOperations: readonly string[];
  maxAgeMs: number;
}

export interface PluginOperationGrantExpectation extends PluginOperationPrincipal {
  toolName: string;
  operation: string;
  intentHash: string;
  requiresRead: boolean;
}

export interface PluginOperationDomainTool {
  name: string;
  pluginId?: string;
  pluginGeneration?: {
    generationId: string;
  };
  operationPolicy?: PluginToolOperationPolicy;
}

export interface PluginOperationExecutionLease {
  readonly domainKey: string;
  readonly kind: "read" | "write";
  release(): void;
}

interface ReadSnapshot {
  revision: string;
  recordedAt: number;
  sequence: number;
}

interface ReservedReadSnapshot {
  requirement: PluginRequiredReadReservation;
  snapshot: ReadSnapshot;
}

export type GrantConsumeResult =
  | { ok: true; grantId: string }
  | { ok: false; reason: string; grantId?: string };

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function principalKey(value: PluginOperationPrincipal): string {
  return [value.ownerPluginId, value.ownerVersion, value.generationId, value.appSessionId, value.accountHash].join("\0");
}

function snapshotKey(value: PluginReadSnapshotKey): string {
  return `${principalKey(value)}\0${value.readTool}\0${value.readOperation}`;
}

function operationNode(toolName: string, operation: string): string {
  return `${toolName}\0${operation}`;
}

/**
 * Compute the Host-private connected operation domain for one invocation.
 *
 * Every operation on the same consolidated Tool belongs to one domain. A
 * write's declared read prerequisites join the read and write Tools into the
 * same component. The account, plugin version, and immutable generation scope
 * the resulting lock; app windows for the same provider account deliberately
 * share it so two sessions cannot race the same remote state.
 */
export function pluginOperationExecutionDomain(
  principal: PluginOperationPrincipal,
  toolName: string,
  operation: string,
  tools: readonly PluginOperationDomainTool[],
): string {
  const graph = new Map<string, Set<string>>();
  const connect = (left: string, right: string): void => {
    const leftEdges = graph.get(left) ?? new Set<string>();
    const rightEdges = graph.get(right) ?? new Set<string>();
    leftEdges.add(right);
    rightEdges.add(left);
    graph.set(left, leftEdges);
    graph.set(right, rightEdges);
  };

  for (const tool of tools) {
    if (
      tool.pluginId !== principal.ownerPluginId ||
      tool.pluginGeneration?.generationId !== principal.generationId ||
      !tool.operationPolicy
    ) {
      continue;
    }
    const nodes = Object.keys(tool.operationPolicy.operations)
      .map((candidateOperation) => operationNode(tool.name, candidateOperation));
    for (const node of nodes) {
      graph.set(node, graph.get(node) ?? new Set());
      for (const sibling of nodes) connect(node, sibling);
    }
    for (const [candidateOperation, rule] of Object.entries(
      tool.operationPolicy.operations,
    )) {
      if (rule.kind !== "write" || !rule.requiresRead) continue;
      const writeNode = operationNode(tool.name, candidateOperation);
      for (const readOperation of rule.requiresRead.operations) {
        connect(
          writeNode,
          operationNode(rule.requiresRead.tool, readOperation),
        );
      }
    }
  }

  const start = operationNode(toolName, operation);
  if (!graph.has(start)) {
    throw new Error(
      `plugin operation domain is missing '${toolName}.${operation}' in active generation`,
    );
  }
  const component = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (component.has(node)) continue;
    component.add(node);
    for (const neighbor of graph.get(node) ?? []) pending.push(neighbor);
  }
  return hash([
    "plugin-operation-domain/v1",
    principal.ownerPluginId,
    principal.ownerVersion,
    principal.generationId,
    principal.accountHash,
    ...[...component].sort(),
  ].join("\0"));
}

interface PendingExecutionLease {
  readonly kind: "read" | "write";
  readonly resolve: (lease: PluginOperationExecutionLease) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
}

interface ExecutionDomainState {
  readers: number;
  writer: boolean;
  queue: PendingExecutionLease[];
}

export class PluginOperationGrantCoordinator {
  private readonly grants = new Map<string, {
    id: string;
    binding: PluginOperationGrantBinding;
    reservedRead?: ReservedReadSnapshot;
  }>();
  private readonly snapshots = new Map<string, ReadSnapshot>();
  private readonly latestReadSequences = new Map<string, number>();
  private readonly executionDomains = new Map<string, ExecutionDomainState>();
  private nextReadSequence = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxGrants = 1024,
    private readonly maxSnapshots = 2048,
  ) {}

  recordRead(key: PluginReadSnapshotKey): string {
    this.trimSnapshots();
    const revision = randomUUID();
    const keyString = snapshotKey(key);
    const sequence = ++this.nextReadSequence;
    this.snapshots.set(keyString, {
      revision,
      recordedAt: this.now(),
      sequence,
    });
    this.latestReadSequences.set(keyString, sequence);
    return revision;
  }

  latestRequiredRead(
    principal: PluginOperationPrincipal,
    readTool: string,
    readOperations: readonly string[],
    maxAgeMs: number,
  ): string | undefined {
    let newest: ReadSnapshot | undefined;
    for (const readOperation of readOperations) {
      const candidate = this.snapshots.get(snapshotKey({ ...principal, readTool, readOperation }));
      if (candidate && (!newest || candidate.sequence > newest.sequence)) newest = candidate;
    }
    if (!newest || this.now() - newest.recordedAt > maxAgeMs) return undefined;
    return newest.revision;
  }

  issue(
    binding: Omit<PluginOperationGrantBinding, "contractVersion" | "nonce">,
    requiredRead?: PluginRequiredReadReservation,
  ): {
    token: string;
    grantId: string;
  } {
    this.collectExpired();
    let reservedRead: ReservedReadSnapshot | undefined;
    if (binding.readRevision === null) {
      if (requiredRead) {
        throw new Error("operation grant required read revision is missing");
      }
    } else {
      const snapshot = requiredRead
        ? this.reserveRequiredRead(binding, requiredRead, binding.readRevision)
        : undefined;
      if (!requiredRead || !snapshot) {
        throw new Error(
          "operation grant required read is missing, stale, changed, or already reserved",
        );
      }
      reservedRead = { requirement: requiredRead, snapshot };
    }
    if (this.grants.size >= this.maxGrants) {
      const oldest = this.grants.keys().next().value as string | undefined;
      if (oldest) this.grants.delete(oldest);
    }
    const token = randomBytes(32).toString("base64url");
    const grantId = randomUUID();
    this.grants.set(hash(token), {
      id: grantId,
      binding: { ...binding, contractVersion: 1, nonce: randomUUID() },
      ...(reservedRead ? { reservedRead } : {}),
    });
    return { token, grantId };
  }

  consume(
    token: string | undefined,
    expected: PluginOperationGrantExpectation,
  ): GrantConsumeResult {
    if (!token) return { ok: false, reason: "operation grant missing" };
    const key = hash(token);
    const stored = this.grants.get(key);
    this.grants.delete(key); // burn before every comparison; no await may precede this line
    if (!stored) return { ok: false, reason: "operation grant unknown or already consumed" };
    const { binding } = stored;
    if (binding.expiresAt <= this.now()) return { ok: false, reason: "operation grant expired", grantId: stored.id };
    for (const field of [
      "ownerPluginId", "ownerVersion", "generationId", "toolName", "operation",
      "intentHash", "appSessionId", "accountHash",
    ] as const) {
      if (binding[field] !== expected[field]) {
        return { ok: false, reason: `operation grant ${field} mismatch`, grantId: stored.id };
      }
    }
    if ((binding.readRevision !== null) !== expected.requiresRead) {
      return {
        ok: false,
        reason: "operation grant read requirement mismatch",
        grantId: stored.id,
      };
    }
    if (binding.readRevision !== null) {
      if (
        !stored.reservedRead ||
        stored.reservedRead.snapshot.revision !== binding.readRevision
      ) {
        return {
          ok: false,
          reason: "operation grant read revision reservation mismatch",
          grantId: stored.id,
        };
      }
      if (
        this.now() - stored.reservedRead.snapshot.recordedAt >
        stored.reservedRead.requirement.maxAgeMs
      ) {
        return {
          ok: false,
          reason: "operation grant required read is stale",
          grantId: stored.id,
        };
      }
      if (this.hasSupersedingRead(binding, stored.reservedRead)) {
        return {
          ok: false,
          reason: "operation grant required read was superseded",
          grantId: stored.id,
        };
      }
    }
    return { ok: true, grantId: stored.id };
  }

  acquireExecutionLease(
    domainKey: string,
    kind: "read" | "write",
    signal?: AbortSignal,
  ): Promise<PluginOperationExecutionLease> {
    if (!/^[0-9a-f]{64}$/.test(domainKey)) {
      return Promise.reject(new Error("plugin operation domain key is invalid"));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error("plugin operation execution lease aborted"));
    }
    const state = this.executionDomains.get(domainKey) ?? {
      readers: 0,
      writer: false,
      queue: [],
    };
    this.executionDomains.set(domainKey, state);

    return new Promise<PluginOperationExecutionLease>((resolve, reject) => {
      const request: PendingExecutionLease = { kind, resolve, reject, signal };
      if (signal) {
        request.onAbort = () => {
          const index = state.queue.indexOf(request);
          if (index < 0) return;
          state.queue.splice(index, 1);
          reject(new Error("plugin operation execution lease aborted"));
          this.drainExecutionDomain(domainKey, state);
        };
        signal.addEventListener("abort", request.onAbort, { once: true });
      }
      state.queue.push(request);
      this.drainExecutionDomain(domainKey, state);
    });
  }

  revokeGeneration(ownerPluginId: string, generationId: string): void {
    for (const [key, value] of this.grants) {
      if (value.binding.ownerPluginId === ownerPluginId && value.binding.generationId === generationId) this.grants.delete(key);
    }
    for (const [key] of this.snapshots) {
      if (key.startsWith(`${ownerPluginId}\0`) && key.includes(`\0${generationId}\0`)) this.snapshots.delete(key);
    }
    for (const [key] of this.latestReadSequences) {
      if (key.startsWith(`${ownerPluginId}\0`) && key.includes(`\0${generationId}\0`)) this.latestReadSequences.delete(key);
    }
  }

  revokeSession(appSessionId: string): void {
    for (const [key, value] of this.grants) {
      if (value.binding.appSessionId === appSessionId) this.grants.delete(key);
    }
    for (const [key] of this.snapshots) {
      if (key.includes(`\0${appSessionId}\0`)) this.snapshots.delete(key);
    }
    for (const [key] of this.latestReadSequences) {
      if (key.includes(`\0${appSessionId}\0`)) this.latestReadSequences.delete(key);
    }
  }

  revokeAccount(
    ownerPluginId: string,
    generationId: string,
    accountHash: string,
  ): void {
    for (const [key, value] of this.grants) {
      if (
        value.binding.ownerPluginId === ownerPluginId &&
        value.binding.generationId === generationId &&
        value.binding.accountHash === accountHash
      ) {
        this.grants.delete(key);
      }
    }
    const principalPrefix = `${ownerPluginId}\0`;
    const generationMarker = `\0${generationId}\0`;
    const accountMarker = `\0${accountHash}\0`;
    for (const [key] of this.snapshots) {
      if (
        key.startsWith(principalPrefix) &&
        key.includes(generationMarker) &&
        key.includes(accountMarker)
      ) {
        this.snapshots.delete(key);
      }
    }
    for (const [key] of this.latestReadSequences) {
      if (
        key.startsWith(principalPrefix) &&
        key.includes(generationMarker) &&
        key.includes(accountMarker)
      ) {
        this.latestReadSequences.delete(key);
      }
    }
  }

  private collectExpired(): void {
    const now = this.now();
    for (const [key, value] of this.grants) if (value.binding.expiresAt <= now) this.grants.delete(key);
  }

  private reserveRequiredRead(
    principal: PluginOperationPrincipal,
    requiredRead: PluginRequiredReadReservation,
    expectedRevision: string,
  ): ReadSnapshot | undefined {
    let newest:
      | { key: string; snapshot: ReadSnapshot }
      | undefined;
    for (const readOperation of requiredRead.readOperations) {
      const key = snapshotKey({
        ...principal,
        readTool: requiredRead.readTool,
        readOperation,
      });
      const snapshot = this.snapshots.get(key);
      if (
        snapshot &&
        (!newest || snapshot.sequence > newest.snapshot.sequence)
      ) {
        newest = { key, snapshot };
      }
    }
    if (
      !newest ||
      newest.snapshot.revision !== expectedRevision ||
      this.now() - newest.snapshot.recordedAt > requiredRead.maxAgeMs
    ) {
      return undefined;
    }
    // Reservation and deletion are one synchronous critical section. Once a
    // grant owns this revision, no concurrent approval can mint another grant
    // from the same user-visible read snapshot.
    this.snapshots.delete(newest.key);
    return newest.snapshot;
  }

  private hasSupersedingRead(
    principal: PluginOperationPrincipal,
    reservedRead: ReservedReadSnapshot,
  ): boolean {
    return reservedRead.requirement.readOperations.some((readOperation) => {
      const latestSequence = this.latestReadSequences.get(snapshotKey({
        ...principal,
        readTool: reservedRead.requirement.readTool,
        readOperation,
      }));
      return latestSequence !== undefined &&
        latestSequence > reservedRead.snapshot.sequence;
    });
  }

  private trimSnapshots(): void {
    if (this.snapshots.size < this.maxSnapshots) return;
    const oldest = this.snapshots.keys().next().value as string | undefined;
    if (oldest) this.snapshots.delete(oldest);
  }

  private drainExecutionDomain(
    domainKey: string,
    state: ExecutionDomainState,
  ): void {
    if (state.writer) return;
    if (state.readers > 0) {
      while (state.queue[0]?.kind === "read") {
        const reader = state.queue.shift()!;
        state.readers += 1;
        this.resolveExecutionLease(domainKey, state, reader);
      }
      return;
    }
    const first = state.queue[0];
    if (!first) {
      this.executionDomains.delete(domainKey);
      return;
    }
    if (first.kind === "write") {
      state.queue.shift();
      state.writer = true;
      this.resolveExecutionLease(domainKey, state, first);
      return;
    }
    while (state.queue[0]?.kind === "read") {
      const reader = state.queue.shift()!;
      state.readers += 1;
      this.resolveExecutionLease(domainKey, state, reader);
    }
  }

  private resolveExecutionLease(
    domainKey: string,
    state: ExecutionDomainState,
    request: PendingExecutionLease,
  ): void {
    if (request.signal && request.onAbort) {
      request.signal.removeEventListener("abort", request.onAbort);
    }
    let released = false;
    request.resolve(Object.freeze({
      domainKey,
      kind: request.kind,
      release: () => {
        if (released) return;
        released = true;
        if (request.kind === "write") state.writer = false;
        else state.readers = Math.max(0, state.readers - 1);
        this.drainExecutionDomain(domainKey, state);
      },
    }));
  }
}
