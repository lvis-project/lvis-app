import { linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeCandidateDiagnostics } from "../../scripts/sanitize-candidate-diagnostics.mjs";

function withTempDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "lvis-candidate-diagnostics-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("candidate diagnostic sanitizer", () => {
  it("copies only regular candidate files into a fresh output tree", () => {
    withTempDirectory((directory) => {
      const input = join(directory, "input");
      const output = join(directory, "output");
      mkdirSync(join(input, "nested"), { recursive: true });
      writeFileSync(join(input, "nested", "trace.txt"), "safe trace", "utf8");

      expect(sanitizeCandidateDiagnostics(input, output)).toMatchObject({
        directories: 2,
        files: 1,
        bytes: 10,
      });
      expect(readFileSync(join(output, "nested", "trace.txt"), "utf8")).toBe("safe trace");
    });
  });

  it("runs as a Node CLI on the workflow runner", () => {
    withTempDirectory((directory) => {
      const input = join(directory, "input");
      const output = join(directory, "output");
      mkdirSync(input);
      writeFileSync(join(input, "trace.txt"), "safe trace", "utf8");

      const result = spawnSync(
        process.execPath,
        [resolve("scripts/sanitize-candidate-diagnostics.mjs"), input, output],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Sanitized candidate diagnostics:");
      expect(readFileSync(join(output, "trace.txt"), "utf8")).toBe("safe trace");
    });
  });

  it("rejects a symbolic link without following its target", () => {
    withTempDirectory((directory) => {
      const input = join(directory, "input");
      const output = join(directory, "output");
      const outside = join(directory, "outside-secret.txt");
      mkdirSync(input);
      writeFileSync(outside, "must not be copied", "utf8");
      try {
        symlinkSync(outside, join(input, "leak"));
      } catch (error) {
        if (process.platform === "win32") return;
        throw error;
      }

      expect(() => sanitizeCandidateDiagnostics(input, output)).toThrow(
        "symbolic links",
      );
    });
  });

  it("rejects a hard-linked file", () => {
    withTempDirectory((directory) => {
      const input = join(directory, "input");
      const output = join(directory, "output");
      mkdirSync(input);
      const original = join(input, "original.txt");
      writeFileSync(original, "must not be linked", "utf8");
      try {
        linkSync(original, join(input, "linked.txt"));
      } catch (error) {
        if (process.platform === "win32") return;
        throw error;
      }

      expect(() => sanitizeCandidateDiagnostics(input, output)).toThrow(
        "hard-linked files",
      );
    });
  });
});
