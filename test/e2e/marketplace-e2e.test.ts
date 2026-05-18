/**
 * M4 E2E — lvis-app installer ↔ lvis-marketplace server.
 *
 * End-to-end scenario:
 *   1. Publish a minimal signed plugin zip against a live marketplace server
 *      using the /api/v1/plugins/{slug}/versions publisher endpoint.
 *   2. Fetch the server's active ed25519 public keys from /api/v1/keys.
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
import {
  installFromMarketplace,
  type MarketplaceHttp,
} from "../../src/plugins/marketplace-installer.js";
import type { SignatureEnvelope } from "../../src/plugins/types.js";

const E2E_ENABLED = process.env.M4_E2E === "1";
const BASE_URL = (process.env.MARKETPLACE_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const PUBLISHER_KEY = process.env.MARKETPLACE_PUBLISHER_KEY ?? "";

/** Minimal valid plugin zip — mirrors server conftest.make_valid_plugin_zip. */
function buildPluginZip(slug: string, version: string): Buffer {
  const zip = new AdmZip();
  const pluginJson = {
    id: slug,
    name: "M4 E2E Plugin",
    version,
    // SDK v5.13 schema requires `entry`. `main` is the older field.
    // Keep both for back-compat with intermediate SDK versions.
    entry: "index.js",
    installPolicy: "user",
    description: "M4 e2e test plugin",
    publisher: "lvis-community",
    // SDK v5.13 schema: additionalProperties=false. Required fields:
    // id, name, version, entry, tools, description.
    tools: [],
  };
  zip.addFile("plugin.json", Buffer.from(JSON.stringify(pluginJson)));
  // A trivial smoke handler that the assertion below exec()s indirectly by
  // reading the file back — we do NOT require(...) untrusted code in tests.
  zip.addFile("index.js", Buffer.from("module.exports = { smoke: () => 'ok' };\n"));
  return zip.toBuffer();
}

function makeLiveHttp(baseUrl: string): MarketplaceHttp {
  return {
    async downloadArtifact(slug, version) {
      const url = `${baseUrl}/api/v1/plugins/${slug}/versions/${version}/download`;
      const res = await fetch(url);
      const body = Buffer.from(await res.arrayBuffer());
      return {
        body,
        sha256Header: res.headers.get("X-Plugin-SHA256"),
        status: res.status,
        retryAfterSeconds: res.headers.get("Retry-After")
          ? Number(res.headers.get("Retry-After")) || undefined
          : undefined,
      };
    },
    async fetchSignatureEnvelope(slug, version) {
      const url = `${baseUrl}/api/v1/plugins/${slug}/versions/${version}/download.sig`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`download.sig returned ${res.status}`);
      }
      return (await res.json()) as SignatureEnvelope;
    },
  };
}

async function fetchPublicKeys(baseUrl: string): Promise<Record<string, Buffer>> {
  const res = await fetch(`${baseUrl}/api/v1/keys`);
  if (!res.ok) throw new Error(`/api/v1/keys returned ${res.status}`);
  const body = (await res.json()) as {
    keys: Array<{ key_id: string; alg: string; pub: string }>;
  };
  const out: Record<string, Buffer> = {};
  for (const k of body.keys) {
    if (k.alg !== "ed25519") continue;
    out[k.key_id] = Buffer.from(k.pub, "base64");
  }
  if (Object.keys(out).length === 0) {
    throw new Error("marketplace returned no ed25519 public keys");
  }
  return out;
}

async function publishPlugin(
  baseUrl: string,
  apiKey: string,
  slug: string,
  version: string,
  zipBytes: Buffer,
): Promise<void> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([zipBytes], { type: "application/zip" }),
    `${slug}-${version}.zip`,
  );
  const res = await fetch(`${baseUrl}/api/v1/plugins/${slug}/versions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (res.status !== 201) {
    const detail = await res.text();
    throw new Error(`publish failed: status=${res.status} body=${detail}`);
  }
}

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

    // 2. Fetch public keys
    const publicKeys = await fetchPublicKeys(BASE_URL);

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
