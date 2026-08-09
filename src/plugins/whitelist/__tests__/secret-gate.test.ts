/**
 * #955 follow-up — `runSecretGate` admin-install bypass.
 *
 * `installPolicy: "admin"` MUST skip only the Tier-3 signed whitelist
 * registry ACL while still enforcing the install-time manifest SHA pin and
 * Tier-4 active-vendor cross-check. Plain `"user"` installs keep the original
 * behaviour — both Tier-3 and Tier-4 apply in order.
 *
 * Tier-1/Tier-2 coverage lives with the two real callers
 * (`src/boot/steps/__tests__/plugin-runtime.test.ts`,
 * `src/main/host-api/__tests__/resolve-api-key.test.ts`); every case here
 * allowlists the requested key so the Tier-3/Tier-4 ordering is what is
 * under test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSecretGate } from "../secret-gate.js";
import type { SecretGateInput } from "../secret-gate.js";
import { whitelistRegistry } from "../whitelist-registry.js";
import { cleanupTmpDir } from "../../../testing/tmp-dir-teardown.js";

const tempCacheRoots: string[] = [];

afterEach(async () => {
  for (const root of tempCacheRoots.splice(0)) {
    await cleanupTmpDir(root);
  }
});

/** Ask the gate for `llm.apiKey.openai` with the key allowlisted. */
function gate(
  overrides: Partial<SecretGateInput> & { activeProvider: string },
): ReturnType<typeof runSecretGate> {
  const { activeProvider, ...rest } = overrides;
  return runSecretGate({
    pluginId: "meeting",
    key: "llm.apiKey.openai",
    allowlist: ["llm.apiKey.openai"],
    readSettings: () => ({
      llmProvider: activeProvider,
      marketplaceProviderPresetId: undefined,
      readInstalledProviderPresetIds: () => [],
    }),
    ...rest,
  });
}

