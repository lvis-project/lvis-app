/**
 * Schema / runtime contract guard (capabilities reduction, Ph1/Ph2).
 *
 * The manifest `capabilities` field is NO LONGER a closed enum mirrored from
 * `KNOWN_CAPABILITIES`. It is a free-form, format-validated string list, so an
 * installed manifest that still declares a removed/legacy capability
 * (mail-source, worker-client, …) validates and loads instead of being rejected
 * at schema validation. The host enforces only KNOWN_CAPABILITIES at runtime;
 * every other string is a harmless self-declaration.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KNOWN_CAPABILITIES } from "../capabilities.js";

async function loadCapabilitiesItemsSchema(): Promise<{
  enum?: string[];
  pattern?: string;
  type?: string;
}> {
  // Host-owned manifest schema SOT (ph2).
  const schemaPath = fileURLToPath(
    new URL("../../../schemas/plugin-manifest.schema.json", import.meta.url),
  );
  const schema = JSON.parse(await readFile(schemaPath, "utf-8")) as {
    properties: {
      capabilities: { items: { enum?: string[]; pattern?: string; type?: string } };
    };
  };
  return schema.properties.capabilities.items;
}

describe("capability schema contract (free-form, not a closed enum)", () => {
  it("capabilities items is a format-validated free-form string, not an enum", async () => {
    const items = await loadCapabilitiesItemsSchema();
    // No enum — an enum would reject installed manifests still declaring a
    // removed/legacy capability string and brick their load.
    expect(items.enum).toBeUndefined();
    expect(items.type).toBe("string");
    expect(typeof items.pattern).toBe("string");
  });

  it("every host-ENFORCED capability matches the schema pattern", async () => {
    const items = await loadCapabilitiesItemsSchema();
    const re = new RegExp(items.pattern!);
    // The two enforced strings (external-auth-consumer, host:overlay) must pass
    // the format-hygiene pattern — including the colon in host:overlay.
    for (const cap of KNOWN_CAPABILITIES) {
      expect(re.test(cap), `enforced cap '${cap}' must match schema pattern`).toBe(
        true,
      );
    }
    expect(KNOWN_CAPABILITIES.has("host:overlay")).toBe(true);
    expect(KNOWN_CAPABILITIES.has("external-auth-consumer")).toBe(true);
  });

  it("legacy / removed capability strings still validate (no install-brick)", async () => {
    const items = await loadCapabilitiesItemsSchema();
    const re = new RegExp(items.pattern!);
    // Removed from the enforced vocab but still valid free-form declarations on
    // already-installed manifests. worker-client is still a LIVE host discovery
    // key (findPluginIdByCapability in boot/tools.ts); the rest are harmless
    // no-ops. None may be rejected at schema validation.
    for (const legacy of [
      "worker-client",
      "mail-source",
      "calendar-source",
      "meeting-recorder",
      "knowledge-index",
      "ms-graph-consumer",
      "background-watcher",
      "document-indexer",
      "lifecycle-observer",
      "routine-provider",
    ]) {
      expect(re.test(legacy), `legacy cap '${legacy}' must still validate`).toBe(
        true,
      );
    }
  });
});
