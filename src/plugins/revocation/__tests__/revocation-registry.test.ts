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
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

// `evaluate()` before `init()` reports itself through the module logger,
// because the audit sink it would otherwise use arrives via the very call that
// did not happen. That makes the logger the only observable for the signal, so
// it is mocked here. Every module in this registry's import graph takes only
// `createLogger` from it.
const loggerMock = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../../../lib/logger.js", () => ({
  createLogger: () => loggerMock,
}));
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { RevocationCache, revocationRegistry } from "../revocation-registry.js";
import { parseRevocationDocument } from "../revocation-schema.js";
import { WHITELIST_PRIMARY_KEY_ID as REVOCATION_PRIMARY_KEY_ID } from "../../marketplace-keys.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { signEnvelopeFixture } from "../../../__tests__/support/sign-envelope-fixture.js";

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

afterEach(() => {
  vi.unstubAllGlobals();
  loggerMock.error.mockClear();
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

describe("RevocationRegistry — issuedAt guard on the cached document", () => {
  it("refuses a cached doc whose issuedAt is below the high-water mark, and deletes it", async () => {
    const userDataDir = freshUserData();
    const cache = new RevocationCache(userDataDir);
    // A correctly signed, structurally valid document that blocks a version —
    // and a `highestSeenIssuedAt` recorded beside it that is NEWER than the
    // body. Parse and signature both pass, so only the `issuedAt` rule can
    // catch it. Serving a rolled-back body un-revokes whatever the newer
    // document had blocked, which is the outcome the mark exists to prevent;
    // before this rule ran over the cached path, the mark gated only the
    // fetched document.
    const rolledBack = makeSigned({
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      blocked: [],
    });
    await cache.store({
      body: rolledBack.body,
      signature: rolledBack.signature,
      meta: { highestSeenIssuedAt: "2027-01-01T00:00:00.000Z" },
    });

    const audits: string[] = [];
    await revocationRegistry.init({
      userDataDir,
      online: false,
      now: () => Date.parse("2026-05-18T00:00:00.000Z"),
      audit: (line) => audits.push(line),
    });

    // Refused → no document held. `evaluate()` still allows: that is this
    // registry's documented allow-by-default polarity, unchanged here. What
    // changed is that a rolled-back document is no longer presented as the
    // held document, and the refusal is now visible.
    expect(revocationRegistry.status().hasDocument).toBe(false);
    expect(revocationRegistry.evaluate("meeting", "1.0.0")).toEqual({ kind: "allow" });
    expect(
      audits.some((line) => line.includes("revocation_cache_rejected reason=monotonicity")),
    ).toBe(true);
    expect(await cache.load()).toBeNull();
    expect(await cache.loadMeta()).toEqual({});
  });

  it("refuses a cached doc dated implausibly far ahead of the device clock", async () => {
    const userDataDir = freshUserData();
    const cache = new RevocationCache(userDataDir);
    // Signed, unexpired, and NOT a rollback — no mark exists at all. Only the
    // plausibility bound can refuse it, and refusing it is what keeps its
    // `issuedAt` from becoming a mark that outranks every genuine document.
    const signed = makeSigned({
      issuedAt: "2027-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    await cache.store({ body: signed.body, signature: signed.signature, meta: {} });

    const audits: string[] = [];
    await revocationRegistry.init({
      userDataDir,
      online: false,
      now: () => Date.parse("2026-05-18T00:00:00.000Z"),
      audit: (line) => audits.push(line),
    });

    expect(revocationRegistry.status().hasDocument).toBe(false);
    expect(
      audits.some((line) => line.includes("revocation_cache_rejected reason=issued-in-future")),
    ).toBe(true);
    expect(await cache.loadMeta()).toEqual({});
  });

  it("accepts a cached doc inside the clock-skew allowance", async () => {
    // The boundary the bound above is drawn against: a document a few hours
    // ahead of a skewed device clock is ordinary, not implausible, and must
    // still be enforced. Refusing it would stop honoring live revocations on
    // every device whose clock runs slow.
    const now = Date.parse("2026-05-18T00:00:00.000Z");
    const userDataDir = freshUserData();
    const cache = new RevocationCache(userDataDir);
    const signed = makeSigned({
      issuedAt: new Date(now + 5 * 60 * 60 * 1000).toISOString(),
      expiresAt: "2030-01-01T00:00:00.000Z",
      blocked: [{ slug: "meeting", version: "1.0.0", reason: "test" }],
    });
    await cache.store({ body: signed.body, signature: signed.signature, meta: {} });

    await revocationRegistry.init({ userDataDir, online: false, now: () => now });

    expect(revocationRegistry.evaluate("meeting", "1.0.0")).toMatchObject({ kind: "block" });
    expect(await cache.load()).not.toBeNull();
  });

  it("deletes a cached doc whose signature no longer verifies", async () => {
    const userDataDir = freshUserData();
    const cache = new RevocationCache(userDataDir);
    const signed = makeSigned({
      issuedAt: "2026-05-17T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      blocked: [{ slug: "meeting", version: "1.0.0", reason: "test" }],
    });
    await cache.store({
      body: signed.body.replace("meeting", "meeting-tampered"),
      signature: signed.signature,
      meta: { highestSeenIssuedAt: signed.doc.issuedAt },
    });

    await revocationRegistry.init({ userDataDir, online: false });

    // Previously this entry survived on disk and was re-read and re-refused on
    // every boot, with its meta still claiming a mark it could not justify.
    expect(await cache.load()).toBeNull();
    expect(await cache.loadMeta()).toEqual({});
  });
});

describe("RevocationRegistry — issuedAt guard on the fetched document", () => {
  /**
   * The registry's source URLs are module constants, so the seam for the
   * online path is the global `fetch` the shared fetcher calls.
   */
  function serveSignedDocument(body: string, signature: string): void {
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      const payload =
        path.endsWith("/revocation.json")
          ? body
          : path.endsWith("/revocation.json.sig")
            ? signature
            : null;
      if (payload === null) {
        return {
          ok: false,
          status: 404,
          headers: { get: () => null },
          text: async () => "not found",
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => payload,
      };
    });
  }

  it("discards a fetched doc dated implausibly far ahead without advancing the mark", async () => {
    const now = Date.parse("2026-05-18T00:00:00.000Z");
    const userDataDir = freshUserData();
    const cache = new RevocationCache(userDataDir);
    const future = makeSigned({
      issuedAt: "2027-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    serveSignedDocument(future.body, future.signature);

    const audits: string[] = [];
    await revocationRegistry.init({
      userDataDir,
      online: true,
      now: () => now,
      audit: (line) => audits.push(line),
    });

    expect(revocationRegistry.status().hasDocument).toBe(false);
    expect(
      audits.some((line) => line.includes("revocation_fetch_failed reason=issued-in-future")),
    ).toBe(true);
    // The mark on disk is what a future-dated document would hold above every
    // genuine document, and it survives restarts.
    expect((await cache.loadMeta()).highestSeenIssuedAt).toBeUndefined();

    // A genuine document issued after the refusal still loads and still
    // blocks — only true because the mark was never raised above it.
    const genuine = makeSigned({
      issuedAt: "2026-05-17T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      blocked: [{ slug: "meeting", version: "1.0.0", reason: "test" }],
    });
    serveSignedDocument(genuine.body, genuine.signature);
    await revocationRegistry.init({ userDataDir, online: true, now: () => now });

    expect(revocationRegistry.evaluate("meeting", "1.0.0")).toMatchObject({ kind: "block" });
    expect((await cache.loadMeta()).highestSeenIssuedAt).toBe("2026-05-17T00:00:00.000Z");
  });

  it("counts the fully fail-open state when the fetch fails and no document is held", async () => {
    // `revocation_fetch_failed{network}` fires whether or not a cached
    // document is still being enforced, so on its own it cannot tell an
    // operator that this device is blocking nothing at all. The
    // cache-miss counter is what separates the two, matching what
    // `whitelist-registry.ts` emits on the same branch.
    vi.stubGlobal("fetch", async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const events: Array<{ event: string; meta?: Record<string, string> }> = [];
    const audits: string[] = [];
    await revocationRegistry.init({
      userDataDir: freshUserData(),
      online: true,
      now: () => Date.parse("2026-05-18T00:00:00.000Z"),
      audit: (line) => audits.push(line),
      telemetry: (event, meta) => events.push(meta ? { event, meta } : { event }),
    });

    expect(events).toContainEqual({
      event: "revocation_cache_miss_offline",
      meta: { reason: "no-cache" },
    });
    expect(
      audits.some((line) => line.includes("revocation_unreachable reason=fetch-failed-and-no-cache")),
    ).toBe(true);
    expect(revocationRegistry.evaluate("meeting", "1.0.0")).toEqual({ kind: "allow" });
  });

  it("does not emit the fail-open counter while a cached document is still enforced", async () => {
    // The boundary for the counter above: a fetch failure with a cached
    // document in hand is NOT the fail-open state, and must not be counted as
    // one, or the counter stops distinguishing anything.
    const userDataDir = freshUserData();
    const cache = new RevocationCache(userDataDir);
    const signed = makeSigned({
      issuedAt: "2026-05-17T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      blocked: [{ slug: "meeting", version: "1.0.0", reason: "test" }],
    });
    await cache.store({
      body: signed.body,
      signature: signed.signature,
      meta: { highestSeenIssuedAt: signed.doc.issuedAt },
    });
    vi.stubGlobal("fetch", async () => {
      throw new Error("connect ECONNREFUSED");
    });

    const events: string[] = [];
    await revocationRegistry.init({
      userDataDir,
      online: true,
      now: () => Date.parse("2026-05-18T00:00:00.000Z"),
      telemetry: (event, meta) => events.push(`${event}:${meta?.reason ?? ""}`),
    });

    expect(events).toContain("revocation_fetch_failed:network");
    expect(events).not.toContain("revocation_cache_miss_offline:no-cache");
    expect(revocationRegistry.evaluate("meeting", "1.0.0")).toMatchObject({ kind: "block" });
  });
});

describe("RevocationRegistry — evaluate() before init()", () => {
  it("reports the unconfigured registry once, and still allows", () => {
    // A boot-ordering regression that skips `revocationRegistry.init()` turns
    // this kill switch into a no-op: every call allows, no counter moves, and
    // before this signal existed nothing anywhere said so. The answer stays
    // `allow` on purpose — denying here would block every installed plugin on
    // a wiring bug, which is the outage the fail-open contract exists to
    // prevent — so the signal is the whole fix.
    expect(revocationRegistry.evaluate("meeting", "1.0.0")).toEqual({ kind: "allow" });
    expect(loggerMock.error).toHaveBeenCalledTimes(1);
    expect(String(loggerMock.error.mock.calls[0]?.[0])).toContain("revocation_unconfigured");

    // `evaluate()` sits on the plugin load path; reporting per plugin per boot
    // would bury the first one.
    revocationRegistry.evaluate("local-indexer", "2.0.0");
    revocationRegistry.evaluate("ms-graph", "3.0.0");
    expect(loggerMock.error).toHaveBeenCalledTimes(1);
  });

  it("stays silent once init() has run", async () => {
    await revocationRegistry.init({ userDataDir: freshUserData(), online: false });

    revocationRegistry.evaluate("meeting", "1.0.0");
    expect(loggerMock.error).not.toHaveBeenCalled();
  });
});
