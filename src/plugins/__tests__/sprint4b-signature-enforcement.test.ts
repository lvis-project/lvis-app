/**
 * Sprint 4-B §B-4 — signature verifier fail-closed for managed plugins.
 * A managed plugin without a valid .sig must be dropped; user plugins pass
 * with a warning.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { PluginRuntime } from "../runtime.js";
import { PluginSignatureVerifier } from "../signature-verifier.js";

describe("Sprint 4-B — signature enforcement", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;
  let publicKeyPem: string;
  let privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];

  beforeEach(async () => {
    testDir = join(homedir(), ".lvis", "test-tmp", `lvis-sig-enf-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    installedDir = join(testDir, "plugins", "installed");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(testDir, "plugins", "registry.json");
    const keypair = generateKeyPairSync("ed25519");
    privateKey = keypair.privateKey;
    publicKeyPem = keypair.publicKey.export({ type: "spki", format: "pem" }).toString();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writePlugin(id: string, installPolicy: "admin" | "user", signed: boolean): Promise<void> {
    const pluginDir = join(installedDir, id);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) { return { handlers: { "sigenf_ping": async () => "pong" }, start: async () => {}, stop: async () => {} }; }`,
      "utf-8",
    );
    const manifestPath = join(pluginDir, "plugin.json");
    const manifest = {
      id,
      name: id,
      version: "1.0.0",
      entry: "entry.mjs",
      tools: [`sigenf_ping`],
      installPolicy,
    };
    const bytes = Buffer.from(JSON.stringify(manifest), "utf-8");
    await writeFile(manifestPath, bytes);
    if (signed) {
      const signature = sign(null, bytes, privateKey);
      await writeFile(`${manifestPath}.sig`, signature.toString("base64"));
    }
    await mkdir(join(testDir, "plugins"), { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [{ id, manifestPath }] }),
      "utf-8",
    );
  }

  it("fail-closed: managed plugin without signature is dropped", async () => {
    await writePlugin("com.lge.managed", "admin", false);
    const verifier = new PluginSignatureVerifier({ publisherPublicKeysPem: [publicKeyPem] });
    const runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      signatureVerifier: verifier,
    });
    await runtime.load();
    expect(runtime.listPluginIds()).not.toContain("com.lge.managed");
  });

  it("managed plugin with valid signature loads", async () => {
    await writePlugin("com.lge.managed-signed", "admin", true);
    const verifier = new PluginSignatureVerifier({ publisherPublicKeysPem: [publicKeyPem] });
    const runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      signatureVerifier: verifier,
    });
    await runtime.load();
    expect(runtime.listPluginIds()).toContain("com.lge.managed-signed");
  });

  it("user plugin without signature loads with warning when allowUnsignedUserPlugins=true", async () => {
    // Phase 1 §Step 2 — fail-closed by default; the legacy "warn-and-load"
    // path now requires the explicit opt-in flag. The new trust-boundary
    // tests cover both branches; this case keeps the original positive-path
    // assertion under the opt-in flag.
    await writePlugin("com.user.plug", "user", false);
    const verifier = new PluginSignatureVerifier({ publisherPublicKeysPem: [publicKeyPem] });
    const runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      signatureVerifier: verifier,
      allowUnsignedUserPlugins: true,
    });
    await runtime.load();
    expect(runtime.listPluginIds()).toContain("com.user.plug");
  });
});
