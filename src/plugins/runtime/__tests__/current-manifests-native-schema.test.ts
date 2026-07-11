/**
 * Step-1 migration evidence — every CURRENT/published plugin manifest plus the
 * plugin-template manifest validates against the native @lvis/plugin-sdk
 * v5.21.0 schema through the host's real `buildManifestValidator()` +
 * `parsePluginJson()`, with the legacy-schema compatibility patches retired.
 *
 * The fixtures under `fixtures/current-plugin-manifests/` are verbatim copies of
 * the published `plugin.json` for each active plugin (fetched via `gh api`) at
 * the time of the v5.13.0 → v5.18.0 SDK bump:
 *   ms-graph 0.3.36, ep-api 0.17.23, meeting 0.5.27, work-assistant 0.10.3,
 *   local-indexer 0.5.1, plugin-template 0.1.1.
 *
 * This pins the migration claim: v5.21.0 carries hostSecrets, networkAccess,
 * requires.minAppVersion, networkAccess.allowPrivateNetworks, per-tool workerId,
 * marketplace-provider secret grants, and category-less tool schemas natively.
 * A regression that reintroduces a host compatibility patch dependency — or an
 * SDK schema change that rejects a shipped manifest — fails here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildManifestValidator, parsePluginJson } from "../manifest-validation.js";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "current-plugin-manifests",
);

const EXPECTED_IDS: Record<string, string> = {
  "ms-graph.plugin.json": "ms-graph",
  "ep-api.plugin.json": "ep-api",
  "meeting.plugin.json": "meeting",
  "work-assistant.plugin.json": "work-assistant",
  "local-indexer.plugin.json": "local-indexer",
  "plugin-template.plugin.json": "your-plugin-id",
};

describe("current plugin manifests — host-owned schema acceptance", () => {
  const files = readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".plugin.json"))
    .sort();

  it("fixtures cover every expected current plugin + the template", () => {
    expect(new Set(files)).toEqual(new Set(Object.keys(EXPECTED_IDS)));
  });

  for (const file of files) {
    it(`${file} parses + validates with no compat patch and carries no defaultMode`, async () => {
      const path = join(fixturesDir, file);

      // Native SDK schema dropped ui[].window.defaultMode — assert the
      // current manifest does not depend on the removed field.
      const raw = readFileSync(path, "utf-8");
      expect(raw).not.toContain("defaultMode");

      const validator = await buildManifestValidator();
      const parsed = await parsePluginJson(path, validator);
      expect(parsed.id).toBe(EXPECTED_IDS[file]);
    });
  }
});
