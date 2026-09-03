/**
 * #893 Stage 2 — whitelist registry unit tests.
 *
 * Covers the four tier-3 decision branches + monotonicity rollback guard +
 * the stale-grace window. Network fetch is faked
 * with the test-only `online: false` flag so the suite never touches the
 * public CDN.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { WhitelistCache, whitelistRegistry } from "../whitelist-registry.js";
import { WHITELIST_PRIMARY_KEY_ID } from "../../marketplace-keys.js";
import { useTempDirs } from "../../../__tests__/test-helpers.js";
import { signEnvelopeFixture } from "../../../__tests__/support/sign-envelope-fixture.js";

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

interface SignedDoc {
  body: string;
  signature: string;
  doc: ReturnType<typeof buildWhitelist>;
}

function buildWhitelist(opts: {
  issuedAt: string;
  expiresAt: string;
  manifestSha?: string;
  hostSecretsRead?: string[];
}) {
  return {
    version: 1 as const,
    schemaVersion: 1 as const,
    issuedAt: opts.issuedAt,
    expiresAt: opts.expiresAt,
    pluginGrants: {
      meeting: {
        publisher: "lvis-community",
        hostSecrets: {
          read: opts.hostSecretsRead ?? ["llm.apiKey.openai"] as string[],
        },
        approvedManifestSha256:
          opts.manifestSha ?? "a".repeat(64),
      },
    },
  };
}

// `KeyObject`, not `ReturnType<typeof generateKeyPairSync>["privateKey"]` —
// that `ReturnType` resolves the union of every overload's return shape
// (including string/JsonWebKey/Buffer variants from unrelated key types),
// not the `KeyObject` the "ed25519", no-options overload actually returns,
// which broke `crypto.sign()`'s parameter typing below.
let testPrivateKey: KeyObject;
let testKeyId: string;

function makeSigned(opts: {
  issuedAt: string;
  expiresAt: string;
  manifestSha?: string;
}): SignedDoc {
  const doc = buildWhitelist(opts);
  const body = JSON.stringify(doc);
  return { body, signature: signEnvelopeFixture(body, testPrivateKey, testKeyId), doc };
}

const freshUserData = useTempDirs("lvis-whitelist-test-");

// ---------------------------------------------------------------------
// Suite — inject a fresh keypair per run via the registry's
// `setPublicKeysForTesting()` helper. Ralph cycle 1 HIGH fix: the
// production `WHITELIST_PUBLIC_KEYS` map is now `Object.freeze`-ed so
// tests cannot mutate the module-level constant; the registry exposes a
// dedicated test-injection surface instead.
// ---------------------------------------------------------------------

beforeEach(() => {
  whitelistRegistry.resetForTesting();

  // Generate a fresh keypair for this test run; key id matches the host's
  // primary key id so `verifyEnvelope` accepts the signature against the
  // injected map.
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ type: "spki", format: "der" }).slice(-32);
  testPrivateKey = privateKey;
  testKeyId = WHITELIST_PRIMARY_KEY_ID;
  whitelistRegistry.setPublicKeysForTesting({
    [WHITELIST_PRIMARY_KEY_ID]: rawPub.toString("base64"),
  });
});

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe("WhitelistRegistry — fresh allow", () => {
  it("returns allow for a plugin listed in pluginGrants with matching key", async () => {
    const userDataDir = freshUserData();
    const cache = new WhitelistCache(userDataDir);
    const signed = makeSigned({
      issuedAt: "2026-05-17T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      manifestSha: "f".repeat(64),
    });
    await cache.store({
      body: signed.body,
      signature: signed.signature,
      meta: { highestSeenIssuedAt: signed.doc.issuedAt },
    });

    await whitelistRegistry.init({
      userDataDir,
      online: false,
      now: () => Date.parse("2026-05-18T00:00:00.000Z"),
    });

    const decision = whitelistRegistry.isAllowed(
      "meeting",
      "llm.apiKey.openai",
      "f".repeat(64),
    );
    expect(decision.kind).toBe("allow");
    expect(whitelistRegistry.status().state).toBe("fresh");
  });

  it("returns allow for a marketplace provider preset secret grant", async () => {
    const userDataDir = freshUserData();
    const cache = new WhitelistCache(userDataDir);
    const key = "llm.marketplaceProvider.future-router.apiKey";
    const signed = makeSigned({
      issuedAt: "2026-05-17T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      manifestSha: "f".repeat(64),
      hostSecretsRead: [key],
    });
    await cache.store({
      body: signed.body,
      signature: signed.signature,
      meta: { highestSeenIssuedAt: signed.doc.issuedAt },
    });

    await whitelistRegistry.init({
      userDataDir,
      online: false,
      now: () => Date.parse("2026-05-18T00:00:00.000Z"),
    });

    const decision = whitelistRegistry.isAllowed(
      "meeting",
      key,
      "f".repeat(64),
    );
    expect(decision.kind).toBe("allow");
  });
});

describe("WhitelistRegistry — not-whitelisted", () => {
  it("denies a plugin that is absent from pluginGrants", async () => {
    const userDataDir = freshUserData();
    const cache = new WhitelistCache(userDataDir);
    const signed = makeSigned({
      issuedAt: "2026-05-17T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    await cache.store({
      body: signed.body,
      signature: signed.signature,
      meta: { highestSeenIssuedAt: signed.doc.issuedAt },
    });

    await whitelistRegistry.init({
      userDataDir,
      online: false,
      now: () => Date.parse("2026-05-18T00:00:00.000Z"),
    });

    const decision = whitelistRegistry.isAllowed(
      "rogue-plugin",
      "llm.apiKey.openai",
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.reason).toBe("not-whitelisted");
    }
  });

  it("denies a request for a key not in the grant's hostSecrets.read[]", async () => {
    const userDataDir = freshUserData();
    const cache = new WhitelistCache(userDataDir);
    const signed = makeSigned({
      issuedAt: "2026-05-17T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    await cache.store({
      body: signed.body,
      signature: signed.signature,
      meta: { highestSeenIssuedAt: signed.doc.issuedAt },
    });

    await whitelistRegistry.init({
      userDataDir,
      online: false,
      now: () => Date.parse("2026-05-18T00:00:00.000Z"),
    });

    const decision = whitelistRegistry.isAllowed(
      "meeting",
      "llm.apiKey.anthropic",
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.reason).toBe("not-whitelisted");
    }
  });
});

describe("WhitelistRegistry — manifest-sha mismatch", () => {
  it("denies when the caller's manifest sha does not match the pinned value", async () => {
    const userDataDir = freshUserData();
    const cache = new WhitelistCache(userDataDir);
    const signed = makeSigned({
      issuedAt: "2026-05-17T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      manifestSha: "a".repeat(64),
    });
    await cache.store({
      body: signed.body,
      signature: signed.signature,
      meta: { highestSeenIssuedAt: signed.doc.issuedAt },
    });

    await whitelistRegistry.init({
      userDataDir,
      online: false,
      now: () => Date.parse("2026-05-18T00:00:00.000Z"),
    });

    const decision = whitelistRegistry.isAllowed(
      "meeting",
      "llm.apiKey.openai",
      "b".repeat(64),
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.reason).toBe("manifest-sha-mismatch");
    }
  });
});

describe("WhitelistRegistry — issuedAt guard on the cached document", () => {
  it("refuses a cached doc whose issuedAt is below the high-water mark, and deletes it", async () => {
    const userDataDir = freshUserData();
    const cache = new WhitelistCache(userDataDir);
    // A correctly signed, structurally valid, unexpired document — and a
    // `highestSeenIssuedAt` recorded beside it that is NEWER than the body.
    // Parse and signature both pass, so only the `issuedAt` rule can catch
    // this; before that rule ran over the cached path, the registry served
    // the rolled-back body as its active snapshot.
    const signed = makeSigned({
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    await cache.store({
      body: signed.body,
      signature: signed.signature,
      meta: { highestSeenIssuedAt: "2027-01-01T00:00:00.000Z" },
    });
    expect((await cache.loadMeta()).highestSeenIssuedAt).toBe("2027-01-01T00:00:00.000Z");

    const audits: string[] = [];
    await whitelistRegistry.init({
      userDataDir,
      online: false,
      now: () => Date.parse("2026-05-18T00:00:00.000Z"),
      audit: (line) => audits.push(line),
    });

    // Refused → routed into the registry's existing "no cache" state, which
    // for this DENY-by-default registry means `whitelist-unreachable`. The
    // polarity is unchanged; only the set of documents that reach it is.
    expect(whitelistRegistry.status().state).toBe("no-cache");
    expect(whitelistRegistry.isAllowed("meeting", "llm.apiKey.openai")).toEqual({
      kind: "deny",
      reason: "whitelist-unreachable",
    });
    expect(audits.some((line) => line.includes("whitelist_cache_rejected reason=monotonicity"))).toBe(
      true,
    );
    // Deleted rather than left to be re-read and re-refused next boot, and so
    // the mark does not outlive the only document that justified it.
    expect(await cache.load()).toBeNull();
    expect(await cache.loadMeta()).toEqual({});
  });

  it("refuses a cached doc dated implausibly far ahead of the device clock", async () => {
    const userDataDir = freshUserData();
    const cache = new WhitelistCache(userDataDir);
    // Signed, unexpired, and NOT a rollback — no mark exists at all. Only the
    // plausibility bound can refuse it, and refusing it is what keeps its
    // `issuedAt` from becoming a mark that outranks every genuine document.
    const signed = makeSigned({
      issuedAt: "2027-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    await cache.store({ body: signed.body, signature: signed.signature, meta: {} });

    const audits: string[] = [];
    await whitelistRegistry.init({
      userDataDir,
      online: false,
      now: () => Date.parse("2026-05-18T00:00:00.000Z"),
      audit: (line) => audits.push(line),
    });

    expect(whitelistRegistry.status().state).toBe("no-cache");
    expect(
      audits.some((line) => line.includes("whitelist_cache_rejected reason=issued-in-future")),
    ).toBe(true);
    expect(await cache.loadMeta()).toEqual({});
  });

  it("accepts a cached doc inside the clock-skew allowance", async () => {
    // The boundary the bound above is drawn against: a document a few hours
    // ahead of a skewed device clock is ordinary, not implausible, and must
    // still load. Without this, "reject the future" would be a denial of
    // service against every device whose clock runs slow.
    const now = Date.parse("2026-05-18T00:00:00.000Z");
    const userDataDir = freshUserData();
    const cache = new WhitelistCache(userDataDir);
    const signed = makeSigned({
      issuedAt: new Date(now + 5 * 60 * 60 * 1000).toISOString(),
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    await cache.store({ body: signed.body, signature: signed.signature, meta: {} });

    await whitelistRegistry.init({ userDataDir, online: false, now: () => now });

    expect(whitelistRegistry.status().state).toBe("fresh");
    expect(await cache.load()).not.toBeNull();
  });

  it("deletes a cached doc whose signature no longer verifies", async () => {
    const userDataDir = freshUserData();
    const cache = new WhitelistCache(userDataDir);
    const signed = makeSigned({
      issuedAt: "2026-05-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    // Body tampered after signing → the sidecar no longer covers these bytes.
    await cache.store({
      body: signed.body.replace("lvis-community", "someone-else"),
      signature: signed.signature,
      meta: { highestSeenIssuedAt: "2026-05-01T00:00:00.000Z" },
    });

    await whitelistRegistry.init({
      userDataDir,
      online: false,
      now: () => Date.parse("2026-05-18T00:00:00.000Z"),
    });

    expect(whitelistRegistry.status().state).toBe("no-cache");
    // Previously this entry survived on disk and was re-read and re-refused on
    // every boot, with its meta still claiming a mark it could not justify.
    expect(await cache.load()).toBeNull();
    expect(await cache.loadMeta()).toEqual({});
  });
});

describe("WhitelistRegistry — stale grace windows", () => {
  it("returns stale-within-grace within 7 days of expiry", async () => {
    const userDataDir = freshUserData();
    const cache = new WhitelistCache(userDataDir);
    const signed = makeSigned({
      issuedAt: "2026-05-01T00:00:00.000Z",
      expiresAt: "2026-05-10T00:00:00.000Z",
    });
    await cache.store({
      body: signed.body,
      signature: signed.signature,
      meta: { highestSeenIssuedAt: signed.doc.issuedAt },
    });

    await whitelistRegistry.init({
      userDataDir,
      online: false,
      now: () => Date.parse("2026-05-12T00:00:00.000Z"),
    });

    const status = whitelistRegistry.status();
    expect(status.state).toBe("stale-within-grace");
    // Within grace → grants still resolve.
    const decision = whitelistRegistry.isAllowed("meeting", "llm.apiKey.openai");
    expect(decision.kind).toBe("allow");
  });

  it("returns stale-past-grace past the 7-day window and denies", async () => {
    const userDataDir = freshUserData();
    const cache = new WhitelistCache(userDataDir);
    const signed = makeSigned({
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-10T00:00:00.000Z",
    });
    await cache.store({
      body: signed.body,
      signature: signed.signature,
      meta: { highestSeenIssuedAt: signed.doc.issuedAt },
    });

    await whitelistRegistry.init({
      userDataDir,
      online: false,
      // Far past expiresAt + 7 day grace.
      now: () => Date.parse("2026-05-01T00:00:00.000Z"),
    });

    const status = whitelistRegistry.status();
    expect(status.state).toBe("stale-past-grace");
    const decision = whitelistRegistry.isAllowed("meeting", "llm.apiKey.openai");
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.reason).toBe("whitelist-stale-exceeded");
    }
  });
});

describe("WhitelistRegistry — uninitialized fail-closed", () => {
  it("records offline + no cache as unreachable, with no fail-open annotation", async () => {
    // Both registries load through `loadSignedDocumentSnapshot`; the fail mode
    // is the required parameter that keeps this line different from the
    // revocation registry's `(fail-open: nothing blocked)`.
    const audits: string[] = [];
    await whitelistRegistry.init({
      userDataDir: freshUserData(),
      online: false,
      audit: (line) => audits.push(line),
    });
    const line = audits.find((entry) => entry.includes("whitelist_unreachable reason=no-cache-and-offline"));
    expect(line).toBeDefined();
    expect(line).not.toContain("fail-open");
    const decision = whitelistRegistry.isAllowed("meeting", "llm.apiKey.openai");
    expect(decision).toEqual({ kind: "deny", reason: "whitelist-unreachable" });
  });

  it("denies all calls before init() runs", () => {
    whitelistRegistry.resetForTesting();
    const decision = whitelistRegistry.isAllowed("meeting", "llm.apiKey.openai");
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.reason).toBe("whitelist-unreachable");
    }
  });
});

describe("WhitelistRegistry — issuedAt guard on the fetched document", () => {
  /**
   * The registry's source URLs are module constants, so the seam for the
   * online path is the global `fetch` the shared fetcher calls. Only the two
   * document paths are served; anything else 404s, which is what an
   * unmatched request should look like.
   */
  function serveSignedDocument(body: string, signature: string): void {
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      const payload =
        path.endsWith("/whitelist.json")
          ? body
          : path.endsWith("/whitelist.json.sig")
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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("discards a fetched doc dated implausibly far ahead without advancing the mark", async () => {
    const now = Date.parse("2026-05-18T00:00:00.000Z");
    const userDataDir = freshUserData();
    const cache = new WhitelistCache(userDataDir);
    const future = makeSigned({
      issuedAt: "2027-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    serveSignedDocument(future.body, future.signature);

    const audits: string[] = [];
    await whitelistRegistry.init({
      userDataDir,
      online: true,
      now: () => now,
      audit: (line) => audits.push(line),
    });

    expect(whitelistRegistry.status().state).toBe("no-cache");
    expect(
      audits.some((line) => line.includes("whitelist_fetch_failed reason=issued-in-future")),
    ).toBe(true);
    // The point of refusing before accepting: the mark on disk is what a
    // future-dated document would poison, and it survives restarts.
    expect((await cache.loadMeta()).highestSeenIssuedAt).toBeUndefined();

    // A genuine document issued after the refusal still loads — which is only
    // true because the mark was never raised above it.
    const genuine = makeSigned({
      issuedAt: "2026-05-17T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    serveSignedDocument(genuine.body, genuine.signature);
    await whitelistRegistry.init({ userDataDir, online: true, now: () => now });

    expect(whitelistRegistry.status()).toMatchObject({ state: "fresh", source: "remote" });
    expect((await cache.loadMeta()).highestSeenIssuedAt).toBe("2026-05-17T00:00:00.000Z");
  });
});
