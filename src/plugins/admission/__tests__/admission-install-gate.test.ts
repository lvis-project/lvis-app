/**
 * Install-path enforcement tests for the admission catalog.
 *
 * These drive `PluginArtifactStore.downloadVerifiedArtifact` — the single
 * artifact install path — and assert what it does when the catalog cannot
 * authorise the artifact. The registry, its schema validator, `verifyEnvelope`,
 * the disk cache and the HTTP fetcher are all the production implementations
 * running against a real origin and real ed25519 signatures.
 *
 * ONE thing is overridden: `ADMISSION_ENFORCEMENT`, which ships as `"observe"`
 * because the trust anchor and the first issued catalog are operator-provisioned
 * and do not exist yet. Everything the gate decides is identical in both modes;
 * the constant only selects whether the install path throws. The last suite
 * here asserts the shipped default with no override at all, so both behaviours
 * are covered by execution rather than by assumption.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanupTmpDir } from "../../../testing/tmp-dir-teardown.js";
import { signEnvelopeFixture } from "../../../testing/sign-envelope-fixture.js";
import { PluginNotAdmittedError } from "../../../shared/plugin-install-result.js";
import type { MarketplaceFetcher } from "../../marketplace-fetcher.js";
import type { PluginMarketplaceItem, SignatureEnvelope } from "../../types.js";

vi.mock("../admission-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../admission-registry.js")>();
  // Only the rollout switch is replaced. `admissionRegistry` is the real
  // singleton, so the tests below and the code under test share one instance.
  return { ...actual, ADMISSION_ENFORCEMENT: "enforce" as const };
});

const { PluginArtifactStore } = await import("../../plugin-artifact-store.js");
const { admissionRegistry } = await import("../admission-registry.js");

const ANCHOR_KEY_ID = "admission-v1";
const ARTIFACT_KEY_ID = "prod-v1";
const NOW = Date.parse("2026-08-19T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const ARTIFACT_BYTES = Buffer.from("a marketplace artifact's bytes", "utf-8");
const ARTIFACT_SHA256 = createHash("sha256").update(ARTIFACT_BYTES).digest("hex");

let admissionKey: KeyObject;
let admissionAnchorB64: string;
let artifactKey: KeyObject;
let artifactAnchorB64: string;

let server: Server;
let baseUrl: string;
let routes: Map<string, { status: number; body: string }>;
let downloadCalls: string[];

const tempRoots: string[] = [];
function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function catalogBody(opts: {
  issuedAtMs?: number;
  expiresAtMs?: number;
  sha256?: string;
  version?: string;
}): string {
  const issuedAtMs = opts.issuedAtMs ?? NOW - HOUR;
  return JSON.stringify({
    version: 1,
    schemaVersion: 1,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(opts.expiresAtMs ?? issuedAtMs + 24 * HOUR).toISOString(),
    admissions: [
      {
        slug: "meeting",
        version: opts.version ?? "1.2.3",
        artifactSha256: opts.sha256 ?? ARTIFACT_SHA256,
        publisher: "lvis-project",
        admittedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
  });
}

function serveCatalog(body: string): void {
  routes.set("/v1/admission.json", { status: 200, body });
  routes.set("/v1/admission.json.sig", {
    status: 200,
    body: signEnvelopeFixture(body, admissionKey, ANCHOR_KEY_ID),
  });
}

/** A fetcher that serves the signed artifact and records every download attempt. */
function makeFetcher(): MarketplaceFetcher {
  return {
    listPlugins: async () => [],
    getPluginDetail: async () => null,
    downloadVersion: async () => ({ zipBuffer: Buffer.alloc(0), sha256: "x" }),
    listAnnouncements: async () => [],
    downloadArtifact: async (slug: string, version: string) => {
      downloadCalls.push(`${slug}@${version}`);
      return { body: ARTIFACT_BYTES, sha256Header: ARTIFACT_SHA256, status: 200 };
    },
    fetchSignatureEnvelope: async (): Promise<SignatureEnvelope> => ({
      version: 1,
      iat: Math.floor(NOW / 1000),
      artifact_sha256: ARTIFACT_SHA256,
      signatures: [
        {
          key_id: ARTIFACT_KEY_ID,
          alg: "ed25519",
          sig: edSign(null, ARTIFACT_BYTES, artifactKey).toString("base64"),
        },
      ],
    }),
  } as unknown as MarketplaceFetcher;
}

