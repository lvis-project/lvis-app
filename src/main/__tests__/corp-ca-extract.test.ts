/**
 * Certificate selection, and the Linux trust-anchor reader.
 *
 * The fixtures are throwaway self-signed certificates generated for this test.
 * They are parsed, never trusted: the point is that a real `X509Certificate`
 * subject is what the selector filters on, so the assertions below cannot pass
 * against a matcher that only looks at the PEM text.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  extractLinuxCorporateCa,
  selectCertificatesByCommonName,
  splitPemBlocks,
  subjectHasCommonName,
} from "../corp-ca-extract.js";

/** CN=Acme Root CA, O=Acme Corp — the certificate a corporate proxy would use. */
const ACME_PEM = `-----BEGIN CERTIFICATE-----
MIIDUTCCAjmgAwIBAgIUVaAwYHmyORSbzlihbNhfmEF+Xy0wDQYJKoZIhvcNAQEL
BQAwODELMAkGA1UEBhMCVVMxEjAQBgNVBAoMCUFjbWUgQ29ycDEVMBMGA1UEAwwM
QWNtZSBSb290IENBMB4XDTI2MDgyMjA0NDcxMVoXDTQ2MDgxNzA0NDcxMVowODEL
MAkGA1UEBhMCVVMxEjAQBgNVBAoMCUFjbWUgQ29ycDEVMBMGA1UEAwwMQWNtZSBS
b290IENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAotCPxN83Zr1s
Dl1FZlNwbhoKxq6Q7sor+dQMMeTMGZu6RReJQjZNtUVsCqAeXdaT/A91mzjMpRid
zeo86w6IOXJxlXDuJaxkyCmpEDz38ROqY/75q3k+pOTISUTnIzoa8A3KoHfop95Z
JMwvBuiudIdGNWskqnzW0AYJ00Loi5GiJUuq8ez3la8PEa+WLiCQ+TqLkjsYPqqC
qkXQC3bjf53UmO6ZVNc2/1gMra3XyM+CAKUpzEcODgPCe986P38oDL3vI7iNnhb7
KyEnhFnF/XDK2cGrgnJpcEGpagq0Ka/4PgJU9ApE67PuWbAhZSAAKdsUTvaqF7Xp
r7idojx66wIDAQABo1MwUTAdBgNVHQ4EFgQUq2/zkMDPCJiYhQEKnpGgo5TcDcUw
HwYDVR0jBBgwFoAUq2/zkMDPCJiYhQEKnpGgo5TcDcUwDwYDVR0TAQH/BAUwAwEB
/zANBgkqhkiG9w0BAQsFAAOCAQEAD0Py4Rww7E5VErChthQwRJilelTfVyCLe1eO
kXP7C52v38X2P59i0KSt8P4yGDgFENawc0fcaTKEVSdvFW6sRWuACGzL54xBau67
1uvfKElvVMKWo9esvfwzY7pQgeobCXjVG6STOfnfIt3GnoTzqwTywm4ThR/13Z0i
JeAj8iv9hew+m/k0k6dBwRUNJo0twrtv3ZStfD4rGt1mPKPAIEnTInlLa3n9Mhlj
izkvXzUvQoFS6U+evBSqZkm0y3W5rtquhTfw1Xg9ZxjD5iH8EOxsFxnW9ByrDgFT
RfPadnjMJ2Z8bPKGnXKfJ7MH4aEj3DvUefp7+mZyMio/kxx2tg==
-----END CERTIFICATE-----
`;

