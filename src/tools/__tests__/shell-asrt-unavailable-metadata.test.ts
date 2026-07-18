import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const unavailableMetadata =
  'metadata: { sandboxed: false, sandboxAttempted: true, isolation: "unavailable" }';

function source(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function expectPreSpawnFailuresToBeUnavailable(
  sourceText: string,
  functionStart: string,
  functionEnd: string,
): void {
  const start = sourceText.indexOf(functionStart);
  const end = sourceText.indexOf(functionEnd, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const implementation = sourceText.slice(start, end);

  const wrapFailure = implementation.slice(
    implementation.indexOf("} catch (err)"),
    implementation.indexOf("const [cmd, ...args]"),
  );
  const emptyArgvFailure = implementation.slice(
    implementation.indexOf("if (cmd === undefined)"),
    implementation.indexOf("const childEnv"),
  );
  const spawnFailure = implementation.slice(
    implementation.indexOf('child.on("error"'),
  );

  expect(wrapFailure).toContain(unavailableMetadata);
  expect(emptyArgvFailure).toContain(unavailableMetadata);
  expect(spawnFailure).toContain(unavailableMetadata);
  expect(implementation.match(new RegExp(unavailableMetadata.replace(/[{}]/g, "\\$&"), "g"))).toHaveLength(3);
}

describe("ASRT unavailable metadata", () => {
  it("does not claim isolation before Bash or PowerShell wrapper workloads start", () => {
    expectPreSpawnFailuresToBeUnavailable(
      source("src/tools/bash.ts"),
      "export async function spawnWithSandbox(",
      "async function spawnWithTimeout(",
    );
    expectPreSpawnFailuresToBeUnavailable(
      source("src/tools/powershell.ts"),
      "async function spawnPowerShellWithSandbox(",
      "async function spawnPowerShell(",
    );
  });
});