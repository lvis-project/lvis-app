import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PluginToolOperationPolicy } from "../plugins/types.js";

export interface PluginOperationPrincipal {
  ownerPluginId: string;
  ownerVersion: string;
  generationId: string;
  appSessionId: string;
  /**
   * Stable Host-private identity used only for cross-generation serialization
   * and poison. Authority remains bound to the revocable `accountHash`.
   */
  accountScopeHash: string;
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
  release(): void;
}

export class PluginOperationExecutionLeaseAbortedError extends Error {
  constructor() {
    super("plugin operation execution lease aborted");
    this.name = "PluginOperationExecutionLeaseAbortedError";
  }
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
  return [
    value.ownerPluginId,
    value.ownerVersion,
    value.generationId,
    value.appSessionId,
    value.accountScopeHash,
    value.accountHash,
  ].join("\0");
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
    principal.accountScopeHash,
    principal.accountHash,
  ].join("\0"));
}

interface PendingExecutionLease {
  readonly domainKey: string;
  readonly principal: PluginOperationPrincipal;
  readonly resolve: (lease: PluginOperationExecutionLease) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
}

interface ExecutionDomainState {
  held: boolean;
  heldDomainKey?: string;
  queue: PendingExecutionLease[];
}

interface ExecutionDomainRevision {
  readonly ownerPluginId: string;
  readonly generationId: string;
  readonly accountScopeHash: string;
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
  private readonly poisonedOperationScopes = new Set<string>();
  private readonly revokedSessions = new Set<string>();
  private readonly revokedGenerations = new Set<string>();
  private readonly revokedAccounts = new Set<string>();
  private revocationCapacityExhausted = false;
  private poisonCapacityExhausted = false;
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
    if (domain.poisoned) {
      throw new Error("plugin operation domain is indeterminate");
    }
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
    const domain = this.requireDomain(domainKey, key);
    if (domain.poisoned) {
      throw new Error("plugin operation domain is indeterminate");
    }
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
    if (domain.poisoned) {
      throw new Error("plugin operation domain is indeterminate");
    }
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
      "intentHash", "appSessionId", "accountScopeHash", "accountHash",
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
    const currentDomain = this.domainRevisions.get(domainKey);
    if (!currentDomain || currentDomain.revoked) {
      return {
        ok: false,
        reason: "operation grant domain is revoked",
        grantId: stored.id,
      };
    }
    if (currentDomain.poisoned) {
      return {
        ok: false,
        reason: "operation grant domain is indeterminate",
        grantId: stored.id,
      };
    }
    if (binding.readRevision !== null) {
      if (stored.domainRevision !== currentDomain.revision) {
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
   * A new read, session reset, generation update, rollback, or account
   * re-authentication cannot clear this state for the same Host-derived plugin
   * and account identity. The poison scope uses the stable Host-private account
   * identity and deliberately omits the revocable principal, version, and
   * generation so reauthentication or replacement cannot clear it.
   */
  poisonDomain(domainKey: string): void {
    const domain = this.domainRevisions.get(domainKey);
    if (!domain) {
      throw new Error("plugin operation domain is not registered");
    }
    const scopeKey = this.poisonScopeKey(
      domain.ownerPluginId,
      domain.accountScopeHash,
    );
    if (!this.poisonedOperationScopes.has(scopeKey)) {
      if (this.poisonedOperationScopes.size >= this.maxDomains) {
        this.poisonedOperationScopes.clear();
        this.poisonCapacityExhausted = true;
      } else {
        this.poisonedOperationScopes.add(scopeKey);
      }
    }
    for (const candidate of this.domainRevisions.values()) {
      if (
        this.poisonCapacityExhausted ||
        (
          candidate.ownerPluginId === domain.ownerPluginId &&
          candidate.accountScopeHash === domain.accountScopeHash
        )
      ) {
        candidate.revision = randomUUID();
        candidate.poisoned = true;
      }
    }
  }

  acquireExecutionLease(
    domainKey: string,
    principal: PluginOperationPrincipal,
    signal?: AbortSignal,
  ): Promise<PluginOperationExecutionLease> {
    if (!/^[0-9a-f]{64}$/.test(domainKey)) {
      return Promise.reject(new Error("plugin operation domain key is invalid"));
    }
    try {
      this.assertPrincipalNotRevoked(principal);
      const domain = this.requireDomain(domainKey, principal);
      if (domain.poisoned) {
        throw new Error("plugin operation domain is indeterminate");
      }
    } catch (error) {
      return Promise.reject(error);
    }
    if (signal?.aborted) {
      return Promise.reject(new PluginOperationExecutionLeaseAbortedError());
    }
    const executionScopeKey = this.executionScopeKey(
      principal.ownerPluginId,
      principal.accountScopeHash,
    );
    const state = this.executionDomains.get(executionScopeKey) ?? {
      held: false,
      queue: [],
    };
    this.executionDomains.set(executionScopeKey, state);

    return new Promise<PluginOperationExecutionLease>((resolve, reject) => {
      const request: PendingExecutionLease = {
        domainKey,
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
          reject(new PluginOperationExecutionLeaseAbortedError());
          this.drainExecutionDomain(executionScopeKey, state);
        };
        signal.addEventListener("abort", request.onAbort, { once: true });
      }
      state.queue.push(request);
      this.drainExecutionDomain(executionScopeKey, state);
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
      !domain.poisoned &&
      domain.ownerPluginId === principal.ownerPluginId &&
      domain.generationId === principal.generationId &&
      domain.accountScopeHash === principal.accountScopeHash &&
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
    if (domain.poisoned) {
      throw new Error("plugin operation domain is indeterminate");
    }
    if (
      domain.ownerPluginId !== principal.ownerPluginId ||
      domain.generationId !== principal.generationId ||
      domain.accountScopeHash !== principal.accountScopeHash ||
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
        existing.accountScopeHash !== principal.accountScopeHash ||
        existing.accountHash !== principal.accountHash
      ) {
        throw new Error("plugin operation domain owner mismatch");
      }
      if (existing.revoked) {
        throw new Error("plugin operation domain is revoked");
      }
      if (
        this.poisonCapacityExhausted ||
        this.poisonedOperationScopes.has(
          this.poisonScopeKey(
            existing.ownerPluginId,
            existing.accountScopeHash,
          ),
        )
      ) {
        existing.poisoned = true;
      }
      return existing;
    }
    if (this.domainRevisions.size >= this.maxDomains) {
      throw new Error("plugin operation domain capacity exceeded");
    }
    const created: ExecutionDomainRevision = {
      ownerPluginId: principal.ownerPluginId,
      generationId: principal.generationId,
      accountScopeHash: principal.accountScopeHash,
      accountHash: principal.accountHash,
      revision: randomUUID(),
      revoked: false,
      poisoned: this.poisonCapacityExhausted ||
        this.poisonedOperationScopes.has(
          this.poisonScopeKey(
            principal.ownerPluginId,
            principal.accountScopeHash,
          ),
        ),
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
    executionScopeKey: string,
    state: ExecutionDomainState,
  ): void {
    if (state.held) return;
    while (state.queue.length > 0) {
      const request = state.queue[0]!;
      const domain = this.domainRevisions.get(request.domainKey);
      const principalRevocationReason =
        this.principalRevocationReason(request.principal);
      const invalidError =
        principalRevocationReason
          ? new Error(principalRevocationReason)
          : !domain || domain.revoked
            ? new Error("plugin operation domain is revoked")
            : domain.poisoned
              ? new Error("plugin operation domain is indeterminate")
              : request.signal?.aborted
                ? new PluginOperationExecutionLeaseAbortedError()
                : undefined;
      if (!invalidError) break;
      state.queue.shift();
      if (request.signal && request.onAbort) {
        request.signal.removeEventListener("abort", request.onAbort);
      }
      request.reject(invalidError);
    }
    const first = state.queue[0];
    if (!first) {
      this.executionDomains.delete(executionScopeKey);
      return;
    }
    state.queue.shift();
    state.held = true;
    state.heldDomainKey = first.domainKey;
    this.resolveExecutionLease(executionScopeKey, state, first);
  }

  private revokeDomain(
    domainKey: string,
    domain: ExecutionDomainRevision,
  ): void {
    domain.revision = randomUUID();
    domain.revoked = true;
    const executionScopeKey = this.executionScopeKey(
      domain.ownerPluginId,
      domain.accountScopeHash,
    );
    const state = this.executionDomains.get(executionScopeKey);
    if (!state) {
      this.domainRevisions.delete(domainKey);
      return;
    }
    const retained: PendingExecutionLease[] = [];
    for (const request of state.queue) {
      if (request.domainKey !== domainKey) {
        retained.push(request);
        continue;
      }
      if (request.signal && request.onAbort) {
        request.signal.removeEventListener("abort", request.onAbort);
      }
      request.reject(new Error("plugin operation domain is revoked"));
    }
    state.queue = retained;
    if (state.heldDomainKey !== domainKey) {
      this.domainRevisions.delete(domainKey);
    }
    if (!state.held) this.drainExecutionDomain(executionScopeKey, state);
  }

  private resolveExecutionLease(
    executionScopeKey: string,
    state: ExecutionDomainState,
    request: PendingExecutionLease,
  ): void {
    if (request.signal && request.onAbort) {
      request.signal.removeEventListener("abort", request.onAbort);
    }
    const revocationReason = this.principalRevocationReason(request.principal);
    if (revocationReason) {
      state.held = false;
      state.heldDomainKey = undefined;
      request.reject(new Error(revocationReason));
      if (this.domainRevisions.get(request.domainKey)?.revoked) {
        this.domainRevisions.delete(request.domainKey);
      }
      this.drainExecutionDomain(executionScopeKey, state);
      return;
    }
    let released = false;
    request.resolve(Object.freeze({
      domainKey: request.domainKey,
      release: () => {
        if (released) return;
        released = true;
        state.held = false;
        state.heldDomainKey = undefined;
        if (this.domainRevisions.get(request.domainKey)?.revoked) {
          this.domainRevisions.delete(request.domainKey);
        }
        this.drainExecutionDomain(executionScopeKey, state);
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

  private executionScopeKey(
    ownerPluginId: string,
    accountScopeHash: string,
  ): string {
    return hash([
      "plugin-operation-execution-scope/v1",
      ownerPluginId,
      accountScopeHash,
    ].join("\0"));
  }

  private poisonScopeKey(
    ownerPluginId: string,
    accountScopeHash: string,
  ): string {
    return `${ownerPluginId}\0${accountScopeHash}`;
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