/** CN=Unrelated Public Root — the kind of anchor a system bundle is full of. */
const PUBLIC_PEM = `-----BEGIN CERTIFICATE-----
MIIDaTCCAlGgAwIBAgIUNl60WAR+jlZ1qYIPjQHAuTOME7MwDQYJKoZIhvcNAQEL
BQAwRDELMAkGA1UEBhMCVVMxFTATBgNVBAoMDFB1YmxpYyBUcnVzdDEeMBwGA1UE
AwwVVW5yZWxhdGVkIFB1YmxpYyBSb290MB4XDTI2MDgyMjA0NDcxMVoXDTQ2MDgx
NzA0NDcxMVowRDELMAkGA1UEBhMCVVMxFTATBgNVBAoMDFB1YmxpYyBUcnVzdDEe
MBwGA1UEAwwVVW5yZWxhdGVkIFB1YmxpYyBSb290MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAhNzXQkyLhPMpmaPeid+xe5f+K6TwpU0GUGxXhE7qqagS
HyfKJ+VG001pLOkepjjN56eKoW84zcdKWOxT8iqO4lbwdSbI9v49KUSOwLBZQduM
6j4/uU2BNkUqGUBrjK04VxAxTkZqnkLZ0EbPXuxui75X2iWYUMklUw4EON7SMIEZ
5sKauMq0wxRz7wab+FzF3Z29pbsDu22GO01VuBEZcXJWz3S1nOfSjUWkmXg1n8FB
NWVfiLWRN8md0XNbFFubLMmrqU2o5fZ733InqLViB1rLptWfrIBsfpSlyO5KhGqO
Gz7caqaJiJ6o+iMCsBviAJnajP2lw1qPY3/aqe77MwIDAQABo1MwUTAdBgNVHQ4E
FgQUvFiFZaWEmOdkV75bBMHZkJkFQAYwHwYDVR0jBBgwFoAUvFiFZaWEmOdkV75b
BMHZkJkFQAYwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAIXBh
ZZETeQUiRFL5Uq2rqZzSwQ/+JnuTqlReddaJ296xQa+MDvdc46eZ8+iZ0B2+5f5n
nxpHwfR/EOxYAOJTDkLrofCOHlQkoVgr/fpBopOcljjJ41t0eurqNs1+gqP3MHlO
PWQVsVKBsqX45fmwfwiu3Y/GR8aOf5RGrD77A+xYhz7x2DtjERwjFM6BnxASyDN+
1UtOeUZCNfISrajNlfaNFlMEks1unw3gInlaYMQjE0Igpz6s6VxDagrKqOGBbHoc
xyI7lxDdZYkC4V1pVyOTTV+STggfuOhhRohh32O6VoPvcP2/UCcKN7kQIfbz3HvS
yfNeLca0QToeWizTTw==
-----END CERTIFICATE-----
`;

/**
 * CN=Some Other Name, but O=Acme Root CA Holdings. Searching the whole subject
 * instead of the CN attribute would inject this certificate for a user who
 * typed "Acme Root CA" — which is why the selector reads the CN only.
 */
const ORG_ONLY_PEM = `-----BEGIN CERTIFICATE-----
MIIDbzCCAlegAwIBAgIUTmIjLHS69LpSJ2T8egpkTaLyMiYwDQYJKoZIhvcNAQEL
BQAwRzELMAkGA1UEBhMCVVMxHjAcBgNVBAoMFUFjbWUgUm9vdCBDQSBIb2xkaW5n
czEYMBYGA1UEAwwPU29tZSBPdGhlciBOYW1lMB4XDTI2MDgyMjA0NDcxMVoXDTQ2
MDgxNzA0NDcxMVowRzELMAkGA1UEBhMCVVMxHjAcBgNVBAoMFUFjbWUgUm9vdCBD
QSBIb2xkaW5nczEYMBYGA1UEAwwPU29tZSBPdGhlciBOYW1lMIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvk3cGsgvuKDQV1KSKGPozOJM6/tbBTpC1NLw
rOF3ZIcBkS9j+BOIeVanN8kuqAyojkRMDVqXiUPxZNGMm5EJ4lYOHoaIk9rsu/O6
DCJsd47x1MQyEUDEp436NYedrVn0BODmBqKk/mPmAfSU7I4kAADBB9YTwZpWv81J
0IyTOlIf8O/+D7/TC36l8bF1KP3IZC1TcBbDBfR7rMk/nnpOK0hdDztgHEKwwSXb
RI4N+2LutZyPolOKbvGj93VZfynfoI9/4UDeIJKgtNEuFH257CRj5WOw0Ifk4E8S
z1NCacb8yzdwFN77wsijfVXPKswMGUrPMwqHU7czBYx5VJuQrQIDAQABo1MwUTAd
BgNVHQ4EFgQUnDgpuu5KJDxT70++bfzUInuF1r4wHwYDVR0jBBgwFoAUnDgpuu5K
JDxT70++bfzUInuF1r4wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOC
AQEARmpyKSOnkM2++qlFNmwP0eCH0N5z40U8Jo6K9HL671vXWqyINNm9G4IpCTdI
/UUbO+/h5VkIhJrFerFo30hwioLJ7PiKZx0N+RjDcqzq/WP1JwEjTR9YLv4G0vGy
5sb6FpcqZg2q+G1KkB3C/IUdMPcyVyEJnkHW3Q0rkk864/ohKp9w6Kwt5ELBIELP
cchlqVEEH3IrAxwd6vDJ2Hrym036FCCc6D39f0bf8A93Mwm3Nda/GjCr65s8f8gu
4UpwaOFIG/pNzLpEQuaJUZj6vlaEK6D/bvFY7QIw3kFI37drH5Av/c8lGhx6eqRE
F4UCWc1/jKdaJG/fG6MIuGX8Gw==
-----END CERTIFICATE-----
`;

const CORP_CN = "Acme Root CA";

