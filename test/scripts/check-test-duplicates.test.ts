import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeDuplicateHelpers,
  collectDuplicateBodies,
  collectHelpers,
  isScannedTestSource,
  normalizeRepoPath,
  runDuplicateCli,
} from "../../scripts/check-test-duplicates.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
    expect(isScannedTestSource("test/e2e/ui/fixtures.ts")).toBe(true);
    expect(isScannedTestSource("test/renderer/render-app.tsx")).toBe(true);
    expect(isScannedTestSource("test/e2e/ui/inline-settings.ts")).toBe(true);
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

  it("skips transient .worktrees checkouts", () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-duplicate-worktrees-"));
    try {
      const nestedRoot = join(root, ".worktrees", "agent");
      mkdirSync(nestedRoot, { recursive: true });
      writeFileSync(join(root, "visible.test.ts"), "function makeVisible() { return { ok: true }; }\n");
      writeFileSync(join(nestedRoot, "hidden.test.ts"), "function makeHidden() { return { ok: true }; }\n");

      const result = analyzeDuplicateHelpers(root);

      expect(result.files.map((file: string) => normalizeRepoPath(file, root))).toEqual([
        "visible.test.ts",
      ]);
      expect(result.duplicateBodies).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

      expect(result.files.map((file: string) => normalizeRepoPath(file, root)).sort()).toEqual([
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

  it("reports two short identical helpers in two files regardless of length", () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-duplicate-short-cross-file-"));
    try {
      // 40 characters of body, plain names — below the old floor, no prefix.
      const body = "{ tracked.add(dir); return dir; }";
      expect(body.length).toBeLessThan(80);
      writeFileSync(join(root, "one.test.ts"), `const tracked = new Set<string>();\nfunction trackDir(dir: string) ${body}\n`);
      writeFileSync(join(root, "two.test.ts"), `const tracked = new Set<string>();\nfunction keepDir(dir: string) ${body}\n`);

      const result = analyzeDuplicateHelpers(root);

      expect(result.duplicateBodies).toHaveLength(1);
      expect([...result.duplicateBodies[0].uniqueNames].sort()).toEqual(["keepDir", "trackDir"]);
      expect(result.duplicateBodies[0].uniqueLocations.size).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a short same-file pair that differs only in defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-duplicate-short-same-file-"));
    try {
      writeFileSync(
        join(root, "one.test.ts"),
        [
          "function isoFromNow(offsetMs: number) { return new Date(Date.now() + offsetMs).toISOString(); }",
          "function futureIso(offsetMs = 60_000) { return isoFromNow(offsetMs); }",
          "function pastIso(offsetMs = -1000) { return isoFromNow(offsetMs); }",
          "",
        ].join("\n"),
      );

      expect(analyzeDuplicateHelpers(root).duplicateBodies).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores closures nested in a helper or a test body, and placeholder bodies", () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-duplicate-nested-"));
    try {
      const nested = [
        'import { it } from "vitest";',
        "function wait(): Promise<void> {",
        "  return new Promise((resolve) => { const release = () => { resolve(); }; setTimeout(release, 1); });",
        "}",
        'it("x", () => { const local = () => { return [1, 2, 3].length; }; local(); });',
        "function noop() {}",
        "const nothing = () => undefined;",
        "",
      ].join("\n");
      writeFileSync(join(root, "one.test.ts"), nested);
      writeFileSync(join(root, "two.test.ts"), nested.replace("function wait", "function pause"));

      // wait/pause share a body and ARE reported; the nested release, the
      // test-local `local`, and the empty noop/nothing are not.
      const groups = analyzeDuplicateHelpers(root).duplicateBodies;
      expect(groups).toHaveLength(1);
      expect([...groups[0].uniqueNames].sort()).toEqual(["pause", "wait"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds no duplicate helper bodies in the repository's own suites", () => {
    const result = analyzeDuplicateHelpers(REPO_ROOT);
    expect(result.files.length).toBeGreaterThan(1000);
    const report = result.duplicateBodies.map(
      (group) => `${[...group.uniqueNames].join("/")}: ${[...group.uniqueLocations].join(", ")}`,
    );
    expect(report).toEqual([]);
  }, 120_000);
});
