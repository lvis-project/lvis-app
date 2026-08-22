/**
 * Certificate selection, the Linux trust-anchor reader, and the dispatcher that
 * is the only place the platform is branched on.
 *
 * The fixtures are real (throwaway) certificates, never trusted: the pipeline
 * parses every candidate and reads the subject off it, so these assertions
 * cannot pass against a matcher that only looks at the PEM text.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  countCertificates,
  extractCorporateCa,
  readLinuxTrustStore,
  selectCertificatesByCommonName,
  splitPemBlocks,
  subjectHasCommonName,
} from "../corp-ca-extract.js";
import {
  CORP_CA_G2_PEM,
  CORP_CA_PEM,
  ORG_ONLY_PEM,
  PUBLIC_ROOT_PEM,
} from "../../__tests__/support/corp-ca-fixtures.js";
import { DEFAULT_CORP_CA_COMMON_NAME } from "../../shared/corp-ca-common-name.js";

const CORP_CN = DEFAULT_CORP_CA_COMMON_NAME;
/** The distinctive first line of CORP_CA_PEM's base64, for identity checks. */
const CORP_CA_MARKER = "MIIDYTCCAkmgAwIBAgIULfTi5U5zbPkWOxKz15PeAvlDy60wDQYJKoZIhvcNAQEL";

describe("splitPemBlocks", () => {
  it("returns one block per certificate", () => {
    expect(splitPemBlocks(CORP_CA_PEM + PUBLIC_ROOT_PEM)).toHaveLength(2);
  });

  it("drops the human-readable text a trust bundle puts between certificates", () => {
    // `/etc/ssl/certs/ca-certificates.crt` is exactly this shape, and
    // X509Certificate rejects a block that still has the heading attached.
    const bundle =
      `# Corporate Root CA\nissuer=Example\n${CORP_CA_PEM}\n# Unrelated\n${PUBLIC_ROOT_PEM}junk`;
    const blocks = splitPemBlocks(bundle);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block.startsWith("-----BEGIN CERTIFICATE-----")).toBe(true);
      expect(block.trimEnd().endsWith("-----END CERTIFICATE-----")).toBe(true);
    }
  });

  it("returns nothing for text that holds no certificate", () => {
    expect(splitPemBlocks("")).toEqual([]);
    expect(splitPemBlocks("-----BEGIN CERTIFICATE-----\ntruncated")).toEqual([]);
  });
});

describe("countCertificates", () => {
  it("counts complete blocks, not opening markers", () => {
    // A cache truncated mid-write has the marker and nothing usable; the
    // runtime treats that as a miss and re-extracts, which is why this counts
    // parseable blocks rather than tallying BEGIN lines.
    expect(countCertificates(CORP_CA_PEM + CORP_CA_G2_PEM)).toBe(2);
    expect(countCertificates("-----BEGIN CERTIFICATE-----\nMIIDYTCC")).toBe(0);
    expect(countCertificates("")).toBe(0);
  });
});

describe("subjectHasCommonName", () => {
  const subject = "C=US\nO=Example Corp\nCN=Corporate Root CA";

  it("matches part of the common name, ignoring case", () => {
    expect(subjectHasCommonName(subject, "Corporate Root CA")).toBe(true);
    expect(subjectHasCommonName(subject, "corporate root")).toBe(true);
    expect(subjectHasCommonName(subject, "CA")).toBe(true);
  });

  it("does not match an attribute other than the common name", () => {
    expect(subjectHasCommonName(subject, "Example Corp")).toBe(false);
    expect(subjectHasCommonName(subject, "US")).toBe(false);
  });

  it("does not match a different certificate", () => {
    expect(subjectHasCommonName("C=US\nCN=Unrelated Public Root", CORP_CN)).toBe(false);
  });
});

describe("selectCertificatesByCommonName", () => {
  it("keeps only the certificates whose CN matches", () => {
    const selected = selectCertificatesByCommonName(
      PUBLIC_ROOT_PEM + CORP_CA_PEM + CORP_CA_G2_PEM,
      CORP_CN,
    );
    expect(selected).toHaveLength(2);
    expect(selected[0]).toContain(CORP_CA_MARKER);
  });

  it("does not select a certificate that only matches on the organization", () => {
    expect(selectCertificatesByCommonName(ORG_ONLY_PEM, CORP_CN)).toEqual([]);
  });

  it("returns the same certificate once however many times the sources list it", () => {
    // Every distribution ships the same anchor in a bundle AND as a drop-in
    // file; injecting it twice would be pointless work on every request.
    expect(selectCertificatesByCommonName(CORP_CA_PEM + CORP_CA_PEM + CORP_CA_PEM, CORP_CN))
      .toHaveLength(1);
  });

  it("skips a block that does not parse instead of giving up on the rest", () => {
    const corrupt =
      "-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n";
    expect(selectCertificatesByCommonName(corrupt + CORP_CA_PEM, CORP_CN)).toHaveLength(1);
  });

  it("finds nothing when the name is not in the store", () => {
    expect(selectCertificatesByCommonName(PUBLIC_ROOT_PEM, CORP_CN)).toEqual([]);
  });
});

