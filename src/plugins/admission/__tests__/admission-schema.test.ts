/**
 * Admission catalog schema validator tests.
 *
 * The property under test is the one that separates an ALLOW list from a
 * BLOCK list: a document that fails to parse and a document that legitimately
 * lists nothing must NOT produce the same value. The first is "we have no
 * statement"; the second is "the distributor admits nothing right now". Only
 * the second is something the issuer actually said.
 */
import { describe, it, expect } from "vitest";
import { parseAdmissionDocument } from "../admission-schema.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function doc(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    schemaVersion: 1,
    issuedAt: "2026-08-19T00:00:00.000Z",
    expiresAt: "2026-08-20T00:00:00.000Z",
    admissions: [
      {
        slug: "meeting",
        version: "1.2.3",
        artifactSha256: SHA_A,
        publisher: "lvis-project",
        admittedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
    ...overrides,
  });
}

describe("parseAdmissionDocument — accepts", () => {
  it("parses a well-formed document and preserves every bound field", () => {
    const parsed = parseAdmissionDocument(doc());
    expect(parsed.issuedAt).toBe("2026-08-19T00:00:00.000Z");
    expect(parsed.admissions).toEqual([
      {
        slug: "meeting",
        version: "1.2.3",
        artifactSha256: SHA_A,
        publisher: "lvis-project",
        admittedAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
  });

  it("parses an empty admissions list — a real statement, distinct from a parse failure", () => {
    const parsed = parseAdmissionDocument(doc({ admissions: [] }));
    expect(parsed.admissions).toEqual([]);
  });
});

describe("parseAdmissionDocument — rejects", () => {
  it("rejects a duplicate slug@version instead of picking one", () => {
    const raw = JSON.parse(doc()) as { admissions: unknown[] };
    raw.admissions.push({
      slug: "meeting",
      version: "1.2.3",
      artifactSha256: SHA_B,
      publisher: "someone-else",
      admittedAt: "2026-08-02T00:00:00.000Z",
    });
    expect(() => parseAdmissionDocument(JSON.stringify(raw))).toThrow(/duplicates an earlier entry/);
  });

  it("rejects an unrecognised root field", () => {
    expect(() => parseAdmissionDocument(doc({ blocked: [] }))).toThrow(
      /root has unrecognised field 'blocked'/,
    );
  });

  it("rejects an unrecognised entry field", () => {
    const raw = JSON.parse(doc()) as { admissions: Record<string, unknown>[] };
    raw.admissions[0]!.minAppVersion = "0.4.0";
    expect(() => parseAdmissionDocument(JSON.stringify(raw))).toThrow(
      /admissions\[0\] has unrecognised field 'minAppVersion'/,
    );
  });

  it("rejects expiresAt at or before issuedAt", () => {
    expect(() =>
      parseAdmissionDocument(doc({ expiresAt: "2026-08-19T00:00:00.000Z" })),
    ).toThrow(/expiresAt must be strictly greater than issuedAt/);
  });

  it("rejects a non-hex or wrong-length artifactSha256", () => {
    const raw = JSON.parse(doc()) as { admissions: Record<string, unknown>[] };
    raw.admissions[0]!.artifactSha256 = "A".repeat(64);
    expect(() => parseAdmissionDocument(JSON.stringify(raw))).toThrow(
      /must be 64 lowercase hex characters/,
    );
  });

  it("rejects a missing publisher — attribution is not optional", () => {
    const raw = JSON.parse(doc()) as { admissions: Record<string, unknown>[] };
    delete raw.admissions[0]!.publisher;
    expect(() => parseAdmissionDocument(JSON.stringify(raw))).toThrow(
      /publisher must be a non-empty string/,
    );
  });

  it("rejects a truncated body", () => {
    expect(() => parseAdmissionDocument(doc().slice(0, 60))).toThrow(/JSON parse error/);
  });

  it("rejects a JSON array at the root", () => {
    expect(() => parseAdmissionDocument("[]")).toThrow(/root must be an object/);
  });
});