describe("runSecretGate — admin-install bypass (#955)", () => {
  beforeEach(() => {
    // Leave the registry uninitialized — its default state is
    // `no-cache`, which makes `isAllowed` return a deny with reason
    // `not-whitelisted`. That is the exact production failure mode
    // admin-install is meant to bypass.
    whitelistRegistry.resetForTesting();
  });

  it("denies a user-install plugin when registry has no grant", () => {
    const outcome = gate({
      manifestSha256: "a".repeat(64),
      activeProvider: "openai",
      installPolicy: "user",
    });
    expect(outcome.kind).toBe("deny");
    if (outcome.kind === "deny") {
      expect(outcome.tier).toBe("tier-3");
    }
  });

  it("denies a user-install plugin with no installPolicy field (back-compat)", () => {
    const outcome = gate({
      manifestSha256: "a".repeat(64),
      activeProvider: "openai",
    });
    expect(outcome.kind).toBe("deny");
    if (outcome.kind === "deny") {
      expect(outcome.tier).toBe("tier-3");
    }
  });

  it("allows an admin-install plugin when the install-time manifest sha matches", () => {
    const manifestSha256 = "a".repeat(64);
    const outcome = gate({
      manifestSha256,
      installedManifestSha256: manifestSha256,
      activeProvider: "openai",
      installPolicy: "admin",
    });
    // #958 round-1 — the allow now carries `via: "admin-bypass"` so
    // callers can emit a dedicated audit line + counter for anomaly
    // detection. The plain-allow shape (no `via`) is reserved for the
    // non-admin path where every gate ran and passed.
    expect(outcome).toEqual({ kind: "allow", via: "admin-bypass" });
  });

  it("denies an admin-install plugin when the running manifest sha differs from install time (#959)", () => {
    const outcome = gate({
      manifestSha256: "b".repeat(64),
      installedManifestSha256: "a".repeat(64),
      activeProvider: "openai",
      installPolicy: "admin",
    });
    expect(outcome).toEqual({
      kind: "deny",
      tier: "tier-3",
      reason: "manifest-sha-mismatch",
    });
  });

  it("denies an admin-install plugin when the install-time manifest sha is absent (#959)", () => {
    const outcome = gate({
      manifestSha256: "a".repeat(64),
      activeProvider: "openai",
      installPolicy: "admin",
    });
    expect(outcome).toEqual({
      kind: "deny",
      tier: "tier-3",
      reason: "manifest-sha-mismatch",
    });
  });

  it("emits via='admin-bypass' on the allow outcome (#958)", () => {
    const manifestSha256 = "a".repeat(64);
    const outcome = gate({
      manifestSha256,
      installedManifestSha256: manifestSha256,
      activeProvider: "openai",
      installPolicy: "admin",
    });
    expect(outcome.kind).toBe("allow");
    if (outcome.kind === "allow") {
      expect(outcome.via).toBe("admin-bypass");
    }
  });

  it("omits `via` on a regular non-admin allow (#958)", async () => {
    // Seed a grant for the plugin so Tier-3 passes the registry check;
    // installPolicy is left as `"user"` so the admin-bypass branch is
    // not taken. Result: plain allow with `via` undefined — the audit
    // trail can therefore distinguish "all gates ran" from "Tier-3
    // skipped".
    const { generateKeyPairSync, sign, createHash } = await import("node:crypto");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { WhitelistCache } = await import("../whitelist-cache.js");
    const { WHITELIST_PRIMARY_KEY_ID } = await import("../../marketplace-keys.js");

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const rawPub = publicKey.export({ type: "spki", format: "der" }).slice(-32);
    whitelistRegistry.setPublicKeysForTesting({
      [WHITELIST_PRIMARY_KEY_ID]: rawPub.toString("base64"),
    });
    const manifestSha = "b".repeat(64);
    const doc = {
      version: 1,
      schemaVersion: 1,
      issuedAt: "2026-05-17T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      pluginGrants: {
        meeting: {
          publisher: "test",
          hostSecrets: { read: ["llm.apiKey.openai"] },
          approvedManifestSha256: manifestSha,
        },
      },
    };
    const body = JSON.stringify(doc);
    const sigBytes = sign(null, Buffer.from(body, "utf-8"), privateKey);
    const envelope = {
      version: 1,
      iat: Math.floor(Date.now() / 1000),
      artifact_sha256: createHash("sha256")
        .update(Buffer.from(body, "utf-8"))
        .digest("hex"),
      signatures: [
        {
          key_id: WHITELIST_PRIMARY_KEY_ID,
          alg: "ed25519",
          sig: sigBytes.toString("base64"),
        },
      ],
    };
    const cacheRoot = mkdtempSync(join(tmpdir(), "lvis-secret-gate-"));
    tempCacheRoots.push(cacheRoot);
    const cache = new WhitelistCache(cacheRoot);
    await cache.store({
      body,
      signature: JSON.stringify(envelope),
      meta: { highestSeenIssuedAt: doc.issuedAt },
    });
    await whitelistRegistry.init({
      userDataDir: cacheRoot,
      online: false,
      now: () => Date.parse("2026-05-18T00:00:00.000Z"),
    });
    const outcome = gate({
      manifestSha256: manifestSha,
      activeProvider: "openai",
      installPolicy: "user",
    });
    expect(outcome.kind).toBe("allow");
    if (outcome.kind === "allow") {
      expect(outcome.via).toBeUndefined();
    }
  });

  it("denies an admin-install plugin on vendor mismatch (Tier-4 preserved)", () => {
    const manifestSha256 = "a".repeat(64);
    const outcome = gate({
      manifestSha256,
      installedManifestSha256: manifestSha256,
      activeProvider: "claude",
      installPolicy: "admin",
    });
    expect(outcome.kind).toBe("deny");
    if (outcome.kind === "deny") {
      expect(outcome.tier).toBe("tier-4");
      expect(outcome.reason).toBe("vendor-mismatch");
    }
  });
});
