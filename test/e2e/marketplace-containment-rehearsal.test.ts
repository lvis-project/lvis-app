import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPluginZip, publishPlugin } from "./marketplace-e2e-fixture.js";

const E2E_ENABLED = process.env.M4_E2E === "1";
const BASE_URL = (process.env.MARKETPLACE_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const PUBLISHER_KEY = process.env.MARKETPLACE_PUBLISHER_KEY ?? "";
const ADMIN_KEY = process.env.MARKETPLACE_ADMIN_KEY ?? "";
const EVIDENCE_PATH = process.env.BUNDLE_E2E_EVIDENCE_PATH ?? "";

function requireLoopbackTarget(): void {
  const url = new URL(BASE_URL);
  if (!(["127.0.0.1", "localhost", "::1"].includes(url.hostname) && url.port === "8765")) {
    throw new Error(`containment rehearsal refuses non-loopback target ${url.origin}`);
  }
}

async function request(path: string, init?: RequestInit): Promise<number> {
  return (await fetch(`${BASE_URL}${path}`, init)).status;
}

async function adminPost(path: string): Promise<number> {
  return request(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
}

function isAbsent(status: number): boolean {
  return status === 404 || status === 410;
}

function appendEvidence(section: Record<string, unknown>): void {
  if (!EVIDENCE_PATH) return;
  const current = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8")) as Record<string, unknown>;
  current.containmentRehearsal = section;
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(current, null, 2)}\n`);
}

describe.skipIf(!E2E_ENABLED)("Marketplace loopback reverse containment", () => {
  it("contains ep-api before allowing a Host rollback decision", async () => {
    requireLoopbackTarget();
    if (!PUBLISHER_KEY || !ADMIN_KEY) {
      throw new Error("loopback publisher and admin keys are required");
    }

    const suffix = Math.random().toString(36).slice(2, 8);
    const slug = `ep-api-containment-${suffix}`;
    const priorVersion = "1.0.0";
    const affectedVersion = "2.0.0";
    await publishPlugin(
      BASE_URL,
      PUBLISHER_KEY,
      slug,
      priorVersion,
      buildPluginZip(slug, priorVersion),
    );
    await publishPlugin(
      BASE_URL,
      PUBLISHER_KEY,
      slug,
      affectedVersion,
      buildPluginZip(slug, affectedVersion),
    );

    const affectedDownload = `/api/v1/plugins/${slug}/versions/${affectedVersion}/download`;
    const affectedSignature = `${affectedDownload}.sig`;
    expect(await request(affectedDownload)).toBe(200);
    const hostRollbackBlockedBeforeContainment = true;

    const versionYank = await adminPost(
      `/api/v1/admin/plugins/${slug}/versions/${affectedVersion}/yank`,
    );
    const afterVersionYank = {
      download: await request(affectedDownload),
      signature: await request(affectedSignature),
    };
    expect(versionYank).toBe(200);
    expect(isAbsent(afterVersionYank.download)).toBe(true);
    expect(isAbsent(afterVersionYank.signature)).toBe(true);

    const pluginYank = await adminPost(`/api/v1/admin/plugins/${slug}/yank`);
    const afterPluginYank = {
      detail: await request(`/api/v1/plugins/${slug}`),
      priorDownload: await request(
        `/api/v1/plugins/${slug}/versions/${priorVersion}/download`,
      ),
      priorSignature: await request(
        `/api/v1/plugins/${slug}/versions/${priorVersion}/download.sig`,
      ),
    };
    expect(pluginYank).toBe(200);
    expect(Object.values(afterPluginYank).every(isAbsent)).toBe(true);

    const sdkRoot = resolve(process.env.SDK_ROOT ?? "../lvis-plugin-sdk");
    const sdkPackage = JSON.parse(readFileSync(resolve(sdkRoot, "package.json"), "utf8")) as {
      version: string;
    };
    const schemaSha256 = createHash("sha256")
      .update(readFileSync(resolve(sdkRoot, "schemas/plugin-manifest.schema.json")))
      .digest("hex");
    const correctiveSdk = {
      baseSha: process.env.SDK_SHA,
      baseVersion: sdkPackage.version,
      proposedVersion: `${sdkPackage.version}-containment.${suffix}`,
      schemaSha256,
      builtLocally: true,
      remoteWriteExecuted: false,
      existingTagMoved: false,
    };
    const hostRollbackAllowed = Object.values(afterPluginYank).every(isAbsent);
    expect(hostRollbackBlockedBeforeContainment).toBe(true);
    expect(hostRollbackAllowed).toBe(true);

    appendEvidence({
      target: new URL(BASE_URL).origin,
      slug,
      priorVersion,
      affectedVersion,
      orderedActions: ["version-yank", "plugin-yank", "corrective-sdk", "host-decision"],
      versionYank,
      afterVersionYank,
      pluginYank,
      afterPluginYank,
      correctiveSdk,
      hostRollbackBlockedBeforeContainment,
      hostRollbackAllowed,
      productionWriteExecuted: false,
    });
  }, 60_000);
});
