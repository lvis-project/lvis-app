/**
 * #893 Ralph cycle 1 HIGH — unit tests for the host implementation of
 * `hostApi.resolveApiKey()`. Mirrors the 4-tier secret gate inside
 * `plugin-runtime.ts:getSecret` and exercises every refusal branch + the
 * Ralph cycle 1 fixes:
 *   - signal.aborted at entry → reason="aborted"
 *   - own-namespace (Tier-1) short-circuit
 *   - manifest allowlist (Tier-2) miss → reason="not-whitelisted"
 *   - whitelist registry (Tier-3) deny passthrough
 *   - vendor cross-check (Tier-4) deny — runs AFTER Tier-3 (cycle 1 MEDIUM)
 *   - success path: bearer + release() lifetime, signal-bound release
 *   - vendor alias normalization (SDK "anthropic" → host "claude")
 *   - azure-foundry baseUrl resolution
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApiKey } from "../resolve-api-key.js";
import { whitelistRegistry } from "../../../plugins/whitelist/whitelist-registry.js";
import { WhitelistCache } from "../../../plugins/whitelist/whitelist-cache.js";
import { canonicalJSON } from "../../../plugins/whitelist/canonical-json.js";
import { WHITELIST_PRIMARY_KEY_ID } from "../../../plugins/marketplace-keys.js";
import { resetHostSecretCountersForTesting } from "../../../telemetry/host-secret-counters.js";
import type { SignatureEnvelope } from "../../../plugins/types.js";
import type { PluginManifest } from "../../../plugins/types.js";

// -------- helpers --------

function freshTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

let testPrivateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];

interface SeedOpts {
  pluginId: string;
  allowedKeys: string[];
  manifestSha256: string;
  // Tier-3 signature key swap is global to the registry singleton.
}

async function seedRegistryWithGrant(opts: SeedOpts): Promise<void> {
  whitelistRegistry.resetForTesting();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ type: "spki", format: "der" }).slice(-32);
  testPrivateKey = privateKey;
  whitelistRegistry.setPublicKeysForTesting({
    [WHITELIST_PRIMARY_KEY_ID]: rawPub.toString("base64"),
  });

  const doc = {
    version: 1,
    schemaVersion: 1,
    issuedAt: "2026-05-17T00:00:00.000Z",
    expiresAt: "2030-01-01T00:00:00.000Z",
    pluginGrants: {
      [opts.pluginId]: {
        publisher: "test",
        hostSecrets: { read: opts.allowedKeys },
        approvedManifestSha256: opts.manifestSha256,
      },
    },
  };
  const body = JSON.stringify(doc);
  const sigBytes = sign(null, Buffer.from(body, "utf-8"), testPrivateKey);
  const envelope: SignatureEnvelope = {
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

  const cacheRoot = freshTmpDir("lvis-resolve-api-key-");
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
}

function manifestFor(pluginId: string, allowedKeys: string[]): PluginManifest {
  return {
    id: pluginId,
    name: pluginId,
    version: "0.0.0",
    entry: "index.js",
    description: "test fixture",
    tools: [],
    hostSecrets: { read: allowedKeys },
  } as PluginManifest;
}

function shaOfManifest(manifest: PluginManifest): string {
  // Mirror what `plugin-runtime.ts` produces — same canonicalJSON helper
  // so the Tier-3 manifest-sha pin matches.
  return createHash("sha256").update(canonicalJSON(manifest)).digest("hex");
}

function makeAuditLogger() {
  const log = vi.fn();
  return { log, mock: log };
}

interface SettingsOverrides {
  provider: string;
  secrets?: Record<string, string | null>;
  baseUrl?: string;
}

function makeSettingsService(overrides: SettingsOverrides) {
  return {
    get: vi.fn((key: string) => {
      if (key === "llm") {
        return {
          provider: overrides.provider,
          vendors: {
            "azure-foundry": overrides.baseUrl
              ? { baseUrl: overrides.baseUrl }
              : {},
          },
        };
      }
      return undefined;
    }),
    getSecret: vi.fn((key: string) => overrides.secrets?.[key] ?? null),
  };
}

// -------- tests --------

beforeEach(() => {
  resetHostSecretCountersForTesting();
  whitelistRegistry.resetForTesting();
});

describe("resolveApiKey — signal.aborted at entry", () => {
  it("returns reason=aborted before touching settings", async () => {
    const ac = new AbortController();
    ac.abort();
    const manifest = manifestFor("p", []);
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai", signal: ac.signal },
      {
        pluginId: "p",
        manifest,
        settingsService: makeSettingsService({ provider: "openai" }) as never,
        auditLogger: makeAuditLogger(),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("aborted");
  });
});

describe("resolveApiKey — Tier-1 own-namespace short-circuit", () => {
  it("returns ok=true when plugin.<id>.llm.apiKey.<vendor> is set in settings", async () => {
    const manifest = manifestFor("plugin-x", []);
    const settings = makeSettingsService({
      provider: "openai",
      secrets: { "plugin.plugin-x.llm.apiKey.openai": "sk-own-namespace" },
    });
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: "plugin-x",
        manifest,
        settingsService: settings as never,
        auditLogger: makeAuditLogger(),
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bearer()).toBe("sk-own-namespace");
      expect(result.vendor).toBe("openai");
    }
  });

  it("rejects URL-shaped values in plugin-owned llm api keys before returning a bearer", async () => {
    const manifest = manifestFor("plugin-x", []);
    const audit = makeAuditLogger();
    const settings = makeSettingsService({
      provider: "openai",
      secrets: { "plugin.plugin-x.llm.apiKey.openai": "https://example.openai.azure.com/openai/deployments/stt/audio/transcriptions" },
    });

    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: "plugin-x",
        manifest,
        settingsService: settings as never,
        auditLogger: audit,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-host-vendor");
    expect(audit.mock).toHaveBeenCalledWith(expect.objectContaining({
      type: "warn",
      input: expect.stringContaining("endpoint-url-in-api-key-like-secret"),
    }));
  });
});
describe("resolveApiKey — Tier-2 manifest allowlist miss", () => {
  it("returns reason=not-whitelisted when llm.apiKey.<vendor> not in hostSecrets.read", async () => {
    const manifest = manifestFor("p", []); // no allowlist entries
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: "p",
        manifest,
        settingsService: makeSettingsService({ provider: "openai" }) as never,
        auditLogger: makeAuditLogger(),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-whitelisted");
  });
});

describe("resolveApiKey — Tier-3 whitelist registry deny passthrough", () => {
  it("returns reason=not-whitelisted when registry denies (plugin absent from grants)", async () => {
    // Seed registry with a grant for OTHER plugin so this plugin is absent.
    const manifest = manifestFor("p", ["llm.apiKey.openai"]);
    const manifestSha256 = shaOfManifest(manifest);
    await seedRegistryWithGrant({
      pluginId: "other",
      allowedKeys: ["llm.apiKey.openai"],
      manifestSha256: "a".repeat(64),
    });
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: "p",
        manifest,
        manifestSha256,
        settingsService: makeSettingsService({
          provider: "openai",
          secrets: { "llm.apiKey.openai": "sk-host" },
        }) as never,
        auditLogger: makeAuditLogger(),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-whitelisted");
  });
});

describe("resolveApiKey — Tier-3 BEFORE Tier-4 ordering (cycle 1 MEDIUM)", () => {
  it("unwhitelisted plugin denied with not-whitelisted even when vendor mismatches", async () => {
    // Plugin is NOT in the whitelist grants AND vendor mismatches active.
    // Tier-3 must surface first (not-whitelisted), not the vendor-mismatch
    // leak that would tell the plugin which vendor is active.
    const manifest = manifestFor("p", ["llm.apiKey.openai"]);
    const manifestSha256 = shaOfManifest(manifest);
    await seedRegistryWithGrant({
      pluginId: "other",
      allowedKeys: ["llm.apiKey.openai"],
      manifestSha256: "a".repeat(64),
    });
    const result = await resolveApiKey(
      // plugin asks for openai but active is claude → vendor-mismatch.
      // Whitelist also denies → tier-3 should win.
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: "p",
        manifest,
        manifestSha256,
        settingsService: makeSettingsService({
          provider: "claude",
          secrets: { "llm.apiKey.openai": "sk-host" },
        }) as never,
        auditLogger: makeAuditLogger(),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-whitelisted");
  });
});

describe("resolveApiKey — Tier-4 vendor mismatch", () => {
  it("returns vendor-mismatch when plugin allowlisted but vendor != active", async () => {
    const manifest = manifestFor("p", ["llm.apiKey.openai"]);
    const manifestSha256 = shaOfManifest(manifest);
    await seedRegistryWithGrant({
      pluginId: "p",
      allowedKeys: ["llm.apiKey.openai"],
      manifestSha256,
    });
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: "p",
        manifest,
        manifestSha256,
        // Active vendor is claude → vendor-mismatch on requested openai.
        settingsService: makeSettingsService({ provider: "claude" }) as never,
        auditLogger: makeAuditLogger(),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("vendor-mismatch");
  });
});

describe("resolveApiKey — success: release() lifetime", () => {
  it("bearer throws after release", async () => {
    const manifest = manifestFor("p", ["llm.apiKey.openai"]);
    await seedRegistryWithGrant({
      pluginId: "p",
      allowedKeys: ["llm.apiKey.openai"],
      manifestSha256: shaOfManifest(manifest),
    });
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: "p",
        manifest,
        manifestSha256: shaOfManifest(manifest),
        settingsService: makeSettingsService({
          provider: "openai",
          secrets: { "llm.apiKey.openai": "sk-host" },
        }) as never,
        auditLogger: makeAuditLogger(),
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bearer()).toBe("sk-host");
      result.release();
      expect(() => result.bearer()).toThrow("released");
    }
  });
});

describe("resolveApiKey — signal aborts mid-flight (cycle 1 HIGH)", () => {
  it("signal abort after resolve fires automatic release", async () => {
    const ac = new AbortController();
    const manifest = manifestFor("p", ["llm.apiKey.openai"]);
    await seedRegistryWithGrant({
      pluginId: "p",
      allowedKeys: ["llm.apiKey.openai"],
      manifestSha256: shaOfManifest(manifest),
    });
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai", signal: ac.signal },
      {
        pluginId: "p",
        manifest,
        manifestSha256: shaOfManifest(manifest),
        settingsService: makeSettingsService({
          provider: "openai",
          secrets: { "llm.apiKey.openai": "sk-host" },
        }) as never,
        auditLogger: makeAuditLogger(),
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bearer()).toBe("sk-host");
      ac.abort();
      // Abort fires the signal listener → release() runs → bearer throws.
      expect(() => result.bearer()).toThrow("released");
    }
  });
});

describe("resolveApiKey — vendor alias normalization (cycle 1 CRITICAL)", () => {
  it("SDK vendor='anthropic' resolves against host activeProvider='claude'", async () => {
    const manifest = manifestFor("p", ["llm.apiKey.claude"]);
    await seedRegistryWithGrant({
      pluginId: "p",
      allowedKeys: ["llm.apiKey.claude"],
      manifestSha256: shaOfManifest(manifest),
    });
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "anthropic" }, // SDK enum name
      {
        pluginId: "p",
        manifest,
        manifestSha256: shaOfManifest(manifest),
        settingsService: makeSettingsService({
          provider: "claude", // host vendor name
          secrets: { "llm.apiKey.claude": "sk-claude" },
        }) as never,
        auditLogger: makeAuditLogger(),
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.vendor).toBe("claude");
      expect(result.bearer()).toBe("sk-claude");
    }
  });

  it("SDK vendor='vertex' normalizes to host 'vertex-ai'", async () => {
    const manifest = manifestFor("p", ["llm.apiKey.vertex-ai"]);
    await seedRegistryWithGrant({
      pluginId: "p",
      allowedKeys: ["llm.apiKey.vertex-ai"],
      manifestSha256: shaOfManifest(manifest),
    });
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "vertex" },
      {
        pluginId: "p",
        manifest,
        manifestSha256: shaOfManifest(manifest),
        settingsService: makeSettingsService({
          provider: "vertex-ai",
          secrets: { "llm.apiKey.vertex-ai": "sk-vertex" },
        }) as never,
        auditLogger: makeAuditLogger(),
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.vendor).toBe("vertex-ai");
  });

  it("vendor cross-check uses normalized host vendor name", async () => {
    // SDK 'azure-openai' → 'azure-foundry'. activeProvider = 'azure-foundry' →
    // should match (no mismatch). Conversely if activeProvider is anything
    // else, vendor-mismatch fires under the normalized name.
    const manifest = manifestFor("p", ["llm.apiKey.azure-foundry"]);
    await seedRegistryWithGrant({
      pluginId: "p",
      allowedKeys: ["llm.apiKey.azure-foundry"],
      manifestSha256: shaOfManifest(manifest),
    });
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "azure-openai" },
      {
        pluginId: "p",
        manifest,
        manifestSha256: shaOfManifest(manifest),
        settingsService: makeSettingsService({
          provider: "azure-foundry",
          secrets: { "llm.apiKey.azure-foundry": "sk-azure" },
          baseUrl: "https://my-region.openai.azure.com",
        }) as never,
        auditLogger: makeAuditLogger(),
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.vendor).toBe("azure-foundry");
      expect(result.baseUrl).toBe("https://my-region.openai.azure.com");
    }
  });
});

describe("resolveApiKey — permission revoke fires release() on outstanding bearer (cluster M1)", () => {
  it("permission revoke signal abort fires release() on outstanding bearer", async () => {
    // Simulate the boot wiring: a per-plugin revoke controller owned by
    // PermissionManager. The host-api merges it with the caller's signal
    // via AbortSignal.any so the bearer aborts on either source.
    const revokeController = new AbortController();
    const manifest = manifestFor("p", ["llm.apiKey.openai"]);
    await seedRegistryWithGrant({
      pluginId: "p",
      allowedKeys: ["llm.apiKey.openai"],
      manifestSha256: shaOfManifest(manifest),
    });
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: "p",
        manifest,
        manifestSha256: shaOfManifest(manifest),
        settingsService: makeSettingsService({
          provider: "openai",
          secrets: { "llm.apiKey.openai": "sk-host" },
        }) as never,
        auditLogger: makeAuditLogger(),
        getPluginRevokeSignal: () => revokeController.signal,
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bearer()).toBe("sk-host");
      // PermissionManager.revokePluginAccess(...) would fire this:
      revokeController.abort(new Error("permission-revoked: deny-rule-added"));
      // The bearer is released → next read throws per SDK contract.
      expect(() => result.bearer()).toThrow("released");
    }
  });

  it("returns reason=aborted when revoke signal is pre-aborted before entry", async () => {
    const revokeController = new AbortController();
    revokeController.abort(new Error("permission-revoked: pre-aborted"));
    const manifest = manifestFor("p", []);
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: "p",
        manifest,
        settingsService: makeSettingsService({ provider: "openai" }) as never,
        auditLogger: makeAuditLogger(),
        getPluginRevokeSignal: () => revokeController.signal,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("aborted");
  });
});

describe("resolveApiKey — baseUrl present on azure-foundry success", () => {
  it("baseUrl threaded from llm.vendors['azure-foundry'].baseUrl", async () => {
    const manifest = manifestFor("p", ["llm.apiKey.azure-foundry"]);
    await seedRegistryWithGrant({
      pluginId: "p",
      allowedKeys: ["llm.apiKey.azure-foundry"],
      manifestSha256: shaOfManifest(manifest),
    });
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "azure-openai" },
      {
        pluginId: "p",
        manifest,
        manifestSha256: shaOfManifest(manifest),
        settingsService: makeSettingsService({
          provider: "azure-foundry",
          secrets: { "llm.apiKey.azure-foundry": "sk-az" },
          baseUrl: "https://foo.bar/",
        }) as never,
        auditLogger: makeAuditLogger(),
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.baseUrl).toBe("https://foo.bar/");
    }
  });
});

describe("resolveApiKey — registry.installSource precedence (#958 round-1)", () => {
  it("registry.installSource='admin' triggers Tier-3 bypass even when manifest.installPolicy='user'", async () => {
    // Setup: plugin's manifest says `"user"` (so Tier-3 should normally
    // run and deny — the registry holds no grant), but the host-verified
    // registry entry was recorded with `installSource:"admin"`. With the
    // round-1 fix the registry value MUST win — Tier-3 is bypassed and
    // the secret is returned.
    const manifest = manifestFor("p", ["llm.apiKey.openai"]);
    // Note: NO `seedRegistryWithGrant` call — the whitelist registry has
    // no grant for this plugin. Without admin-bypass Tier-3 would deny.
    const manifestSha256 = shaOfManifest(manifest);
    const auditLogger = makeAuditLogger();
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: "p",
        manifest, // manifest.installPolicy === undefined (~"user")
        manifestSha256,
        settingsService: makeSettingsService({
          provider: "openai",
          secrets: { "llm.apiKey.openai": "sk-admin-host" },
        }) as never,
        auditLogger,
        // Host-verified install record: admin install.
        registryInstallSource: "admin",
        registryManifestSha256: manifestSha256,
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bearer()).toBe("sk-admin-host");
    }
    // Audit trail records the bypass with the registry source.
    const bypassLine = auditLogger.mock.mock.calls.find((c) =>
      String(c[0]?.input ?? "").includes("policy=admin manifest-allowlist-bypassed"),
    );
    expect(bypassLine).toBeDefined();
    expect(String(bypassLine?.[0]?.input ?? "")).toContain(
      "source=registry.installSource",
    );
  });

  it("registry.installSource='admin' denies when registry manifest sha differs (#959)", async () => {
    const manifest = manifestFor("p", ["llm.apiKey.openai"]);
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: "p",
        manifest,
        manifestSha256: shaOfManifest(manifest),
        registryManifestSha256: "f".repeat(64),
        settingsService: makeSettingsService({
          provider: "openai",
          secrets: { "llm.apiKey.openai": "sk-admin-host" },
        }) as never,
        auditLogger: makeAuditLogger(),
        registryInstallSource: "admin",
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-whitelisted");
  });

  it("registry.installSource='user' overrides a malicious manifest.installPolicy='admin'", async () => {
    // The attack: a malicious post-install patch flips `plugin.json` to
    // `"installPolicy":"admin"` to inherit Tier-3 bypass. The registry
    // still holds the verified `"user"` record. With the round-1 fix
    // the registry wins and the plugin is denied (no whitelist grant).
    const manifest = {
      ...manifestFor("p", ["llm.apiKey.openai"]),
      installPolicy: "admin" as const,
    };
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: "p",
        manifest,
        manifestSha256: shaOfManifest(manifest),
        settingsService: makeSettingsService({
          provider: "openai",
          secrets: { "llm.apiKey.openai": "sk-host" },
        }) as never,
        auditLogger: makeAuditLogger(),
        registryInstallSource: "user",
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-whitelisted");
  });

  it("denies manifest-only admin bypass when registry manifest sha is absent (#959)", async () => {
    // Admin secret-access bypass now requires the host-owned install-time
    // manifest SHA. A manifest-only admin signal is not enough to skip Tier-3.
    const manifest = {
      ...manifestFor("p", ["llm.apiKey.openai"]),
      installPolicy: "admin" as const,
    };
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: "p",
        manifest,
        manifestSha256: shaOfManifest(manifest),
        settingsService: makeSettingsService({
          provider: "openai",
          secrets: { "llm.apiKey.openai": "sk-host" },
        }) as never,
        auditLogger: makeAuditLogger(),
        // registry fields deliberately omitted.
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-whitelisted");
  });

  it("emits hostSecret_admin_bypass counter on admin-bypass success", async () => {
    const { getHostSecretCounter } = await import(
      "../../../telemetry/host-secret-counters.js"
    );
    const manifest = manifestFor("p", ["llm.apiKey.openai"]);
    const manifestSha256 = shaOfManifest(manifest);
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: "p",
        manifest,
        manifestSha256,
        settingsService: makeSettingsService({
          provider: "openai",
          secrets: { "llm.apiKey.openai": "sk-admin" },
        }) as never,
        auditLogger: makeAuditLogger(),
        registryInstallSource: "admin",
        registryManifestSha256: manifestSha256,
      },
    );
    expect(result.ok).toBe(true);
    expect(getHostSecretCounter("hostSecret_admin_bypass", "p", "llm")).toBe(1);
    // The regular read counter is incremented on top, so totals stay
    // comparable across bypass and non-bypass paths.
    expect(getHostSecretCounter("hostSecret_read", "p", "llm")).toBe(1);
  });

  it("does not emit admin-bypass audit when registry manifest sha is absent (#959)", async () => {
    const manifest = {
      ...manifestFor("p", ["llm.apiKey.openai"]),
      installPolicy: "admin" as const,
    };
    const auditLogger = makeAuditLogger();
    const result = await resolveApiKey(
      { purpose: "llm", vendor: "openai" },
      {
        pluginId: "p",
        manifest,
        manifestSha256: shaOfManifest(manifest),
        settingsService: makeSettingsService({
          provider: "openai",
          secrets: { "llm.apiKey.openai": "sk-x" },
        }) as never,
        auditLogger,
        // registry fields omitted → manifest-only admin signal denied.
      },
    );
    expect(result.ok).toBe(false);
    const bypassLine = auditLogger.mock.mock.calls.find((c) =>
      String(c[0]?.input ?? "").includes("policy=admin manifest-allowlist-bypassed"),
    );
    expect(bypassLine).toBeUndefined();
  });
});
