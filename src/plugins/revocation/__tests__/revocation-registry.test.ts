/**
 * plugin revocation registry unit tests.
 *
 * Covers the fail-open/fail-closed asymmetry that is the whole point of
 * this registry (see `revocation-registry.ts` module doc): no document ever
 * obtained → allow everything; ANY valid signed document (fresh or cached,
 * and REGARDLESS of its own staleness) → obeyed exactly as written. Network
 * fetch is faked with the test-only `online: false` flag, same convention
 * as `whitelist-registry.test.ts`.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { revocationRegistry } from "../revocation-registry.js";
import { RevocationCache } from "../revocation-cache.js";
import { parseRevocationDocument } from "../revocation-schema.js";
import { WHITELIST_PRIMARY_KEY_ID as REVOCATION_PRIMARY_KEY_ID } from "../../marketplace-keys.js";
import { cleanupTmpDir } from "../../../testing/tmp-dir-teardown.js";
import { signEnvelopeFixture } from "../../../testing/sign-envelope-fixture.js";

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

interface SignedDoc {
  body: string;
  signature: string;
  doc: ReturnType<typeof buildRevocationDoc>;
}

function buildRevocationDoc(opts: {
  issuedAt: string;
  expiresAt: string;
  minVersions?: Record<string, string>;
  blocked?: Array<{ slug: string; version: string; reason: string }>;
}) {
  return {
    version: 1 as const,
    schemaVersion: 1 as const,
    issuedAt: opts.issuedAt,
    expiresAt: opts.expiresAt,
    minVersions: opts.minVersions ?? {},
    blocked: opts.blocked ?? [],
  };
}

// See `whitelist-registry.test.ts` for why this is `KeyObject`, not
// `ReturnType<typeof generateKeyPairSync>["privateKey"]`.
let testPrivateKey: KeyObject;
let testKeyId: string;

function makeSigned(opts: {
  issuedAt: string;
  expiresAt: string;
  minVersions?: Record<string, string>;
  blocked?: Array<{ slug: string; version: string; reason: string }>;
}): SignedDoc {
  const doc = buildRevocationDoc(opts);
  const body = JSON.stringify(doc);
  return { body, signature: signEnvelopeFixture(body, testPrivateKey, testKeyId), doc };
}

const tempRoots: string[] = [];
function freshUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), "lvis-revocation-test-"));
  tempRoots.push(dir);
  return dir;
}

afterAll(async () => {
  for (const root of tempRoots) {
    await cleanupTmpDir(root);
  }
});

beforeEach(() => {
  revocationRegistry.resetForTesting();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ type: "spki", format: "der" }).slice(-32);
  testPrivateKey = privateKey;
  testKeyId = REVOCATION_PRIMARY_KEY_ID;
  revocationRegistry.setPublicKeysForTesting({
    [REVOCATION_PRIMARY_KEY_ID]: rawPub.toString("base64"),
  });
});

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe("RevocationRegistry — fail-open", () => {
  it("allows everything when no document was ever obtained (offline, no cache)", async () => {
    const userDataDir = freshUserData();
    await revocationRegistry.init({ userDataDir, online: false });

    expect(revocationRegistry.evaluate("meeting", "1.0.0")).toEqual({ kind: "allow" });
    expect(revocationRegistry.status().hasDocument).toBe(false);
  });

  it("allows everything when the cached document's signature does not verify", async () => {
    const userDataDir = freshUserData();
    const cache = new RevocationCache(userDataDir);
    const signed = makeSigned({
      issuedAt: "2026-05-17T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      blocked: [{ slug: "meeting", version: "1.0.0", reason: "test" }],
    });
    // Corrupt the body after signing so the signature no longer matches.
    await cache.store({
      body: signed.body.replace("meeting", "meeting-tampered"),
      signature: signed.signature,
      meta: { highestSeenIssuedAt: signed.doc.issuedAt },
    });

    await revocationRegistry.init({ userDataDir, online: false });

    expect(revocationRegistry.evaluate("meeting", "1.0.0")).toEqual({ kind: "allow" });
  });
});

describe("RevocationRegistry — fail-closed on a valid document", () => {
  it("blocks an explicitly blocklisted slug@version", async () => {
    const userDataDir = freshUserData();
    const cache = new RevocationCache(userDataDir);
    const signed = makeSigned({
      issuedAt: "2026-05-17T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      blocked: [{ slug: "meeting", version: "1.2.3", reason: "compromised signing key" }],
    });
    await cache.store({
      body: signed.body,
      signature: signed.signature,
      meta: { highestSeenIssuedAt: signed.doc.issuedAt },
    });

    await revocationRegistry.init({
      userDataDir,
      online: false,
      now: () => Date.parse("2026-05-18T00:00:00.000Z"),
    });

    expect(revocationRegistry.evaluate("meeting", "1.2.3")).toEqual({
      kind: "block",
      ruleKind: "blocklist",
      reason: "compromised signing key",
    });
    // A different version of the same plugin is unaffected.
    expect(revocationRegistry.evaluate("meeting", "1.2.4")).toEqual({ kind: "allow" });
  });

  it("blocks a version below the pinned minVersion", async () => {
    const userDataDir = freshUserData();
    const cache = new RevocationCache(userDataDir);
    const signed = makeSigned({
      issuedAt: "2026-05-17T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      minVersions: { "local-indexer": "2.0.0" },
    });
    await cache.store({
      body: signed.body,
      signature: signed.signature,
      meta: { highestSeenIssuedAt: signed.doc.issuedAt },
    });

    await revocationRegistry.init({
      userDataDir,
      online: false,
      now: () => Date.parse("2026-05-18T00:00:00.000Z"),
    });

    const decision = revocationRegistry.evaluate("local-indexer", "1.9.9");
    expect(decision.kind).toBe("block");
    expect(decision).toMatchObject({ ruleKind: "min-version" });

    expect(revocationRegistry.evaluate("local-indexer", "2.0.0")).toEqual({ kind: "allow" });
    expect(revocationRegistry.evaluate("local-indexer", "2.1.0")).toEqual({ kind: "allow" });
  });

  it("keeps enforcing a cached document past its own expiresAt (staleness never fails open)", async () => {
    const userDataDir = freshUserData();
    const cache = new RevocationCache(userDataDir);
    const signed = makeSigned({
      issuedAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-02-01T00:00:00.000Z",
      blocked: [{ slug: "meeting", version: "0.1.0", reason: "yanked" }],
    });
    await cache.store({
      body: signed.body,
      signature: signed.signature,
      meta: { highestSeenIssuedAt: signed.doc.issuedAt },
    });

    // "Now" is years past expiresAt, and we're offline so no refresh happens.
    await revocationRegistry.init({
      userDataDir,
      online: false,
      now: () => Date.parse("2026-05-18T00:00:00.000Z"),
    });

    expect(revocationRegistry.status().stale).toBe(true);
    expect(revocationRegistry.evaluate("meeting", "0.1.0")).toEqual({
      kind: "block",
      ruleKind: "blocklist",
      reason: "yanked",
    });
  });
});

describe("parseRevocationDocument — fail-closed schema validation", () => {
  it("rejects a document with a non-semver minVersion", () => {
    expect(() =>
      parseRevocationDocument(
        JSON.stringify({
          version: 1,
          schemaVersion: 1,
          issuedAt: "2026-05-17T00:00:00.000Z",
          expiresAt: "2030-01-01T00:00:00.000Z",
          minVersions: { meeting: "not-a-version" },
          blocked: [],
        }),
      ),
    ).toThrow(/semver/);
  });

  it("rejects a blocked entry missing a reason", () => {
    expect(() =>
      parseRevocationDocument(
        JSON.stringify({
          version: 1,
          schemaVersion: 1,
          issuedAt: "2026-05-17T00:00:00.000Z",
          expiresAt: "2030-01-01T00:00:00.000Z",
          minVersions: {},
          blocked: [{ slug: "meeting", version: "1.0.0" }],
        }),
      ),
    ).toThrow(/reason/);
  });

  it("rejects expiresAt not strictly after issuedAt", () => {
    expect(() =>
      parseRevocationDocument(
        JSON.stringify({
          version: 1,
          schemaVersion: 1,
          issuedAt: "2026-05-17T00:00:00.000Z",
          expiresAt: "2026-05-17T00:00:00.000Z",
          minVersions: {},
          blocked: [],
        }),
      ),
    ).toThrow(/expiresAt/);
  });
});
