import { describe, expect, it } from "vitest";
import { readRepoFile } from "../../__tests__/test-helpers.js";

function metadataObjects(source: string): string[] {
  return [...source.matchAll(/\bmetadata\s*:\s*\{([^{}]*)\}/g)].map((match) => match[1]);
}

function propertyName(property: string): string | undefined {
  return /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(property)?.[1];
}

function isUnavailableMetadata(metadata: string): boolean {
  const properties = metadata.split(",").map((property) => property.trim()).filter(Boolean);
  // Spreads, computed keys and other nonliteral properties can overwrite any
  // field. Each required verdict must occur after the last such write.
  const lastUnknownWrite = properties.findLastIndex((property) => propertyName(property) === undefined);
  const expected = {
    sandboxed: /^sandboxed\s*:\s*false$/,
    sandboxAttempted: /^sandboxAttempted\s*:\s*true$/,
    isolation: /^isolation\s*:\s*(?:"unavailable"|'unavailable')$/,
  };
  return Object.entries(expected).every(([name, value]) => {
    const index = properties.findLastIndex((property) => propertyName(property) === name);
    return index > lastUnknownWrite && value.test(properties[index]);
  });
}

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
  const wrapFailure = implementation.slice(implementation.indexOf("} catch (err)"), implementation.indexOf("const [cmd, ...args]"));
  const emptyArgvFailure = implementation.slice(implementation.indexOf("if (cmd === undefined)"), implementation.indexOf("const childEnv"));
  const spawnFailure = implementation.slice(implementation.indexOf('child.on("error"'));
  for (const failure of [wrapFailure, emptyArgvFailure, spawnFailure]) {
    expect(metadataObjects(failure).some(isUnavailableMetadata)).toBe(true);
  }
  const failures = metadataObjects(implementation).filter((metadata) => /\bsandboxAttempted\s*:/.test(metadata));
  // Wrapper, argv, allocation and spawn failures cannot claim confinement.
  expect(failures).toHaveLength(expectedFailureSurfaces);
  for (const metadata of failures) expect(isUnavailableMetadata(metadata)).toBe(true);
}

describe("ASRT unavailable metadata", () => {
  it("does not claim isolation before Bash or PowerShell wrapper workloads start", () => {
    const source = readRepoFile("src/tools/shell-tools.ts");
    expectPreSpawnFailuresToBeUnavailable(source, "export async function spawnWithSandbox(", "async function spawnWithTimeout(", 4);
    expectPreSpawnFailuresToBeUnavailable(source, "async function spawnPowerShellWithSandbox(", "async function spawnPowerShell(", 5);
  });

  it("lets failure verdicts override preceding artifact metadata, but rejects later overrides", () => {
    const verdict = 'sandboxed: false, sandboxAttempted: true, isolation: "unavailable"';
    for (const prefix of ["", "...artifactMetadata, "]) {
      expect(isUnavailableMetadata(prefix + verdict)).toBe(true);
    }
    for (const suffix of ["...artifactMetadata", "sandboxed: true", "sandboxAttempted: false", 'isolation: "asrt"', "[unknownKey]: true"]) {
      expect(isUnavailableMetadata(verdict + ", " + suffix)).toBe(false);
    }
  });
});
