/**
 * #955 follow-up — `runTier3Then4` admin-install bypass.
 *
 * `installPolicy: "admin"` MUST skip the Tier-3 signed whitelist registry
 * ACL (admin install already represents an explicit elevated grant) while
 * still enforcing Tier-4 active-vendor cross-check. Plain `"user"` installs
 * keep the original behaviour — both Tier-3 and Tier-4 apply in order.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { runTier3Then4 } from "../tier-order.js";
import { whitelistRegistry } from "../whitelist-registry.js";

describe("runTier3Then4 — admin-install bypass (#955)", () => {
  beforeEach(() => {
    // Leave the registry uninitialized — its default state is
    // `no-cache`, which makes `isAllowed` return a deny with reason
    // `not-whitelisted`. That is the exact production failure mode
    // admin-install is meant to bypass.
    whitelistRegistry.resetForTesting();
  });

  it("denies a user-install plugin when registry has no grant", () => {
    const outcome = runTier3Then4({
      pluginId: "meeting",
      key: "llm.apiKey.openai",
      manifestSha256: "a".repeat(64),
      vendor: "openai",
      activeProvider: "openai",
      installPolicy: "user",
    });
    expect(outcome.kind).toBe("deny");
    if (outcome.kind === "deny") {
      expect(outcome.tier).toBe("tier-3");
    }
  });

  it("denies a user-install plugin with no installPolicy field (back-compat)", () => {
    const outcome = runTier3Then4({
      pluginId: "meeting",
      key: "llm.apiKey.openai",
      manifestSha256: "a".repeat(64),
      vendor: "openai",
      activeProvider: "openai",
    });
    expect(outcome.kind).toBe("deny");
    if (outcome.kind === "deny") {
      expect(outcome.tier).toBe("tier-3");
    }
  });

  it("allows an admin-install plugin even when registry would deny", () => {
    const outcome = runTier3Then4({
      pluginId: "meeting",
      key: "llm.apiKey.openai",
      manifestSha256: "a".repeat(64),
      vendor: "openai",
      activeProvider: "openai",
      installPolicy: "admin",
    });
    // #958 round-1 — the allow now carries `via: "admin-bypass"` so
    // callers can emit a dedicated audit line + counter for anomaly
    // detection. The plain-allow shape (no `via`) is reserved for the
    // non-admin path where every gate ran and passed.
    expect(outcome).toEqual({ kind: "allow", via: "admin-bypass" });
  });

  it("emits via='admin-bypass' on the allow outcome (#958)", () => {
    const outcome = runTier3Then4({
      pluginId: "meeting",
      key: "llm.apiKey.openai",
      manifestSha256: "a".repeat(64),
      vendor: "openai",
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
    const cacheRoot = mkdtempSync(join(tmpdir(), "lvis-tier-order-"));
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
    const outcome = runTier3Then4({
      pluginId: "meeting",
      key: "llm.apiKey.openai",
      manifestSha256: manifestSha,
      vendor: "openai",
      activeProvider: "openai",
      installPolicy: "user",
    });
    expect(outcome.kind).toBe("allow");
    if (outcome.kind === "allow") {
      expect(outcome.via).toBeUndefined();
    }
  });

  it("denies an admin-install plugin on vendor mismatch (Tier-4 preserved)", () => {
    const outcome = runTier3Then4({
      pluginId: "meeting",
      key: "llm.apiKey.openai",
      manifestSha256: "a".repeat(64),
      vendor: "openai",
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
