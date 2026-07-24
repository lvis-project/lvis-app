import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PluginToolOperationPolicy } from "../plugins/types.js";

export interface PluginOperationPrincipal {
  ownerPluginId: string;
  ownerVersion: string;
  generationId: string;
  appSessionId: string;
  accountHash: string;
}

export type PluginOperationDomainPrincipal = Omit<
  PluginOperationPrincipal,
  "appSessionId"
>;

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
  domainKey: string;
  domainRevision: string;
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

/**
 * Compute the Host-private account operation domain for one invocation.
 *
 * Every governed operation in one immutable plugin generation and provider
 * account shares the same domain. Operation declarations may add restrictions,
 * but cannot prove that a compromised handler will stay within a narrower
 * resource component; account-wide serialization therefore remains Host-owned.
 */
export function pluginOperationExecutionDomain(
  principal: PluginOperationDomainPrincipal,
  toolName: string,
  operation: string,
  tools: readonly PluginOperationDomainTool[],
): string {
  const target = tools.find((tool) =>
    tool.name === toolName &&
    tool.pluginId === principal.ownerPluginId &&
    tool.pluginGeneration?.generationId === principal.generationId &&
    tool.operationPolicy?.operations[operation] !== undefined
  );
  if (!target) {
    throw new Error(
      `plugin operation domain is missing '${toolName}.${operation}' in active generation`,
    );
  }
  return hash([
    "plugin-operation-domain/v1",
    principal.ownerPluginId,
    principal.ownerVersion,
    principal.generationId,
    principal.accountHash,
  ].join("\0"));
}

interface PendingExecutionLease {
  readonly kind: "read" | "write";
  readonly principal: PluginOperationPrincipal;
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

interface ExecutionDomainRevision {
  readonly ownerPluginId: string;
  readonly generationId: string;
  readonly accountHash: string;
  revision: string;
  revoked: boolean;
  poisoned: boolean;
}

export class PluginOperationGrantCoordinator {
  private readonly grants = new Map<string, {
    id: string;
    binding: PluginOperationGrantBinding;
    reservedRead?: ReservedReadSnapshot;
    domainKey: string;
    domainRevision: string;
  }>();
  private readonly snapshots = new Map<string, ReadSnapshot>();
  private readonly latestReadSequences = new Map<string, number>();
  private readonly executionDomains = new Map<string, ExecutionDomainState>();
  private readonly domainRevisions = new Map<string, ExecutionDomainRevision>();
  private readonly revokedSessions = new Set<string>();
  private readonly revokedGenerations = new Set<string>();
  private readonly revokedAccounts = new Set<string>();
  private revocationCapacityExhausted = false;
  private nextReadSequence = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxGrants = 1024,
    private readonly maxSnapshots = 2048,
    private readonly maxDomains = 4096,
    private readonly maxRevocations = 16_384,
  ) {}

  recordRead(key: PluginReadSnapshotKey, domainKey: string): string {
    this.assertPrincipalNotRevoked(key);
    this.trimSnapshots();
    const domain = this.requireDomain(domainKey, key);
    const revision = randomUUID();
    const keyString = snapshotKey(key);
    const sequence = ++this.nextReadSequence;
    this.snapshots.set(keyString, {
      revision,
      recordedAt: this.now(),
      sequence,
      domainKey,
      domainRevision: domain.revision,
    });
    this.latestReadSequences.set(keyString, sequence);
    return revision;
  }

  /**
   * Mark the start of a governed read before plugin code executes.
   *
   * A new attempt supersedes every older snapshot or grant that could satisfy
   * a write's read prerequisite, even if the attempt later fails, is aborted,
   * or returns a structured non-success result.
   */
  beginRead(key: PluginReadSnapshotKey, domainKey: string): void {
    this.assertPrincipalNotRevoked(key);
    this.requireDomain(domainKey, key);
    const keyString = snapshotKey(key);
    this.snapshots.delete(keyString);
    this.latestReadSequences.set(keyString, ++this.nextReadSequence);
  }

  latestRequiredRead(
    principal: PluginOperationPrincipal,
    readTool: string,
    readOperations: readonly string[],
    maxAgeMs: number,
    domainKey: string,
  ): string | undefined {
    if (this.principalRevocationReason(principal)) return undefined;
    const domain = this.requireDomain(domainKey, principal);
    if (domain.poisoned) return undefined;
    let newest: ReadSnapshot | undefined;
    for (const readOperation of readOperations) {
      const candidate = this.snapshots.get(snapshotKey({ ...principal, readTool, readOperation }));
      if (candidate && (!newest || candidate.sequence > newest.sequence)) newest = candidate;
    }
    if (
      !newest ||
      newest.domainKey !== domainKey ||
      newest.domainRevision !== domain.revision ||
      this.now() - newest.recordedAt > maxAgeMs ||
      readOperations.some((readOperation) => {
        const latestSequence = this.latestReadSequences.get(snapshotKey({
          ...principal,
          readTool,
          readOperation,
        }));
        return latestSequence !== undefined && latestSequence > newest.sequence;
      })
    ) {
      return undefined;
    }
    return newest.revision;
  }

