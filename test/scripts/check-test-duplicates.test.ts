import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeDuplicateHelpers,
  collectDuplicateBodies,
  collectHelpers,
  isScannedTestSource,
  normalizeRepoPath,
  runDuplicateCli,
} from "../../scripts/check-test-duplicates.mjs";

describe("check-test-duplicates", () => {
  it("scans test specs and shared helper modules", () => {
    expect(isScannedTestSource("runtime.test.ts")).toBe(true);
    expect(isScannedTestSource("runtime.spec.tsx")).toBe(true);
    expect(isScannedTestSource("test-helpers.ts")).toBe(true);
    expect(isScannedTestSource("conversation-loop-test-helpers.ts")).toBe(true);
    expect(isScannedTestSource("helpers.ts")).toBe(true);
    expect(isScannedTestSource("_helpers.ts")).toBe(true);
    expect(isScannedTestSource("fixtures.ts")).toBe(true);
    expect(isScannedTestSource("test/fixture-support.ts")).toBe(true);
    expect(isScannedTestSource("test/e2e/agent-hub/fixtures/agent-hub-mock-server.ts")).toBe(true);
    expect(isScannedTestSource("test/renderer/render-app.tsx")).toBe(true);
    expect(isScannedTestSource("test/e2e/ui/settings-window.ts")).toBe(true);
    expect(isScannedTestSource("src/shared/__tests__/fake-llm-settings.ts")).toBe(true);
    expect(isScannedTestSource("src/engine/demo-autoplay/fake-sandbox.ts")).toBe(false);
    expect(isScannedTestSource("mock-lvis-api.ts")).toBe(true);
    expect(isScannedTestSource("runtime.ts")).toBe(false);
  });

  it("evaluates test support paths relative to the repository root", () => {
    const root = "/tmp/test/lvis-app";

    expect(normalizeRepoPath("/tmp/test/lvis-app/test/renderer/render-app.tsx", root)).toBe(
      "test/renderer/render-app.tsx",
    );
    expect(isScannedTestSource("/tmp/test/lvis-app/test/renderer/render-app.tsx", root)).toBe(true);
    expect(isScannedTestSource("/tmp/test/lvis-app/src/main/production.ts", root)).toBe(false);
    expect(isScannedTestSource("/tmp/test/lvis-app/src/shared/__tests__/fixture-support.ts", root)).toBe(true);
  });

  it("detects substantial duplicate helpers without requiring prefix names", () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-duplicate-general-name-"));
    try {
      const body = [
        "const out: string[] = [];",
        "for (const item of input) out.push(String(item));",
        "return out.join(',');",
      ].join(" ");
      writeFileSync(join(root, "one.test.ts"), `function collect(input: unknown[]) { ${body} }\n`);
      writeFileSync(join(root, "two.test.ts"), `function invoke(input: unknown[]) { ${body} }\n`);

      const result = analyzeDuplicateHelpers(root);

      expect(result.duplicateBodies).toHaveLength(1);
      expect([...result.duplicateBodies[0].uniqueNames].sort()).toEqual([
        "collect",
        "invoke",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects substantial duplicate bodies for generic setup fixture names", () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-duplicate-generic-helper-"));
    try {
      const body = [
        "const output: string[] = [];",
        "for (const value of input) output.push(String(value));",
        "return output.join(':');",
      ].join(" ");
      writeFileSync(join(root, "one.test.ts"), `function setup(input: unknown[]) { ${body} }\n`);
      writeFileSync(join(root, "two.test.ts"), `function fixture(input: unknown[]) { ${body} }\n`);

      const result = analyzeDuplicateHelpers(root);

      expect(result.duplicateBodies).toHaveLength(1);
      expect([...result.duplicateBodies[0].uniqueNames].sort()).toEqual([
        "fixture",
        "setup",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects duplicate helper bodies across helper modules", () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-duplicate-helper-"));
    try {
      const specPath = join(root, "runtime.test.ts");
      const helperPath = join(root, "test-helpers.ts");
      writeFileSync(specPath, "function makeAlpha() { return { ok: true }; }\n");
      writeFileSync(helperPath, "export function makeBeta() { return { ok: true }; }\n");

      const { byBody } = collectHelpers([specPath, helperPath], root);
      const duplicates = collectDuplicateBodies(byBody);

      expect(duplicates).toHaveLength(1);
      expect([...duplicates[0].uniqueLocations].sort()).toEqual([
        "runtime.test.ts",
        "test-helpers.ts",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats stub helpers as duplicate-check candidates", () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-duplicate-stub-"));
    try {
      writeFileSync(
        join(root, "one.test.ts"),
        "function stubAlpha() { return { permitted: false }; }\n",
      );
      writeFileSync(
        join(root, "two.test.ts"),
        "function stubBeta() { return { permitted: false }; }\n",
      );

      const result = analyzeDuplicateHelpers(root);

      expect(result.files.map((file) => file.replace(`${root}/`, "")).sort()).toEqual([
        "one.test.ts",
        "two.test.ts",
      ]);
      expect(result.duplicateBodies).toHaveLength(1);
      expect([...result.duplicateBodies[0].uniqueNames].sort()).toEqual([
        "stubAlpha",
        "stubBeta",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects duplicate helper bodies within the same file", () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-duplicate-same-file-"));
    try {
      writeFileSync(
        join(root, "runtime.test.ts"),
        [
          "function makeAlpha() { return { ok: true }; }",
          "function makeBeta() { return { ok: true }; }",
          "",
        ].join("\n"),
      );

      const result = analyzeDuplicateHelpers(root);

      expect(result.duplicateBodies).toHaveLength(1);
      expect(result.duplicateBodies[0].uniqueLocations.size).toBe(1);
      expect([...result.duplicateBodies[0].uniqueNames].sort()).toEqual([
        "makeAlpha",
        "makeBeta",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails the CLI when duplicate helpers are present", () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-duplicate-cli-"));
    try {
      writeFileSync(
        join(root, "runtime.test.ts"),
        [
          "function makeAlpha() { return { ok: true }; }",
          "function makeBeta() { return { ok: true }; }",
          "",
        ].join("\n"),
      );

      const stdout: string[] = [];
      const stderr: string[] = [];
      const status = runDuplicateCli(["--fail-on-duplicates"], {
        root,
        stdout: (line: string) => stdout.push(line),
        stderr: (line: string) => stderr.push(line),
      });

      expect(status).toBe(1);
      expect(stdout.join("\n")).toContain("duplicate helper implementations: 1");
      expect(stdout.join("\n")).toContain("runtime.test.ts:1");
      expect(stdout.join("\n")).toContain("runtime.test.ts:2");
      expect(stderr.join("\n")).toContain("Duplicate test helper implementations remain");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
