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
  readRevision: string;
  expiresAt: number;
  nonce: string;
}

export interface PluginReadSnapshotKey extends PluginOperationPrincipal {
  readTool: string;
  readOperation: string;
}

interface ReadSnapshot {
  revision: string;
  recordedAt: number;
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
  private readonly grants = new Map<string, { id: string; binding: PluginOperationGrantBinding }>();
  private readonly snapshots = new Map<string, ReadSnapshot>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxGrants = 1024,
    private readonly maxSnapshots = 2048,
  ) {}

  recordRead(key: PluginReadSnapshotKey): string {
    this.trimSnapshots();
    const revision = randomUUID();
    this.snapshots.set(snapshotKey(key), { revision, recordedAt: this.now() });
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
      if (candidate && (!newest || candidate.recordedAt > newest.recordedAt)) newest = candidate;
    }
    if (!newest || this.now() - newest.recordedAt > maxAgeMs) return undefined;
    return newest.revision;
  }

  issue(binding: Omit<PluginOperationGrantBinding, "contractVersion" | "nonce">): {
    token: string;
    grantId: string;
  } {
    this.collectExpired();
    if (this.grants.size >= this.maxGrants) {
      const oldest = this.grants.keys().next().value as string | undefined;
      if (oldest) this.grants.delete(oldest);
    }
    const token = randomBytes(32).toString("base64url");
    const grantId = randomUUID();
    this.grants.set(hash(token), {
      id: grantId,
      binding: { ...binding, contractVersion: 1, nonce: randomUUID() },
    });
    return { token, grantId };
  }

  consume(token: string | undefined, expected: Omit<PluginOperationGrantBinding, "contractVersion" | "nonce" | "expiresAt">): GrantConsumeResult {
    if (!token) return { ok: false, reason: "operation grant missing" };
    const key = hash(token);
    const stored = this.grants.get(key);
    this.grants.delete(key); // burn before every comparison; no await may precede this line
    if (!stored) return { ok: false, reason: "operation grant unknown or already consumed" };
    const { binding } = stored;
    if (binding.expiresAt <= this.now()) return { ok: false, reason: "operation grant expired", grantId: stored.id };
    for (const field of [
      "ownerPluginId", "ownerVersion", "generationId", "toolName", "operation",
      "intentHash", "appSessionId", "accountHash", "readRevision",
    ] as const) {
      if (binding[field] !== expected[field]) {
        return { ok: false, reason: `operation grant ${field} mismatch`, grantId: stored.id };
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

  private collectExpired(): void {
    const now = this.now();
    for (const [key, value] of this.grants) if (value.binding.expiresAt <= now) this.grants.delete(key);
  }

  private trimSnapshots(): void {
    if (this.snapshots.size < this.maxSnapshots) return;
    const oldest = this.snapshots.keys().next().value as string | undefined;
    if (oldest) this.snapshots.delete(oldest);
  }
}
