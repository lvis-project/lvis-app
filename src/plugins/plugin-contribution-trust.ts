import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeUtf8FileAtomicSync } from "../lib/atomic-file.js";

export type PluginContributionTrustKind = "hook" | "mcpServer";

export interface PluginContributionTrustIdentity {
  pluginId: string;
  pluginVersion: string;
  localId: string;
  fingerprint: string;
}

interface TrustFile {
  version: 1;
  kind: PluginContributionTrustKind;
  approvals: PluginContributionTrustIdentity[];
}

function key(identity: PluginContributionTrustIdentity): string {
  return [identity.pluginId, identity.pluginVersion, identity.localId, identity.fingerprint].join("|");
}

/** Durable exact-byte trust store. Generation ids intentionally do not transfer authority. */
export class PluginContributionTrustStore {
  private readonly approvals = new Map<string, PluginContributionTrustIdentity>();

  constructor(
    private readonly kind: PluginContributionTrustKind,
    private readonly path?: string,
  ) {
    if (!path) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as TrustFile;
      if (parsed.version !== 1 || parsed.kind !== kind || !Array.isArray(parsed.approvals)) {
        throw new Error(`invalid ${kind} plugin contribution trust file`);
      }
      for (const identity of parsed.approvals) {
        if (
          !identity?.pluginId || !identity.pluginVersion || !identity.localId ||
          !/^[a-f0-9]{64}$/.test(identity.fingerprint)
        ) {
          throw new Error(`invalid ${kind} plugin contribution trust record`);
        }
        this.approvals.set(key(identity), Object.freeze({ ...identity }));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  approve(identity: PluginContributionTrustIdentity): void {
    this.approvals.set(key(identity), Object.freeze({ ...identity }));
    this.persist();
  }

  isApproved(identity: PluginContributionTrustIdentity): boolean {
    return this.approvals.has(key(identity));
  }

  revoke(identity: PluginContributionTrustIdentity): void {
    if (!this.approvals.delete(key(identity))) return;
    this.persist();
  }

  private persist(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const body: TrustFile = {
      version: 1,
      kind: this.kind,
      approvals: [...this.approvals.values()],
    };
    writeUtf8FileAtomicSync(this.path, `${JSON.stringify(body, null, 2)}\n`, 0o600);
  }
}
