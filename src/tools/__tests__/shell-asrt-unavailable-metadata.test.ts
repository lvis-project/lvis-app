import { describe, expect, it } from "vitest";
import { readRepoFile } from "../../__tests__/test-helpers.js";

const unavailableMetadata =
  'metadata: { sandboxed: false, sandboxAttempted: true, isolation: "unavailable" }';

function expectPreSpawnFailuresToBeUnavailable(
  sourceText: string,
  functionStart: string,
  functionEnd: string,
  expectedFailureSurfaces: number,
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
  const unavailableMetadataOccurrences = implementation.split(unavailableMetadata).length - 1;
  // Bash HOME allocation is now earlier host preparation, before ASRT begins.
  // Wrapper/argv/spawn failures still cannot claim a confined workload.
  expect(unavailableMetadataOccurrences).toBe(expectedFailureSurfaces);
}

describe("ASRT unavailable metadata", () => {
  it("does not claim isolation before Bash or PowerShell wrapper workloads start", () => {
    expectPreSpawnFailuresToBeUnavailable(
      readRepoFile("src/tools/shell-tools.ts"),
      "export async function spawnWithSandbox(",
      "async function spawnWithTimeout(",
      4,
    );
    expectPreSpawnFailuresToBeUnavailable(
      readRepoFile("src/tools/shell-tools.ts"),
      "async function spawnPowerShellWithSandbox(",
      "async function spawnPowerShell(",
      5,
    );
  });
});
