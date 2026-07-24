import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { mergeEvidenceFile } from "./evidence-file.js";

const roots: string[] = [];

function testRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lvis-evidence-file-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("mergeEvidenceFile", () => {
  it("atomically creates a private file and merges through one descriptor", () => {
    const evidencePath = join(testRoot(), "evidence.json");

    mergeEvidenceFile(evidencePath, { first: 1 });
    mergeEvidenceFile(evidencePath, { second: 2 });

    expect(JSON.parse(readFileSync(evidencePath, "utf8"))).toEqual({
      first: 1,
      second: 2,
    });
    expect(statSync(evidencePath).mode & 0o777).toBe(0o600);
  });

  it("rejects an existing file with group or other access", () => {
    const evidencePath = join(testRoot(), "evidence.json");
    writeFileSync(evidencePath, "{}\n", { mode: 0o600 });
    chmodSync(evidencePath, 0o644);

    expect(() => mergeEvidenceFile(evidencePath, { unsafe: true })).toThrow(
      "E2E evidence must be singly linked, owner-controlled, and private",
    );
    expect(readFileSync(evidencePath, "utf8")).toBe("{}\n");
  });

  it.skipIf(process.platform === "win32")("rejects symlinks without following them", () => {
    const root = testRoot();
    const target = join(root, "target.json");
    const evidencePath = join(root, "evidence.json");
    writeFileSync(target, "{}\n", { mode: 0o600 });
    symlinkSync(target, evidencePath);

    expect(() => mergeEvidenceFile(evidencePath, { unsafe: true })).toThrow();
    expect(readFileSync(target, "utf8")).toBe("{}\n");
  });

  it.skipIf(process.platform === "win32")("rejects hard-linked evidence files", () => {
    const root = testRoot();
    const target = join(root, "target.json");
    const evidencePath = join(root, "evidence.json");
    writeFileSync(target, "{}\n", { mode: 0o600 });
    linkSync(target, evidencePath);

    expect(() => mergeEvidenceFile(evidencePath, { unsafe: true })).toThrow(
      "E2E evidence must be singly linked, owner-controlled, and private",
    );
    expect(readFileSync(target, "utf8")).toBe("{}\n");
  });
});
