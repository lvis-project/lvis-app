import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { mergeEvidenceFile } from "./evidence-file.js";
import {
  buildPluginZip,
  postMarketplace,
  publishPlugin,
  requireExactLoopbackMarketplaceOrigin,
} from "./marketplace-e2e-fixture.js";

const E2E_ENABLED = process.env.M4_E2E === "1";
const BASE_URL = (process.env.MARKETPLACE_URL ?? "http://127.0.0.1:8765").replace(/\/$/, "");
const PUBLISHER_KEY = process.env.MARKETPLACE_PUBLISHER_KEY ?? "";
const ADMIN_KEY = process.env.MARKETPLACE_ADMIN_KEY ?? "";
const EVIDENCE_PATH = process.env.BUNDLE_E2E_EVIDENCE_PATH ?? "";

async function request(path: string, init?: RequestInit): Promise<number> {
  return (await fetch(`${BASE_URL}${path}`, init)).status;
}

async function adminPost(path: string): Promise<number> {
  return (await postMarketplace(BASE_URL, ADMIN_KEY, path)).status;
}

function isAbsent(status: number): boolean {
  return status === 404 || status === 410;
}

function exactStatus(status: number, expected: number): number {
  expect(status).toBe(expected);
  return expected;
}

function absentStatus(status: number): "not-found" | "gone" {
  if (status === 404) return "not-found";
  if (status === 410) return "gone";
  throw new Error(`expected an absent Marketplace resource, got HTTP ${status}`);
}

describe.skipIf(!E2E_ENABLED)("Marketplace loopback reverse containment", () => {
  it("contains ep-api before allowing a Host rollback decision", async () => {
    requireExactLoopbackMarketplaceOrigin(BASE_URL);
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
    const versionYankEvidence = exactStatus(versionYank, 200);
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
    const pluginYankEvidence = exactStatus(pluginYank, 200);
    expect(Object.values(afterPluginYank).every(isAbsent)).toBe(true);

    const sdkEvidencePath = process.env.SDK_EVIDENCE_PATH;
    if (!sdkEvidencePath) {
      throw new Error("SDK_EVIDENCE_PATH is required for the containment rehearsal");
    }
    const sdkEvidence = JSON.parse(readFileSync(resolve(sdkEvidencePath), "utf8")) as {
      version?: unknown;
      schemaSha256?: unknown;
    };
    if (
      typeof sdkEvidence.version !== "string"
      || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(sdkEvidence.version)
      || typeof sdkEvidence.schemaSha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(sdkEvidence.schemaSha256)
    ) {
      throw new Error("SDK evidence must contain a version and lowercase SHA-256");
    }
    const correctiveSdk = {
      baseSha: process.env.SDK_SHA,
      baseVersion: sdkEvidence.version,
      proposedVersion: `${sdkEvidence.version}-containment.${suffix}`,
      schemaSha256: sdkEvidence.schemaSha256,
      builtLocally: true,
      remoteWriteExecuted: false,
      existingTagMoved: false,
    };
    const hostRollbackAllowed = Object.values(afterPluginYank).every(isAbsent);
    expect(hostRollbackBlockedBeforeContainment).toBe(true);
    expect(hostRollbackAllowed).toBe(true);

    mergeEvidenceFile(EVIDENCE_PATH, {
      containmentRehearsal: {
      target: "loopback:8765",
      slug,
      priorVersion,
      affectedVersion,
      orderedActions: ["version-yank", "plugin-yank", "corrective-sdk", "host-decision"],
      versionYank: versionYankEvidence,
      afterVersionYank: {
        download: absentStatus(afterVersionYank.download),
        signature: absentStatus(afterVersionYank.signature),
      },
      pluginYank: pluginYankEvidence,
      afterPluginYank: {
        detail: absentStatus(afterPluginYank.detail),
        priorDownload: absentStatus(afterPluginYank.priorDownload),
        priorSignature: absentStatus(afterPluginYank.priorSignature),
      },
      correctiveSdk,
      hostRollbackBlockedBeforeContainment,
      hostRollbackAllowed,
      productionWriteExecuted: false,
      },
    });
  }, 60_000);
});