function makeStore() {
  const tmpDir = freshDir("lvis-admission-install-");
  return new PluginArtifactStore({
    installRoot: resolve(tmpDir, "installed"),
    cacheRoot: resolve(tmpDir, "cache"),
    fetcher: makeFetcher(),
    publicKeys: { [ARTIFACT_KEY_ID]: artifactAnchorB64 },
    tarballCacheBase: null,
  });
}

const PLUGIN: PluginMarketplaceItem = {
  id: "meeting",
  slug: "meeting",
  name: "Meeting",
  version: "1.2.3",
  artifactSha256: ARTIFACT_SHA256,
} as unknown as PluginMarketplaceItem;

async function initRegistry(now = NOW): Promise<void> {
  await admissionRegistry.init({
    userDataDir: freshDir("lvis-admission-cache-"),
    online: true,
    now: () => now,
    source: {
      primaryBase: `${baseUrl}/v1`,
      fallbackBase: `${baseUrl}/fallback`,
      docFilename: "admission.json",
      sigFilename: "admission.json.sig",
    },
  });
}

beforeEach(async () => {
  admissionRegistry.resetForTesting();
  const admissionPair = generateKeyPairSync("ed25519");
  admissionKey = admissionPair.privateKey;
  admissionAnchorB64 = admissionPair.publicKey
    .export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("base64");
  admissionRegistry.setPublicKeysForTesting({ [ANCHOR_KEY_ID]: admissionAnchorB64 });

  const artifactPair = generateKeyPairSync("ed25519");
  artifactKey = artifactPair.privateKey;
  artifactAnchorB64 = artifactPair.publicKey
    .export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("base64");

  downloadCalls = [];
  routes = new Map();
  server = createServer((req, res) => {
    const route = routes.get(req.url ?? "");
    if (!route) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(route.status, { "content-type": "application/json" }).end(route.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

afterAll(async () => {
  for (const root of tempRoots) await cleanupTmpDir(root);
});

describe("install path — admits", () => {
  it("downloads and verifies when the catalog admits the exact bytes", async () => {
    serveCatalog(catalogBody({}));
    await initRegistry();

    const verified = await makeStore().downloadVerifiedArtifact(PLUGIN, "1.2.3");

    expect(verified.artifactSha256).toBe(ARTIFACT_SHA256);
    expect(verified.signerKeyId).toBe(ARTIFACT_KEY_ID);
    expect(verified.admission).toEqual({
      issuedAt: new Date(NOW - HOUR).toISOString(),
      documentSha256: createHash("sha256")
        .update(Buffer.from(catalogBody({}), "utf-8"))
        .digest("hex"),
      publisher: "lvis-project",
    });
    expect(downloadCalls).toEqual(["meeting@1.2.3"]);
  });

  it("cross-checks a pinned prior-version install against the signed hash", async () => {
    // The catalog row carries no per-version hash, so the pre-catalog path had
    // nothing to compare a rollback install against. The signed row does.
    serveCatalog(catalogBody({ version: "0.9.0" }));
    await initRegistry();
    const pinned = { ...PLUGIN, version: "1.2.3" } as PluginMarketplaceItem;

    const verified = await makeStore().downloadVerifiedArtifact(pinned, "0.9.0");
    expect(verified.artifactSha256).toBe(ARTIFACT_SHA256);
  });

  it("fails a pinned install whose bytes differ from the signed row — previously uncheckable", async () => {
    serveCatalog(catalogBody({ version: "0.9.0", sha256: "e".repeat(64) }));
    await initRegistry();
    const pinned = { ...PLUGIN, version: "1.2.3" } as PluginMarketplaceItem;

    // The catalog row offers no hash for a non-latest version, so this reaches
    // the installer with the SIGNED hash and fails there on the bytes.
    await expect(makeStore().downloadVerifiedArtifact(pinned, "0.9.0")).rejects.toThrow(
      /CATALOG_SHA256_MISMATCH|marketplace artifact sha mismatch/,
    );
    expect(downloadCalls).toEqual(["meeting@0.9.0"]);
  });
});

describe("install path — refuses, before any bytes move", () => {
  async function expectRefusal(code: string): Promise<void> {
    const err = await makeStore()
      .downloadVerifiedArtifact(PLUGIN, "1.2.3")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginNotAdmittedError);
    expect((err as PluginNotAdmittedError).refusalCode).toBe(code);
    // The gate runs before the download, so a refusal costs no artifact bytes.
    expect(downloadCalls).toEqual([]);
  }

  it("refuses when the catalog is missing", async () => {
    await initRegistry();
    await expectRefusal("admission-unavailable");
  });

  it("refuses when the catalog is stale", async () => {
    const issuedAtMs = NOW - 30 * HOUR;
    serveCatalog(catalogBody({ issuedAtMs, expiresAtMs: issuedAtMs + 24 * HOUR }));
    await initRegistry();
    await expectRefusal("admission-stale");
  });

  it("refuses when the catalog body is unparseable", async () => {
    const truncated = catalogBody({}).slice(0, 90);
    routes.set("/v1/admission.json", { status: 200, body: truncated });
    routes.set("/v1/admission.json.sig", {
      status: 200,
      body: signEnvelopeFixture(truncated, admissionKey, ANCHOR_KEY_ID),
    });
    await initRegistry();
    await expectRefusal("admission-unavailable");
  });

  it("refuses when the catalog is signed by a key this build does not anchor", async () => {
    const body = catalogBody({});
    const { privateKey: stranger } = generateKeyPairSync("ed25519");
    routes.set("/v1/admission.json", { status: 200, body });
    routes.set("/v1/admission.json.sig", {
      status: 200,
      body: signEnvelopeFixture(body, stranger, "stranger-v1"),
    });
    await initRegistry();
    await expectRefusal("admission-unavailable");
  });

  it("refuses when the catalog is signed by a retired key id", async () => {
    const body = catalogBody({});
    serveCatalog(body);
    // Retirement = removal from the anchor map, which is the only thing
    // `verifyEnvelope` consults.
    admissionRegistry.setPublicKeysForTesting({ "admission-v2": admissionAnchorB64 });
    await initRegistry();
    await expectRefusal("admission-unavailable");
  });

  it("refuses a version the catalog does not list", async () => {
    serveCatalog(catalogBody({ version: "9.9.9" }));
    await initRegistry();
    await expectRefusal("admission-not-listed");
  });

  it("refuses when the marketplace offers bytes the distributor did not admit", async () => {
    serveCatalog(catalogBody({ sha256: "f".repeat(64) }));
    await initRegistry();
    await expectRefusal("admission-hash-mismatch");
  });

  it("refuses when the requested version never resolved to a concrete one", async () => {
    serveCatalog(catalogBody({}));
    await initRegistry();
    const unversioned = { ...PLUGIN, version: undefined } as unknown as PluginMarketplaceItem;
    const err = await makeStore()
      .downloadVerifiedArtifact(unversioned, "latest")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginNotAdmittedError);
    expect((err as PluginNotAdmittedError).refusalCode).toBe("admission-version-unresolved");
    expect(downloadCalls).toEqual([]);
  });
});

describe("shipped enforcement default", () => {
  it("is 'observe', so an unavailable catalog does not yet block installs", async () => {
    // Imported WITHOUT the module mock above, so this reads the real constant.
    const real = await vi.importActual<typeof import("../admission-registry.js")>(
      "../admission-registry.js",
    );
    expect(real.ADMISSION_ENFORCEMENT).toBe("observe");
  });
});
