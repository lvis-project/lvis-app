/**
 * M4 E2E — lvis-app installer ↔ lvis-marketplace server.
 *
 * End-to-end scenario:
 *   1. Publish a minimal signed plugin zip against a live marketplace server
 *      using the /api/v1/plugins/{slug}/versions publisher endpoint.
 *   2. Load the Host's embedded ed25519 trust anchors.
 *   3. Run `installFromMarketplace()` with a real HTTP client against the
 *      live server — exercises downloadArtifact + fetchSignatureEnvelope +
 *      SHA-256 cross-check + envelope verification + atomic tarball persist.
 *   4. Unzip the persisted artifact and assert the plugin.json smoke handler
 *      is reachable.
 *
 * Skipped by default: CI stays fast. Opt-in by setting M4_E2E=1 and pointing
 * MARKETPLACE_URL + MARKETPLACE_PUBLISHER_KEY at a running server. The
 * accompanying workflow (.github/workflows/m4-e2e.yml) spins the server up
 * via docker compose in the lvis-marketplace repo.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { installFromMarketplace } from "../../src/plugins/marketplace-installer.js";
import { getBundledPublicKeys } from "../../src/plugins/publisher-keys.js";
import {
  buildPluginZip,
  makeLiveHttp,
  publishPlugin,
} from "./marketplace-e2e-fixture.js";

const E2E_ENABLED = process.env.M4_E2E === "1";
const BASE_URL = (process.env.MARKETPLACE_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const PUBLISHER_KEY = process.env.MARKETPLACE_PUBLISHER_KEY ?? "";

describe.skipIf(!E2E_ENABLED)("M4 E2E — marketplace ↔ app installer", () => {
  it("publishes, downloads, verifies signature, extracts plugin", async () => {
    if (!PUBLISHER_KEY) {
      throw new Error(
        "MARKETPLACE_PUBLISHER_KEY env var is required when M4_E2E=1",
      );
    }
    // Unique slug per run to avoid semver-conflict 409 on repeated runs.
    const suffix = Math.random().toString(36).slice(2, 8);
    const slug = `m4-e2e-${suffix}`;
    const version = "1.0.0";
    const zipBytes = buildPluginZip(slug, version);
    const expectedSha = createHash("sha256").update(zipBytes).digest("hex");

    // 1. Publish
    await publishPlugin(BASE_URL, PUBLISHER_KEY, slug, version, zipBytes);

    // 2. Use the Host-owned trust anchors. Trusting `/api/v1/keys` from the
    // same server that supplied the artifact would let a substituted server
    // authorize its own signing key and turn this into a self-signed test.
    const publicKeys = getBundledPublicKeys();

    // 3. Install via the real installer flow
    const downloadRoot = mkdtempSync(resolve(tmpdir(), "m4-e2e-"));
    try {
      const result = await installFromMarketplace(slug, version, {
        http: makeLiveHttp(BASE_URL),
        publicKeys,
        downloadRoot,
        // Short retry budget — the server is local, network should be instant.
        maxRetries: 2,
      });

      expect(result.slug).toBe(slug);
      expect(result.version).toBe(version);
      expect(result.sha256).toBe(expectedSha);
      expect(Object.keys(publicKeys)).toContain(result.signerKeyId);

      // 4. Unzip + smoke-check plugin.json contents
      const persisted = readFileSync(result.tarballPath);
      expect(createHash("sha256").update(persisted).digest("hex")).toBe(expectedSha);
      const zip = new AdmZip(persisted);
      const pluginJsonEntry = zip.getEntry("plugin.json");
      expect(pluginJsonEntry, "plugin.json must be present").toBeTruthy();
      const manifest = JSON.parse(pluginJsonEntry!.getData().toString("utf8")) as {
        id: string;
        version: string;
      };
      expect(manifest.id).toBe(slug);
      expect(manifest.version).toBe(version);
      const smokeEntry = zip.getEntry("index.js");
      expect(smokeEntry, "index.js smoke handler must be present").toBeTruthy();
    } finally {
      rmSync(downloadRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
