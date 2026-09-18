import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { createNodeSecretEncryption } from "../../data/node-secret-encryption.js";
import { AuditLogger } from "../audit-logger.js";
import { createHostSecretStore } from "../host-secret-store.js";
import { ensureAuditSecret, sealKeyName } from "../hmac-chain.js";
import {
  createPermissionAuditProof,
  parsePermissionAuditProofCommand,
  PERMISSION_AUDIT_PROOF_SCHEMA,
} from "../permission-audit-proof.js";

const DATE = "2026-09-18";
const NOW = new Date(`${DATE}T12:34:56.789Z`);
const CHALLENGE = "c".repeat(64);
let home: string;
let keyFile: string;
let logger: AuditLogger | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lvis-audit-proof-"));
  chmodSync(home, 0o700);
  keyFile = join(home, "external.key");
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  vi.stubEnv("LVIS_HOME", home);
  vi.stubEnv("LVIS_SECRET_KEY_FILE", keyFile);
});

afterEach(async () => {
  if (logger) await logger.close();
  logger = undefined;
  vi.unstubAllEnvs();
  if (existsSync(home)) await cleanupTmpDir(home);
});

async function createValidAudit(): Promise<{ path: string; seals: ReturnType<typeof createHostSecretStore> }> {
  const seals = createHostSecretStore(
    createNodeSecretEncryption(keyFile),
    join(home, "secrets"),
  );
  logger = new AuditLogger(join(home, "audit"), { now: () => NOW });
  await logger.setupPermissionAuditChain(ensureAuditSecret(seals), seals);
  await logger.appendPermissionAuditEntry({
    decision: "allow",
    auditId: "proof-row",
    ts: NOW.toISOString(),
    trustOrigin: "user-keyboard",
    toolUseId: "tool-proof",
    workloadBrokerCorrelation: {
      version: "lvis-workload-correlation/v1",
      kind: "tool-invocation",
      toolUseId: "tool-proof",
      toolName: "read_file",
      operation: "file.read",
      grant: {
        identity: "1".repeat(64),
        effectDigest: "2".repeat(64),
        action: "builtin-tool",
        planIdentity: null,
      },
    },
    tool: "read_file",
    source: "builtin",
    category: "read",
    directory: "/app",
    directoryAllowed: true,
    layer: 6,
  });
  await logger.close();
  return { path: logger.getPermissionAuditLogFile(), seals };
}

describe("permission audit terminal proof", () => {
  it("emits a public receipt for a closed AuditLogger chain", async () => {
    const { path } = await createValidAudit();
    const raw = readFileSync(path);
    const receipt = await createPermissionAuditProof(CHALLENGE, () => NOW);

    expect(receipt).toEqual({
      schema: PERMISSION_AUDIT_PROOF_SCHEMA,
      challenge: CHALLENGE,
      verifiedAt: NOW.toISOString(),
      intact: true,
      files: [{
        name: `${DATE}.permission-audit.jsonl`,
        date: DATE,
        sha256: createHash("sha256").update(raw).digest("hex"),
        bytes: raw.byteLength,
        entries: 1,
      }],
    });
    expect(JSON.stringify(receipt)).not.toContain("entryHash");
    expect(JSON.stringify(receipt)).not.toContain(home);
  });

  it("rejects operation/effectDigest tampering even though the public file SHA changes cleanly", async () => {
    const { path } = await createValidAudit();
    const before = createHash("sha256").update(readFileSync(path)).digest("hex");
    const row = JSON.parse(readFileSync(path, "utf8")) as {
      workloadBrokerCorrelation: { operation: string; grant: { effectDigest: string } };
    };
    row.workloadBrokerCorrelation.operation = "file.write";
    row.workloadBrokerCorrelation.grant.effectDigest = "9".repeat(64);
    writeFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    const after = createHash("sha256").update(readFileSync(path)).digest("hex");
    expect(after).not.toBe(before);
    await expect(createPermissionAuditProof(CHALLENGE)).rejects.toThrow(/chain verification failed/);
  });

  it.each(["missing", "wrong"] as const)("rejects a %s daily seal", async (kind) => {
    const { seals } = await createValidAudit();
    const sealPath = join(home, "secrets", `${sealKeyName(DATE)}.safe-storage`);
    if (kind === "missing") unlinkSync(sealPath);
    else seals.write(sealKeyName(DATE), "0".repeat(64));
    await expect(createPermissionAuditProof(CHALLENGE)).rejects.toThrow(/seal is missing or invalid/);
  });

  it("rejects missing key or audit authority without creating a replacement", async () => {
    await createValidAudit();
    const secretsDir = join(home, "secrets");
    const authorityPath = join(secretsDir, "audit-hmac.key.safe-storage");
    unlinkSync(authorityPath);
    const before = readdirSync(secretsDir).sort();
    await expect(createPermissionAuditProof(CHALLENGE)).rejects.toThrow(/existing audit HMAC secret/);
    expect(readdirSync(secretsDir).sort()).toEqual(before);
    expect(existsSync(authorityPath)).toBe(false);

    vi.stubEnv("LVIS_SECRET_KEY_FILE", join(home, "missing-key"));
    await expect(createPermissionAuditProof(CHALLENGE)).rejects.toThrow();
    expect(readdirSync(secretsDir).sort()).toEqual(before);
  });

  it("rejects unexpected permission-audit names and symlinked canonical files", async () => {
    const { path } = await createValidAudit();
    const unexpected = join(home, "audit", `${DATE}.permission-audit.backup.jsonl`);
    writeFileSync(unexpected, "", { mode: 0o600 });
    await expect(createPermissionAuditProof(CHALLENGE)).rejects.toThrow(/unexpected permission audit file name/);
    unlinkSync(unexpected);
    const alias = join(home, "audit", "2026-09-19.permission-audit.jsonl");
    symlinkSync(path, alias);
    await expect(createPermissionAuditProof(CHALLENGE)).rejects.toThrow();
  });
});

describe("permission audit proof CLI contract", () => {
  it("accepts the challenge alone or with one user-data-dir", () => {
    expect(parsePermissionAuditProofCommand([`--verify-permission-audit=${CHALLENGE}`]))
      .toEqual({ challenge: CHALLENGE });
    expect(parsePermissionAuditProofCommand([
      `--verify-permission-audit=${CHALLENGE}`,
      "--user-data-dir=/tmp/lvis-proof",
    ])).toEqual({ challenge: CHALLENGE });
  });

  it.each([
    { argv: [`--verify-permission-audit=${"A".repeat(64)}`] },
    { argv: [`--verify-permission-audit=${CHALLENGE}`, "--runtime-check"] },
    { argv: [`--verify-permission-audit=${CHALLENGE}`, `--verify-permission-audit=${CHALLENGE}`] },
    { argv: [`--verify-permission-audit=${CHALLENGE}`, "--user-data-dir="] },
  ])("rejects invalid or mixed argv: $argv", ({ argv }) => {
    expect(() => parsePermissionAuditProofCommand(argv)).toThrow();
  });
});
