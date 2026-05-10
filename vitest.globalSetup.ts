import { mkdirSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifestValidator } from "./src/plugins/runtime/manifest-validation.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Validates all JSON test-fixture files matching the manifest glob pattern
 * against schemas/plugin.schema.json using the same AJV instance as the
 * production runtime (buildManifestValidator). Collects all failures before
 * throwing so CI surfaces every broken fixture in one pass.
 *
 * This runs BEFORE any test file, catching schema drift introduced alongside
 * a schema change without requiring every test to opt in.
 *
 * Fails closed if the SDK schema cannot be resolved. The host does not keep an
 * app-local schema copy.
 */
async function validateJsonFixtures(): Promise<void> {
  const validate = await buildManifestValidator();

  const jsonFixtures = await collectJsonFixtures(join(HERE, "src"));

  const failures: string[] = [];
  for (const file of jsonFixtures) {
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      failures.push(`${relative(HERE, file)}: not valid JSON`);
      continue;
    }
    if (!validate(data)) {
      failures.push(`${relative(HERE, file)}: ${validate.errors?.map((e) => `${e.instancePath} ${e.message}`).join(", ") ?? "unknown error"}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`[fixture-validator] ${failures.length} manifest fixture(s) fail schema:\n${failures.join("\n")}`);
  }
}

/**
 * Vitest global setup — creates ~/.lvis/test-tmp/ before any tests run.
 *
 * Tests use ~/.lvis/test-tmp/ as the base directory for mkdtempSync() to
 * avoid Windows 8.3 short-path (RUNNER~1) issues with os.tmpdir().
 * mkdtempSync() requires the parent directory to already exist.
 */
export async function setup(): Promise<void> {
  mkdirSync(join(homedir(), ".lvis", "test-tmp"), { recursive: true });
  await validateJsonFixtures();
}

/** Recursively collect JSON files matching manifest/plugin/*-fixture naming under __tests__ dirs. */
async function collectJsonFixtures(root: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (
        entry.isFile()
        && entry.name.endsWith(".json")
        && dir.includes("__tests__")
        && (
          entry.name.startsWith("manifest")
          || entry.name.startsWith("plugin")
          || entry.name.endsWith("-fixture.json")
        )
      ) {
        results.push(full);
      }
    }
  }
  await walk(root);
  return results;
}
