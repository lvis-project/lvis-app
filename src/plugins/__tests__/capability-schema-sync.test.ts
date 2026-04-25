/**
 * Schema / runtime drift guard.
 *
 * `KNOWN_CAPABILITIES` (runtime) and the AJV `capabilities[].items.enum`
 * (`schemas/plugin.schema.json`) are two hand-maintained sources of truth.
 * When they drift, a plugin manifest declaring a runtime-known capability
 * is rejected at schema validation (step 2 of §2.4) BEFORE the runtime
 * gate ever runs — i.e., the feature looks broken with no useful error.
 *
 * Copilot review on PR #215 caught `conversation-trigger` missing from
 * the schema enum; this test prevents the next regression.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { KNOWN_CAPABILITIES } from "../capabilities.js";

describe("capability schema/runtime sync", () => {
  it("schema enum equals KNOWN_CAPABILITIES", async () => {
    const schemaPath = resolve(__dirname, "../../../schemas/plugin.schema.json");
    const raw = await readFile(schemaPath, "utf-8");
    const schema = JSON.parse(raw) as {
      properties: { capabilities: { items: { enum: string[] } } };
    };
    const schemaEnum = new Set(schema.properties.capabilities.items.enum);
    const runtimeSet = new Set(KNOWN_CAPABILITIES);

    const missingInSchema = [...runtimeSet].filter((c) => !schemaEnum.has(c));
    const missingInRuntime = [...schemaEnum].filter((c) => !runtimeSet.has(c));

    expect(missingInSchema).toEqual([]);
    expect(missingInRuntime).toEqual([]);
  });
});