describe("extractCorporateCa on Linux", () => {
  let root = "";
  let bundlePath = "";
  let anchorsDir = "";

  /**
   * The real pipeline with the real Linux reader, pointed at a temp directory.
   * Going through `extractCorporateCa` rather than the reader alone is the
   * point: selection, deduplication, and the cap are shared with the other two
   * platforms, so this covers what those platforms do with what they read.
   */
  const extractFrom = async (
    commonName: string,
    sources: readonly string[],
  ): Promise<string | null> =>
    extractCorporateCa({ commonName, debugLog: false }, "linux", {
      linux: (lookup) => readLinuxTrustStore(lookup, sources),
    });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "lvis-corp-ca-"));
    // A system bundle holding public roots plus the corporate one, and a
    // drop-in anchors directory holding the corporate one again — the layout an
    // administrator or an MDM actually produces.
    bundlePath = join(root, "ca-certificates.crt");
    await writeFile(bundlePath, `${PUBLIC_ROOT_PEM}# Corporate Root CA\n${CORP_CA_PEM}`, "utf-8");
    anchorsDir = join(root, "anchors");
    await mkdir(anchorsDir);
    await writeFile(join(anchorsDir, "corp.crt"), CORP_CA_PEM, "utf-8");
    await writeFile(join(anchorsDir, "public.pem"), PUBLIC_ROOT_PEM, "utf-8");
    // Neither of these is a certificate; the reader must not choke on them.
    await writeFile(join(anchorsDir, "README"), "not a certificate", "utf-8");
    await writeFile(join(anchorsDir, "corp.crt.bak"), "junk", "utf-8");
  });

  afterAll(async () => {
    if (root !== "") await rm(root, { recursive: true, force: true });
  });

  it("finds the corporate certificate in a bundle file", async () => {
    const pem = await extractFrom(CORP_CN, [bundlePath]);
    expect(pem).not.toBeNull();
    expect(countCertificates(pem ?? "")).toBe(1);
    expect(pem).toContain(CORP_CA_MARKER);
  });

  it("finds it in a drop-in anchors directory too", async () => {
    expect(countCertificates((await extractFrom(CORP_CN, [anchorsDir])) ?? "")).toBe(1);
  });

  it("returns the certificate once when several sources carry it", async () => {
    expect(countCertificates((await extractFrom(CORP_CN, [bundlePath, anchorsDir])) ?? "")).toBe(1);
  });

  it("returns null when no anchor matches, which is the ordinary case", async () => {
    expect(await extractFrom("No Such Root CA", [bundlePath, anchorsDir])).toBeNull();
  });

  it("returns null instead of throwing when the paths do not exist", async () => {
    // The default source list names seven paths; a given distribution has one.
    expect(await extractFrom(CORP_CN, [join(root, "absent")])).toBeNull();
  });
});

describe("extractCorporateCa", () => {
  const lookup = { commonName: CORP_CN, debugLog: false };

  it("filters what a platform reader returns rather than trusting it", async () => {
    // The guarantee that lets the three readers stay this thin: a reader that
    // returns more than it was asked for — a store filter that matched loosely,
    // a tool whose output shape changed — cannot widen what gets injected.
    const pem = await extractCorporateCa(lookup, "linux", {
      linux: async () => PUBLIC_ROOT_PEM + CORP_CA_PEM + ORG_ONLY_PEM + "garbage",
    });
    expect(countCertificates(pem ?? "")).toBe(1);
    expect(pem).toContain(CORP_CA_MARKER);
  });

  it("returns null when the reader finds nothing", async () => {
    expect(await extractCorporateCa(lookup, "linux", { linux: async () => "" })).toBeNull();
  });

  it("returns null on a platform with no reader instead of throwing", async () => {
    // Boot must survive an OS this build has no lookup for; the caller keeps
    // the default verification and says so.
    expect(await extractCorporateCa(lookup, "aix")).toBeNull();
  });
});
