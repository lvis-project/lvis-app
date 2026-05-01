import { mkdirSync, readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as AjvModule from "ajv";
import * as AddFormatsModule from "ajv-formats";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Validates all JSON test-fixture files matching the manifest glob pattern
 * against schemas/plugin.schema.json. Throws on the first invalid fixture
 * so CI surfaces which file caused the failure with the AJV error path.
 *
 * This runs BEFORE any test file, catching schema drift introduced alongside
 * a schema change without requiring every test to opt in.
 */
async function validateJsonFixtures(): Promise<void> {
  const schemaPath = resolve(HERE, "schemas/plugin.schema.json");
  let schema: unknown;
  try {
    schema = JSON.parse(readFileSync(schemaPath, "utf-8"));
  } catch {
    // schema missing (non-standard build layout) — skip gracefully
    return;
  }

  const AjvAny = AjvModule as unknown as { default?: unknown };
  const AjvCtor = (AjvAny.default ?? AjvModule) as new (opts?: unknown) => {
    compile: (schema: unknown) => (data: unknown) => boolean;
    errorsText: (errors: unknown) => string;
  };
  const ajv = new AjvCtor({ strict: true, strictRequired: false, allErrors: true, allowUnionTypes: true });
  const AddAny = AddFormatsModule as unknown as { default?: unknown };
  const addFormats = (AddAny.default ?? AddFormatsModule) as (ajv: unknown) => void;
  addFormats(ajv);
  const validate = ajv.compile(schema);

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
        failures.push(`${relative(HERE, file)}: ${ajv.errorsText(validate.errors)}`);
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
