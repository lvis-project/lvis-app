import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  SENSITIVE_DIRS,
  hasSensitiveClusterPath,
  isSensitiveClusterPath,
  parseNulDelimitedGitPaths,
} from "../../scripts/check-cluster-sensitive-paths.mjs";

const SCRIPT = "scripts/check-cluster-sensitive-paths.mjs";

function nulPaths(...paths: string[]): Buffer {
  return Buffer.from(paths.map((path) => `${path}\0`).join(""), "utf8");
}

function runCli(input: Buffer) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: process.cwd(),
    input,
    encoding: "utf8",
  });
}

describe("cluster sensitive path classification", () => {
  it("detects production paths and excludes only that directory's __tests__ subtree", () => {
    expect(isSensitiveClusterPath("src/ipc/domain.ts")).toBe(true);
    expect(isSensitiveClusterPath("src/ipc/__tests__/domain.test.ts")).toBe(false);
    expect(isSensitiveClusterPath("src/ipc/__tests__.ts")).toBe(true);
    expect(isSensitiveClusterPath("src/ipc2/domain.ts")).toBe(false);
  });

  it("covers every configured sensitive directory with the same test exclusion", () => {
    for (const dir of SENSITIVE_DIRS) {
      expect(isSensitiveClusterPath(dir + "/runtime.ts")).toBe(true);
      expect(isSensitiveClusterPath(dir + "/__tests__/runtime.test.ts")).toBe(false);
    }
  });
  it("keeps production hits in either mixed production and test order", () => {
    const production = "src/ipc/domain.ts";
    const test = "src/ipc/__tests__/domain.test.ts";
    expect(hasSensitiveClusterPath([production, test])).toBe(true);
    expect(hasSensitiveClusterPath([test, production])).toBe(true);
  });

  it("keeps production hits when another sensitive directory contains only tests", () => {
    expect(
      hasSensitiveClusterPath([
        "src/permissions/__tests__/gate.test.ts",
        "src/audit/writer.ts",
      ]),
    ).toBe(true);
  });

  it("preserves conservative bare-file detection", () => {
    expect(isSensitiveClusterPath("src/preload.ts")).toBe(true);
    expect(isSensitiveClusterPath("src/preload-bridge.tsx")).toBe(true);
    expect(isSensitiveClusterPath("src/ipc-domain.js")).toBe(true);
  });

  it("treats malformed repository paths as sensitive", () => {
    for (const path of [
      "../src/ui.ts",
      "/src/ui.ts",
      "C:/src/ui.ts",
      "src\\ui.ts",
      "src//ui.ts",
      "src/./ui.ts",
    ]) {
      expect(isSensitiveClusterPath(path)).toBe(true);
    }
  });

  it("parses NUL-delimited Git paths and rejects malformed streams", () => {
    expect(parseNulDelimitedGitPaths(nulPaths("src/ui.ts", "src/ipc/domain.ts"))).toEqual([
      "src/ui.ts",
      "src/ipc/domain.ts",
    ]);
    expect(() => parseNulDelimitedGitPaths(Buffer.from("src/ui.ts"))).toThrow(
      "git-path-input-missing-terminal-nul",
    );
    expect(() => parseNulDelimitedGitPaths(Buffer.from("src/ui.ts\0\0"))).toThrow(
      "git-path-input-empty-record",
    );
  });

  it("returns stable CLI results for mixed, test-only, and empty path streams", () => {
    const mixed = runCli(
      nulPaths("src/ipc/__tests__/domain.test.ts", "src/ipc/domain.ts"),
    );
    expect(mixed.status).toBe(0);
    expect(mixed.stdout.trim()).toBe("sensitive");

    const testsOnly = runCli(nulPaths("src/ipc/__tests__/domain.test.ts"));
    expect(testsOnly.status).toBe(0);
    expect(testsOnly.stdout.trim()).toBe("clean");

    const empty = runCli(Buffer.alloc(0));
    expect(empty.status).toBe(0);
    expect(empty.stdout.trim()).toBe("clean");
  });

  it("fails the CLI for missing terminators and invalid UTF-8", () => {
    expect(runCli(Buffer.from("src/ui.ts")).status).not.toBe(0);
    expect(runCli(Buffer.from([0xff, 0x00])).status).not.toBe(0);
  });
});
