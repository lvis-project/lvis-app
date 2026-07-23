import { createHash, randomBytes, randomUUID } from "node:crypto";

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

export class PluginOperationGrantCoordinator {
  private readonly grants = new Map<string, {
    id: string;
    binding: PluginOperationGrantBinding;
    reservedRead?: ReservedReadSnapshot;
  }>();
  private readonly snapshots = new Map<string, ReadSnapshot>();
  private nextReadSequence = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxGrants = 1024,
    private readonly maxSnapshots = 2048,
  ) {}

  recordRead(key: PluginReadSnapshotKey): string {
    this.trimSnapshots();
    const revision = randomUUID();
    this.snapshots.set(snapshotKey(key), {
      revision,
      recordedAt: this.now(),
      sequence: ++this.nextReadSequence,
    });
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

  revokeGeneration(ownerPluginId: string, generationId: string): void {
    for (const [key, value] of this.grants) {
      if (value.binding.ownerPluginId === ownerPluginId && value.binding.generationId === generationId) this.grants.delete(key);
    }
    for (const [key] of this.snapshots) {
      if (key.startsWith(`${ownerPluginId}\0`) && key.includes(`\0${generationId}\0`)) this.snapshots.delete(key);
    }
  }

  revokeSession(appSessionId: string): void {
    for (const [key, value] of this.grants) {
      if (value.binding.appSessionId === appSessionId) this.grants.delete(key);
    }
    for (const [key] of this.snapshots) {
      if (key.includes(`\0${appSessionId}\0`)) this.snapshots.delete(key);
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
      const snapshot = this.snapshots.get(snapshotKey({
        ...principal,
        readTool: reservedRead.requirement.readTool,
        readOperation,
      }));
      return snapshot !== undefined &&
        snapshot.sequence > reservedRead.snapshot.sequence &&
        snapshot.revision !== reservedRead.snapshot.revision;
    });
  }

  private trimSnapshots(): void {
    if (this.snapshots.size < this.maxSnapshots) return;
    const oldest = this.snapshots.keys().next().value as string | undefined;
    if (oldest) this.snapshots.delete(oldest);
  }
}
