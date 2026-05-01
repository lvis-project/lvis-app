import { mkdirSync, readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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
 * Silently skips if schemas/plugin.schema.json is missing (non-standard build
 * layout) — this is intentional and logged so the skip is visible in CI.
 */
async function validateJsonFixtures(): Promise<void> {
  const validate = await buildManifestValidator(import.meta.url);
  if (!validate) {
    console.warn("[fixture-validator] schemas/plugin.schema.json not found — fixture validation skipped");
    return;
  }

  const patterns = [
    join(HERE, "src/**/__tests__/**/{manifest,plugin}*.json"),
    join(HERE, "src/**/__tests__/**/*-fixture.json"),
  ];

  const failures: string[] = [];
  for (const pattern of patterns) {
    for await (const file of glob(pattern)) {
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