  issue(
    binding: Omit<PluginOperationGrantBinding, "contractVersion" | "nonce">,
    domainKey: string,
    requiredRead?: PluginRequiredReadReservation,
  ): {
    token: string;
    grantId: string;
  } {
    this.assertPrincipalNotRevoked(binding);
    this.collectExpired();
    const domain = this.requireDomain(domainKey, binding);
    let reservedRead: ReservedReadSnapshot | undefined;
    if (binding.readRevision === null) {
      if (requiredRead) {
        throw new Error("operation grant required read revision is missing");
      }
    } else {
      const snapshot = requiredRead
        ? this.reserveRequiredRead(
            binding,
            requiredRead,
            binding.readRevision,
            domainKey,
            domain.revision,
          )
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
      domainKey,
      domainRevision: domain.revision,
    });
    return { token, grantId };
  }

  consume(
    token: string | undefined,
    expected: PluginOperationGrantExpectation,
    domainKey: string,
  ): GrantConsumeResult {
    if (!token) return { ok: false, reason: "operation grant missing" };
    const key = hash(token);
    const stored = this.grants.get(key);
    this.grants.delete(key); // burn before every comparison; no await may precede this line
    if (!stored) return { ok: false, reason: "operation grant unknown or already consumed" };
    if (stored.domainKey !== domainKey) {
      return {
        ok: false,
        reason: "operation grant domain mismatch",
        grantId: stored.id,
      };
    }
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
      const domain = this.domainRevisions.get(domainKey);
      if (!domain || stored.domainRevision !== domain.revision) {
        return {
          ok: false,
          reason: "operation grant required read was invalidated by an intervening write",
          grantId: stored.id,
        };
      }
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

  consumeRequiredRead(
    principal: PluginOperationPrincipal,
    requirement: PluginRequiredReadReservation,
    domainKey: string,
  ): { ok: true } | { ok: false; reason: string } {
    const revision = this.latestRequiredRead(
      principal,
      requirement.readTool,
      requirement.readOperations,
      requirement.maxAgeMs,
      domainKey,
    );
    if (!revision) {
      return {
        ok: false,
        reason: "operation required read is missing or stale",
      };
    }
    const domain = this.requireDomain(domainKey, principal);
    return this.reserveRequiredRead(
      principal,
      requirement,
      revision,
      domainKey,
      domain.revision,
    )
      ? { ok: true }
      : {
          ok: false,
          reason: "operation required read changed before execution",
        };
  }

  markDomainMutation(domainKey: string): void {
    const domain = this.domainRevisions.get(domainKey);
    if (!domain) {
      throw new Error("plugin operation domain is not registered");
    }
    domain.revision = randomUUID();
  }

  /**
   * Permanently fail closed for a domain whose state may still be changing
   * outside Host-observable effect boundaries.
   *
   * A new read cannot clear this state. Only generation/account/session
   * retirement can replace the domain identity, so detached or delayed work
   * from an effect-capable post hook can never race a newly minted write grant.
   */
  poisonDomain(domainKey: string): void {
    const domain = this.domainRevisions.get(domainKey);
    if (!domain) {
      throw new Error("plugin operation domain is not registered");
    }
    domain.revision = randomUUID();
    domain.poisoned = true;
  }

  acquireExecutionLease(
    domainKey: string,
    kind: "read" | "write",
    principal: PluginOperationPrincipal,
    signal?: AbortSignal,
  ): Promise<PluginOperationExecutionLease> {
    if (!/^[0-9a-f]{64}$/.test(domainKey)) {
      return Promise.reject(new Error("plugin operation domain key is invalid"));
    }
    try {
      this.assertPrincipalNotRevoked(principal);
      this.requireDomain(domainKey, principal);
    } catch (error) {
      return Promise.reject(error);
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
      const request: PendingExecutionLease = {
        kind,
        principal: Object.freeze({ ...principal }),
        resolve,
        reject,
        signal,
      };
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
    this.rememberRevocation(
      this.revokedGenerations,
      this.generationRevocationKey(ownerPluginId, generationId),
    );
    for (const [key, value] of this.grants) {
      if (value.binding.ownerPluginId === ownerPluginId && value.binding.generationId === generationId) this.grants.delete(key);
    }
    for (const [key] of this.snapshots) {
      if (key.startsWith(`${ownerPluginId}\0`) && key.includes(`\0${generationId}\0`)) this.snapshots.delete(key);
    }
    for (const [key] of this.latestReadSequences) {
      if (key.startsWith(`${ownerPluginId}\0`) && key.includes(`\0${generationId}\0`)) this.latestReadSequences.delete(key);
    }
    for (const [domainKey, domain] of this.domainRevisions) {
      if (
        domain.ownerPluginId === ownerPluginId &&
        domain.generationId === generationId
      ) {
        this.revokeDomain(domainKey, domain);
      }
    }
  }

  revokeSession(appSessionId: string): void {
    this.rememberRevocation(this.revokedSessions, appSessionId);
    for (const [key, value] of this.grants) {
      if (value.binding.appSessionId === appSessionId) this.grants.delete(key);
    }
    for (const [key] of this.snapshots) {
      if (key.includes(`\0${appSessionId}\0`)) this.snapshots.delete(key);
    }
    for (const [key] of this.latestReadSequences) {
      if (key.includes(`\0${appSessionId}\0`)) this.latestReadSequences.delete(key);
    }
    for (const [domainKey, state] of this.executionDomains) {
      const retained: PendingExecutionLease[] = [];
      for (const request of state.queue) {
        if (request.principal.appSessionId !== appSessionId) {
          retained.push(request);
          continue;
        }
        if (request.signal && request.onAbort) {
          request.signal.removeEventListener("abort", request.onAbort);
        }
        request.reject(new Error("plugin operation session is revoked"));
      }
      state.queue = retained;
      this.drainExecutionDomain(domainKey, state);
    }
  }

  canRecordRead(
    principal: PluginOperationPrincipal,
    domainKey: string,
  ): boolean {
    if (this.principalRevocationReason(principal)) return false;
    const domain = this.domainRevisions.get(domainKey);
    return domain !== undefined &&
      !domain.revoked &&
      domain.ownerPluginId === principal.ownerPluginId &&
      domain.generationId === principal.generationId &&
      domain.accountHash === principal.accountHash;
  }

  revokeAccount(
    ownerPluginId: string,
    generationId: string,
    accountHash: string,
  ): void {
    this.rememberRevocation(
      this.revokedAccounts,
      this.accountRevocationKey(ownerPluginId, generationId, accountHash),
    );
    for (const [key, value] of this.grants) {
      if (
        value.binding.ownerPluginId === ownerPluginId &&
        value.binding.generationId === generationId &&
        value.binding.accountHash === accountHash
      ) {
        this.grants.delete(key);
      }
    }
    for (const [domainKey, domain] of this.domainRevisions) {
      if (
        domain.ownerPluginId === ownerPluginId &&
        domain.generationId === generationId &&
        domain.accountHash === accountHash
      ) {
        this.revokeDomain(domainKey, domain);
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

  assertExecutionAuthorized(
    principal: PluginOperationPrincipal,
    domainKey: string,
  ): void {
    this.assertPrincipalNotRevoked(principal);
    const domain = this.domainRevisions.get(domainKey);
    if (!domain || domain.revoked) {
      throw new Error("plugin operation domain is revoked");
    }
    if (
      domain.ownerPluginId !== principal.ownerPluginId ||
      domain.generationId !== principal.generationId ||
      domain.accountHash !== principal.accountHash
    ) {
      throw new Error("plugin operation domain owner mismatch");
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
    domainKey: string,
    domainRevision: string,
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
      newest.snapshot.domainKey !== domainKey ||
      newest.snapshot.domainRevision !== domainRevision ||
      this.now() - newest.snapshot.recordedAt > requiredRead.maxAgeMs ||
      requiredRead.readOperations.some((readOperation) => {
        const latestSequence = this.latestReadSequences.get(snapshotKey({
          ...principal,
          readTool: requiredRead.readTool,
          readOperation,
        }));
        return latestSequence !== undefined &&
          latestSequence > newest.snapshot.sequence;
      })
    ) {
      return undefined;
    }
    // Reservation and deletion are one synchronous critical section. Once a
    // grant owns this revision, no concurrent approval can mint another grant
    // from the same user-visible read snapshot.
    this.snapshots.delete(newest.key);
    return newest.snapshot;
  }

  private requireDomain(
    domainKey: string,
    principal: PluginOperationPrincipal,
  ): ExecutionDomainRevision {
    this.assertPrincipalNotRevoked(principal);
    if (!/^[0-9a-f]{64}$/.test(domainKey)) {
      throw new Error("plugin operation domain key is invalid");
    }
    const existing = this.domainRevisions.get(domainKey);
    if (existing) {
      if (
        existing.ownerPluginId !== principal.ownerPluginId ||
        existing.generationId !== principal.generationId ||
        existing.accountHash !== principal.accountHash
      ) {
        throw new Error("plugin operation domain owner mismatch");
      }
      if (existing.revoked) {
        throw new Error("plugin operation domain is revoked");
      }
      return existing;
    }
    if (this.domainRevisions.size >= this.maxDomains) {
      throw new Error("plugin operation domain capacity exceeded");
    }
    const created: ExecutionDomainRevision = {
      ownerPluginId: principal.ownerPluginId,
      generationId: principal.generationId,
      accountHash: principal.accountHash,
      revision: randomUUID(),
      revoked: false,
      poisoned: false,
    };
    this.domainRevisions.set(domainKey, created);
    return created;
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
    while (state.queue.length > 0) {
      const request = state.queue[0]!;
      const domain = this.domainRevisions.get(domainKey);
      const principalRevocationReason =
        this.principalRevocationReason(request.principal);
      const invalidReason =
        principalRevocationReason
          ? principalRevocationReason
          : !domain || domain.revoked
            ? "plugin operation domain is revoked"
            : request.signal?.aborted
              ? "plugin operation execution lease aborted"
              : undefined;
      if (!invalidReason) break;
      state.queue.shift();
      if (request.signal && request.onAbort) {
        request.signal.removeEventListener("abort", request.onAbort);
      }
      request.reject(new Error(invalidReason));
    }
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
      if (this.domainRevisions.get(domainKey)?.revoked) {
        this.domainRevisions.delete(domainKey);
      }
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

  private revokeDomain(
    domainKey: string,
    domain: ExecutionDomainRevision,
  ): void {
    domain.revision = randomUUID();
    domain.revoked = true;
    const state = this.executionDomains.get(domainKey);
    if (!state) {
      this.domainRevisions.delete(domainKey);
      return;
    }
    for (const request of state.queue.splice(0)) {
      if (request.signal && request.onAbort) {
        request.signal.removeEventListener("abort", request.onAbort);
      }
      request.reject(new Error("plugin operation domain is revoked"));
    }
    if (!state.writer && state.readers === 0) {
      this.executionDomains.delete(domainKey);
      this.domainRevisions.delete(domainKey);
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
    const revocationReason = this.principalRevocationReason(request.principal);
    if (revocationReason) {
      if (request.kind === "write") state.writer = false;
      else state.readers = Math.max(0, state.readers - 1);
      request.reject(new Error(revocationReason));
      this.drainExecutionDomain(domainKey, state);
      return;
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

  private generationRevocationKey(
    ownerPluginId: string,
    generationId: string,
  ): string {
    return `${ownerPluginId}\0${generationId}`;
  }

  private accountRevocationKey(
    ownerPluginId: string,
    generationId: string,
    accountHash: string,
  ): string {
    return `${ownerPluginId}\0${generationId}\0${accountHash}`;
  }

  private principalRevocationReason(
    principal: PluginOperationPrincipal,
  ): string | undefined {
    if (this.revocationCapacityExhausted) {
      return "plugin operation revocation capacity exhausted";
    }
    if (this.revokedSessions.has(principal.appSessionId)) {
      return "plugin operation session is revoked";
    }
    if (
      this.revokedGenerations.has(
        this.generationRevocationKey(
          principal.ownerPluginId,
          principal.generationId,
        ),
      )
    ) {
      return "plugin operation generation is revoked";
    }
    if (
      this.revokedAccounts.has(
        this.accountRevocationKey(
          principal.ownerPluginId,
          principal.generationId,
          principal.accountHash,
        ),
      )
    ) {
      return "plugin operation account is revoked";
    }
    return undefined;
  }

  private assertPrincipalNotRevoked(
    principal: PluginOperationPrincipal,
  ): void {
    const reason = this.principalRevocationReason(principal);
    if (reason) throw new Error(reason);
  }

  private rememberRevocation(
    target: Set<string>,
    key: string,
  ): void {
    if (this.revocationCapacityExhausted || target.has(key)) return;
    const revocationCount =
      this.revokedSessions.size +
      this.revokedGenerations.size +
      this.revokedAccounts.size;
    if (revocationCount >= this.maxRevocations) {
      // Bounded fail-closed degradation. Once exact tombstones can no longer
      // be retained safely, reject every future governed principal until
      // process restart instead of evicting old revocations and reviving
      // stale authority.
      this.revocationCapacityExhausted = true;
      this.revokedSessions.clear();
      this.revokedGenerations.clear();
      this.revokedAccounts.clear();
      return;
    }
    target.add(key);
  }
}