describe("splitPemBlocks", () => {
  it("returns one block per certificate", () => {
    expect(splitPemBlocks(ACME_PEM + PUBLIC_PEM)).toHaveLength(2);
  });

  it("drops the human-readable text a trust bundle puts between certificates", () => {
    // `/etc/ssl/certs/ca-certificates.crt` is exactly this shape, and
    // X509Certificate rejects a block that still has the heading attached.
    const bundle = `# Acme Root CA\nissuer=Acme\n${ACME_PEM}\n# Unrelated\n${PUBLIC_PEM}trailing junk`;
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

describe("subjectHasCommonName", () => {
  const subject = "C=US\nO=Acme Corp\nCN=Acme Root CA";

  it("matches part of the common name, ignoring case", () => {
    expect(subjectHasCommonName(subject, "Acme Root CA")).toBe(true);
    expect(subjectHasCommonName(subject, "acme root")).toBe(true);
    expect(subjectHasCommonName(subject, "CA")).toBe(true);
  });

  it("does not match an attribute other than the common name", () => {
    expect(subjectHasCommonName(subject, "Acme Corp")).toBe(false);
    expect(subjectHasCommonName(subject, "US")).toBe(false);
  });

  it("does not match a different certificate", () => {
    expect(subjectHasCommonName("C=US\nCN=Unrelated Public Root", CORP_CN)).toBe(false);
  });
});

describe("selectCertificatesByCommonName", () => {
  it("keeps only the certificate whose CN matches", () => {
    const selected = selectCertificatesByCommonName(PUBLIC_PEM + ACME_PEM, CORP_CN);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain("MIIDUTCCAjmgAwIBAgIUVaAwYHmyORSbzlihbNhfmEF+Xy0");
  });

  it("does not select a certificate that only matches on the organization", () => {
    expect(selectCertificatesByCommonName(ORG_ONLY_PEM, CORP_CN)).toEqual([]);
  });

  it("returns the same certificate once however many times the sources list it", () => {
    // Every distribution ships the same anchor in a bundle AND as a drop-in
    // file; injecting it twice would be pointless work on every request.
    expect(selectCertificatesByCommonName(ACME_PEM + ACME_PEM + ACME_PEM, CORP_CN))
      .toHaveLength(1);
  });

  it("skips a block that does not parse instead of giving up on the rest", () => {
    const corrupt =
      "-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n";
    expect(selectCertificatesByCommonName(corrupt + ACME_PEM, CORP_CN)).toHaveLength(1);
  });

  it("finds nothing when the name is not in the store", () => {
    expect(selectCertificatesByCommonName(PUBLIC_PEM, CORP_CN)).toEqual([]);
  });
});

describe("extractLinuxCorporateCa", () => {
  let root = "";
  let bundlePath = "";
  let anchorsDir = "";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "lvis-corp-ca-"));
    // A system bundle holding public roots plus the corporate one, and a
    // drop-in anchors directory holding the corporate one again — the layout an
    // administrator or an MDM actually produces.
    bundlePath = join(root, "ca-certificates.crt");
    await writeFile(bundlePath, `${PUBLIC_PEM}# Acme Root CA\n${ACME_PEM}`, "utf-8");
    anchorsDir = join(root, "anchors");
    await mkdir(anchorsDir);
    await writeFile(join(anchorsDir, "acme.crt"), ACME_PEM, "utf-8");
    await writeFile(join(anchorsDir, "public.pem"), PUBLIC_PEM, "utf-8");
    // Neither of these is a certificate; the reader must not choke on them.
    await writeFile(join(anchorsDir, "README"), "not a certificate", "utf-8");
    await writeFile(join(anchorsDir, "acme.crt.bak"), "junk", "utf-8");
  });

  afterAll(async () => {
    if (root !== "") await rm(root, { recursive: true, force: true });
  });

  it("finds the corporate certificate in a bundle file", async () => {
    const pem = await extractLinuxCorporateCa(CORP_CN, false, [bundlePath]);
    expect(pem).not.toBeNull();
    expect(splitPemBlocks(pem ?? "")).toHaveLength(1);
    expect(pem).not.toContain("VW5yZWxhdGVk");
  });

  it("finds it in a drop-in anchors directory too", async () => {
    const pem = await extractLinuxCorporateCa(CORP_CN, false, [anchorsDir]);
    expect(splitPemBlocks(pem ?? "")).toHaveLength(1);
  });

  it("returns the certificate once when several sources carry it", async () => {
    const pem = await extractLinuxCorporateCa(CORP_CN, false, [bundlePath, anchorsDir]);
    expect(splitPemBlocks(pem ?? "")).toHaveLength(1);
  });

  it("returns null when no anchor matches, which is the ordinary case", async () => {
    expect(await extractLinuxCorporateCa("No Such Root CA", false, [bundlePath, anchorsDir]))
      .toBeNull();
  });

  it("returns null instead of throwing when the paths do not exist", async () => {
    // The default source list names seven paths; a given distribution has one.
    expect(await extractLinuxCorporateCa(CORP_CN, false, [join(root, "absent")])).toBeNull();
  });
});
