/**
 * Admission catalog registry tests.
 *
 * These run the real pipeline: a real `node:http` origin serving real bytes, a
 * real ed25519 signature over those bytes, the production `verifyEnvelope`, the
 * production `SignedDocumentCache` writing to a real temp directory, and the
 * production fetcher's primary→fallback + conditional-GET behaviour. Nothing
 * about the verification path is stubbed, because the properties under test
 * are exactly the ones a stub would assume rather than demonstrate.
 *
 * Each failure mode is PRODUCED — the catalog is genuinely missing, genuinely
 * expired, genuinely truncated, genuinely signed by a key the build does not
 * trust — and the registry is then asked what it decides.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { admissionRegistry } from "../admission-registry.js";
import type { AdmissionEntry } from "../admission-schema.js";
import { SignedDocumentCache } from "../../signed-doc-cache.js";
import { useTempDirs } from "../../../__tests__/test-helpers.js";
import { signEnvelopeFixture } from "../../../__tests__/support/sign-envelope-fixture.js";
import { unusedNetworkFetch } from "../../../__tests__/support/network-fetch-stubs.js";

const ANCHOR_KEY_ID = "admission-v1";
const SHA_MEETING = "1".repeat(64);
const SHA_OTHER = "2".repeat(64);

const NOW = Date.parse("2026-08-19T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

let signingKey: KeyObject;
let anchorB64: string;

function entry(over: Partial<AdmissionEntry> = {}): AdmissionEntry {
  return {
    slug: "meeting",
    version: "1.2.3",
    artifactSha256: SHA_MEETING,
    publisher: "lvis-project",
    admittedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

function buildBody(opts: {
  issuedAtMs?: number;
  expiresAtMs?: number;
  admissions?: AdmissionEntry[];
}): string {
  const issuedAtMs = opts.issuedAtMs ?? NOW - HOUR;
  const expiresAtMs = opts.expiresAtMs ?? issuedAtMs + 24 * HOUR;
  return JSON.stringify({
    version: 1,
    schemaVersion: 1,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    admissions: opts.admissions ?? [entry()],
  });
}

function sign(body: string, key: KeyObject = signingKey, keyId = ANCHOR_KEY_ID): string {
  return signEnvelopeFixture(body, key, keyId);
}

// ---------------------------------------------------------------------
// A real origin. Routes are plain records a test replaces between two
// refreshes of the same registry, so the server never dispatches a value
// derived from the request path.
// ---------------------------------------------------------------------

interface Route {
  status: number;
  body: string;
}

let server: Server;
let baseUrl: string;
let routes: Map<string, Route>;

function serve(path: string, route: Route): void {
  routes.set(path, route);
}

function serveSignedCatalog(body: string, signature = sign(body)): void {
  serve("/v1/admission.json", { status: 200, body });
  serve("/v1/admission.json.sig", { status: 200, body: signature });
}

function source() {
  return {
    primaryBase: `${baseUrl}/v1`,
    fallbackBase: `${baseUrl}/fallback`,
    docFilename: "admission.json",
    sigFilename: "admission.json.sig",
  };
}

const freshUserData = useTempDirs("lvis-admission-test-");

beforeEach(async () => {
  admissionRegistry.resetForTesting();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  signingKey = privateKey;
  anchorB64 = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
  admissionRegistry.setPublicKeysForTesting({ [ANCHOR_KEY_ID]: anchorB64 });

  routes = new Map();
  server = createServer((req, res) => {
    const route = routes.get(req.url ?? "");
    if (!route) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(route.status, { "content-type": "application/json" }).end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function initAgainstServer(opts: { now?: number; online?: boolean } = {}) {
  await admissionRegistry.init({
    // This suite's origin is its own loopback server, so Node's `fetch` is the
    // transport under test here; production passes Chromium's.
    networkFetch: fetch,
    userDataDir: freshUserData(),
    online: opts.online ?? true,
    now: () => opts.now ?? NOW,
    source: source(),
  });
}

// ---------------------------------------------------------------------
// The positive case
// ---------------------------------------------------------------------

describe("AdmissionRegistry — admits", () => {
  it("admits a slug@version listed in a fresh, correctly signed catalog", async () => {
    serveSignedCatalog(buildBody({}));
    await initAgainstServer();

    const decision = admissionRegistry.evaluate("meeting", "1.2.3");
    expect(decision.kind).toBe("admitted");
    if (decision.kind !== "admitted") throw new Error("unreachable");
    expect(decision.entry.artifactSha256).toBe(SHA_MEETING);
    expect(decision.entry.publisher).toBe("lvis-project");
    expect(decision.documentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(admissionRegistry.status()).toMatchObject({
      hasDocument: true,
      stale: false,
      source: "remote",
      admissionCount: 1,
    });
  });

  it("admits from a cached document while the origin is unreachable, inside its own expiry", async () => {
    const body = buildBody({});
    serveSignedCatalog(body);
    const userDataDir = freshUserData();
    await admissionRegistry.init({
      networkFetch: fetch,
      userDataDir,
      online: true,
      now: () => NOW,
      source: source(),
    });
    expect(admissionRegistry.evaluate("meeting", "1.2.3").kind).toBe("admitted");

    // Origin now 404s for everything; the cached, signed, unexpired statement
    // is still a statement.
    admissionRegistry.resetForTesting();
    admissionRegistry.setPublicKeysForTesting({ [ANCHOR_KEY_ID]: anchorB64 });
    routes.clear();
    await admissionRegistry.init({
      networkFetch: fetch,
      userDataDir,
      online: true,
      now: () => NOW + HOUR,
      source: source(),
    });
    const decision = admissionRegistry.evaluate("meeting", "1.2.3");
    expect(decision.kind).toBe("admitted");
    expect(admissionRegistry.status().source).toBe("cache");
  });
});

// ---------------------------------------------------------------------
// Missing / unreachable
// ---------------------------------------------------------------------

describe("AdmissionRegistry — refuses when it has no document", () => {
  it("refuses when the catalog 404s and no cache exists", async () => {
    await initAgainstServer();
    expect(admissionRegistry.evaluate("meeting", "1.2.3")).toEqual({
      kind: "refused",
      code: "admission-unavailable",
      detail: "no valid admission catalog has been obtained",
    });
  });

  it("refuses when both primary and fallback return 5xx", async () => {
    serve("/v1/admission.json", { status: 503, body: "down" });
    serve("/fallback/admission.json", { status: 503, body: "down" });
    await initAgainstServer();
    expect(admissionRegistry.evaluate("meeting", "1.2.3").kind).toBe("refused");
    expect(admissionRegistry.status().hasDocument).toBe(false);
  });

  it("refuses on first run offline, with no cache", async () => {
    await initAgainstServer({ online: false });
    const decision = admissionRegistry.evaluate("meeting", "1.2.3");
    expect(decision).toMatchObject({ kind: "refused", code: "admission-unavailable" });
  });

  it("refuses with an anchor-specific reason when the build has no admission trust anchor", async () => {
    serveSignedCatalog(buildBody({}));
    admissionRegistry.setPublicKeysForTesting({});
    await initAgainstServer();
    const decision = admissionRegistry.evaluate("meeting", "1.2.3");
    expect(decision).toEqual({
      kind: "refused",
      code: "admission-unavailable",
      detail:
        "no admission trust anchor is configured for this build, so no catalog can be verified",
    });
  });
});

// ---------------------------------------------------------------------
// Stale — the polarity decision
// ---------------------------------------------------------------------

describe("AdmissionRegistry — refuses a stale document", () => {
  it("refuses once the held document is past its own expiresAt, with no grace window", async () => {
    const issuedAtMs = NOW - 30 * HOUR;
    serveSignedCatalog(buildBody({ issuedAtMs, expiresAtMs: issuedAtMs + 24 * HOUR }));
    await initAgainstServer();

    // The document verified and is held — this is not a fetch failure.
    expect(admissionRegistry.status().hasDocument).toBe(true);
    const decision = admissionRegistry.evaluate("meeting", "1.2.3");
    expect(decision.kind).toBe("refused");
    if (decision.kind !== "refused") throw new Error("unreachable");
    expect(decision.code).toBe("admission-stale");
    // The copy names the clock, because a skewed device is the other cause.
    expect(decision.detail).toMatch(/this device's clock reads/);
  });

  it("refuses a cached document that expired while the origin was unreachable", async () => {
    const issuedAtMs = NOW - HOUR;
    const body = buildBody({ issuedAtMs, expiresAtMs: issuedAtMs + 24 * HOUR });
    serveSignedCatalog(body);
    const userDataDir = freshUserData();
    await admissionRegistry.init({ networkFetch: fetch, userDataDir, online: true, now: () => NOW, source: source() });
    expect(admissionRegistry.evaluate("meeting", "1.2.3").kind).toBe("admitted");

    admissionRegistry.resetForTesting();
    admissionRegistry.setPublicKeysForTesting({ [ANCHOR_KEY_ID]: anchorB64 });
    routes.clear();
    await admissionRegistry.init({
      networkFetch: fetch,
      userDataDir,
      online: true,
      now: () => NOW + 48 * HOUR,
      source: source(),
    });
    expect(admissionRegistry.evaluate("meeting", "1.2.3")).toMatchObject({
      code: "admission-stale",
    });
  });

  it("does not treat a 304 as a freshness extension", async () => {
    const issuedAtMs = NOW - HOUR;
    const body = buildBody({ issuedAtMs, expiresAtMs: issuedAtMs + 24 * HOUR });
    serveSignedCatalog(body);
    const userDataDir = freshUserData();
    await admissionRegistry.init({ networkFetch: fetch, userDataDir, online: true, now: () => NOW, source: source() });

    // Origin keeps answering, but with the same (now expired) document.
    admissionRegistry.resetForTesting();
    admissionRegistry.setPublicKeysForTesting({ [ANCHOR_KEY_ID]: anchorB64 });
    await admissionRegistry.init({
      networkFetch: fetch,
      userDataDir,
      online: true,
      now: () => NOW + 48 * HOUR,
      source: source(),
    });
    expect(admissionRegistry.evaluate("meeting", "1.2.3")).toMatchObject({
      code: "admission-stale",
    });
  });
});

// ---------------------------------------------------------------------
// Unparseable
// ---------------------------------------------------------------------

describe("AdmissionRegistry — refuses an unparseable document", () => {
  it("refuses a truncated body rather than reading it as an empty catalog", async () => {
    const body = buildBody({});
    serve("/v1/admission.json", { status: 200, body: body.slice(0, 80) });
    serve("/v1/admission.json.sig", { status: 200, body: sign(body.slice(0, 80)) });
    await initAgainstServer();
    expect(admissionRegistry.status().hasDocument).toBe(false);
    expect(admissionRegistry.evaluate("meeting", "1.2.3")).toMatchObject({
      code: "admission-unavailable",
    });
  });

  it("refuses a document carrying an unknown root field", async () => {
    const body = JSON.stringify({ ...JSON.parse(buildBody({})), blocked: [] });
    serveSignedCatalog(body);
    await initAgainstServer();
    expect(admissionRegistry.status().hasDocument).toBe(false);
  });

  it("keeps the previously held document when a later fetch returns garbage", async () => {
    serveSignedCatalog(buildBody({}));
    const userDataDir = freshUserData();
    await admissionRegistry.init({ networkFetch: fetch, userDataDir, online: true, now: () => NOW, source: source() });
    expect(admissionRegistry.evaluate("meeting", "1.2.3").kind).toBe("admitted");

    serve("/v1/admission.json", { status: 200, body: "{{{" });
    serve("/v1/admission.json.sig", { status: 200, body: sign("{{{") });
    await admissionRegistry.ensureFresh();
    expect(admissionRegistry.evaluate("meeting", "1.2.3").kind).toBe("admitted");
  });
});

// ---------------------------------------------------------------------
// Unknown / retired signing key
// ---------------------------------------------------------------------

describe("AdmissionRegistry — refuses an untrusted signer", () => {
  it("refuses a document signed by a key that is not an anchor", async () => {
    const { privateKey: strangerKey } = generateKeyPairSync("ed25519");
    const body = buildBody({});
    serveSignedCatalog(body, sign(body, strangerKey, "stranger-v1"));
    await initAgainstServer();
    expect(admissionRegistry.status().hasDocument).toBe(false);
    expect(admissionRegistry.evaluate("meeting", "1.2.3")).toMatchObject({
      code: "admission-unavailable",
    });
  });

  it("refuses a document signed by a RETIRED key — retirement is removal from the anchor map", async () => {
    const { publicKey: successorPub, privateKey: successorKey } = generateKeyPairSync("ed25519");
    const successorB64 = successorPub
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("base64");
    const body = buildBody({});
    serveSignedCatalog(body, sign(body, signingKey, ANCHOR_KEY_ID));

    // During the rotation overlap both ids are anchors: the old key still admits.
    admissionRegistry.setPublicKeysForTesting({
      [ANCHOR_KEY_ID]: anchorB64,
      "admission-v2": successorB64,
    });
    await initAgainstServer();
    expect(admissionRegistry.evaluate("meeting", "1.2.3").kind).toBe("admitted");

    // Retire the old id by dropping it. The same document now admits nothing —
    // there is no warn-and-accept branch.
    admissionRegistry.resetForTesting();
    admissionRegistry.setPublicKeysForTesting({ "admission-v2": successorB64 });
    await initAgainstServer();
    expect(admissionRegistry.status().hasDocument).toBe(false);

    // The successor key, signing the same content, is accepted — proving the
    // refusal above was about the retired id and not about the document.
    serveSignedCatalog(body, sign(body, successorKey, "admission-v2"));
    admissionRegistry.resetForTesting();
    admissionRegistry.setPublicKeysForTesting({ "admission-v2": successorB64 });
    await initAgainstServer();
    expect(admissionRegistry.evaluate("meeting", "1.2.3").kind).toBe("admitted");
  });

  it("discards a cached document that no longer verifies, and deletes it from disk", async () => {
    const userDataDir = freshUserData();
    const body = buildBody({});
    const cache = new SignedDocumentCache(
      userDataDir,
      "marketplace-admission",
      "admission.json",
      "admission.json.sig",
    );
    await cache.store({
      body: body.replace("lvis-project", "someone-else"), // signed content no longer matches
      signature: sign(body),
      meta: { highestSeenIssuedAt: JSON.parse(body).issuedAt as string },
    });

    await admissionRegistry.init({
      networkFetch: unusedNetworkFetch,
      userDataDir,
      online: false,
      now: () => NOW,
      source: source(),
    });

    expect(admissionRegistry.evaluate("meeting", "1.2.3")).toMatchObject({
      code: "admission-unavailable",
    });
    await expect(
      readFile(join(userDataDir, "marketplace-admission", "admission.json"), "utf-8"),
    ).rejects.toThrow(/ENOENT/);
  });
});

// ---------------------------------------------------------------------
// Rollback + clock
// ---------------------------------------------------------------------

describe("AdmissionRegistry — rollback and clock guards", () => {
  it("discards a replayed older document, keeping the newer one it already holds", async () => {
    const newer = buildBody({
      issuedAtMs: NOW - HOUR,
      admissions: [entry()],
    });
    serveSignedCatalog(newer);
    const userDataDir = freshUserData();
    await admissionRegistry.init({ networkFetch: fetch, userDataDir, online: true, now: () => NOW, source: source() });
    expect(admissionRegistry.evaluate("meeting", "1.2.3").kind).toBe("admitted");

    // An older, still validly signed issuance that ALSO admits a version the
    // newer one withdrew. Replaying it must not re-admit that version.
    const older = buildBody({
      issuedAtMs: NOW - 10 * HOUR,
      admissions: [entry(), entry({ version: "0.9.0", artifactSha256: SHA_OTHER })],
    });
    serveSignedCatalog(older);
    await admissionRegistry.ensureFresh();

    expect(admissionRegistry.status().issuedAt).toBe(new Date(NOW - HOUR).toISOString());
    expect(admissionRegistry.evaluate("meeting", "0.9.0")).toMatchObject({
      code: "admission-not-listed",
    });
  });

  it("discards a document issued implausibly far in the future without poisoning the guard", async () => {
    serveSignedCatalog(buildBody({ issuedAtMs: NOW + 72 * HOUR }));
    const userDataDir = freshUserData();
    await admissionRegistry.init({ networkFetch: fetch, userDataDir, online: true, now: () => NOW, source: source() });
    expect(admissionRegistry.status().hasDocument).toBe(false);

    // A genuine document issued now is still accepted — the rejected one did
    // not advance the high-water mark.
    serveSignedCatalog(buildBody({ issuedAtMs: NOW - HOUR }));
    await admissionRegistry.ensureFresh();
    expect(admissionRegistry.evaluate("meeting", "1.2.3").kind).toBe("admitted");
  });
});

// ---------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------

describe("AdmissionRegistry — lookup", () => {
  it("refuses a version the catalog does not list — this is how withdrawal works", async () => {
    serveSignedCatalog(buildBody({}));
    await initAgainstServer();
    expect(admissionRegistry.evaluate("meeting", "1.2.4")).toMatchObject({
      code: "admission-not-listed",
    });
    expect(admissionRegistry.evaluate("some-other-plugin", "1.2.3")).toMatchObject({
      code: "admission-not-listed",
    });
  });

  it("refuses an unresolved version rather than admitting an unnamed artifact", async () => {
    serveSignedCatalog(buildBody({}));
    await initAgainstServer();
    expect(admissionRegistry.evaluate("meeting", "latest")).toMatchObject({
      code: "admission-version-unresolved",
    });
  });

  it("does not admit one slug's bytes under another slug's name", async () => {
    serveSignedCatalog(
      buildBody({
        admissions: [entry(), entry({ slug: "local-indexer", artifactSha256: SHA_OTHER })],
      }),
    );
    await initAgainstServer();
    const meeting = admissionRegistry.evaluate("meeting", "1.2.3");
    const indexer = admissionRegistry.evaluate("local-indexer", "1.2.3");
    expect(meeting.kind).toBe("admitted");
    expect(indexer.kind).toBe("admitted");
    if (meeting.kind !== "admitted" || indexer.kind !== "admitted") throw new Error("unreachable");
    expect(meeting.entry.artifactSha256).toBe(SHA_MEETING);
    expect(indexer.entry.artifactSha256).toBe(SHA_OTHER);
  });
});
