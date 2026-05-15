import AdmZip from "adm-zip";
import { rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { PluginArtifactStore } from "../plugins/plugin-artifact-store.js";
import type { MarketplaceFetcher } from "../plugins/marketplace-fetcher.js";
import type { InstallerProgressEvent } from "../plugins/marketplace-installer.js";
import { AGENT_NAME_ALLOWLIST, parseAgentFrontmatter } from "../main/agent-profile-store.js";
import { updateAgentRegistry } from "./agent-registry.js";

export interface InstallAgentPackageOptions {
  fetcher: MarketplaceFetcher;
  store: PluginArtifactStore;
  registryPath: string;
  onProgress?: (event: InstallerProgressEvent) => void;
}

export interface InstallAgentPackageResult {
  agentId: string;
  slug: string;
  version: string;
  installed: true;
}

export async function installAgentPackageFromMarketplace(
  slug: string,
  opts: InstallAgentPackageOptions,
): Promise<InstallAgentPackageResult> {
  if (!AGENT_NAME_ALLOWLIST.test(slug)) {
    throw new Error(`agent package slug is not discoverable as an agent profile: ${slug}`);
  }
  const detail = await opts.fetcher.getPluginDetail(slug);
  if (!detail) throw new Error(`marketplace catalog has no entry for slug "${slug}"`);
  if (detail.pluginType !== "agent") {
    throw new Error(`slug "${slug}" is a ${detail.pluginType ?? "plugin"} entry, not an agent package`);
  }
  const version = detail.version;
  if (!version) throw new Error(`marketplace entry "${slug}" has no published version`);

  const verified = await opts.store.downloadVerifiedArtifact(detail, version, opts.onProgress);
  const raw = readRequiredRootFile(slug, verified.zipBuffer, "AGENTS.md", "agent");
  const { fm, body } = parseAgentFrontmatter(raw);
  const agentId = fm.name || slug;
  if (!AGENT_NAME_ALLOWLIST.test(agentId)) {
    throw new Error(`agent package "${slug}" declares invalid agent name "${agentId}"`);
  }
  if (agentId !== slug) {
    throw new Error(`agent package "${slug}" declares agent name "${agentId}", which must match the package slug`);
  }
  if (body.trim().length === 0) {
    throw new Error(`agent package "${slug}" has an empty AGENTS.md body`);
  }
  readRequiredRootFile(slug, verified.zipBuffer, "plugin.json", "agent");

  const files = await opts.store.extractZip(slug, verified.zipBuffer);
  const installDir = opts.store.installDirFor(slug);
  const profilePath = resolve(installDir, "AGENTS.md");
  const manifestPath = resolve(installDir, "plugin.json");

  await opts.store.writeInstallReceipt(slug, {
    version,
    installSource: "marketplace",
    artifactSha256: verified.artifactSha256,
    signerKeyId: verified.signerKeyId,
    files,
  });
  await opts.store.appendHistory(slug, {
    version,
    installedAt: new Date().toISOString(),
  });

  await updateAgentRegistry(opts.registryPath, (registry) => {
    const entry = {
      id: slug,
      version,
      source: "marketplace" as const,
      manifestPath,
      profilePath,
      installedAt: new Date().toISOString(),
      enabled: true,
      artifactSha256: verified.artifactSha256,
      signerKeyId: verified.signerKeyId,
    };
    const idx = registry.agents.findIndex((item) => item.id === slug);
    if (idx >= 0) registry.agents[idx] = entry;
    else registry.agents.push(entry);
  });

  return { agentId, slug, version, installed: true };
}

export async function uninstallAgentPackage(
  slug: string,
  opts: { installRoot: string; registryPath: string },
): Promise<{ agentId: string; slug: string; uninstalled: true }> {
  if (!AGENT_NAME_ALLOWLIST.test(slug)) {
    throw new Error(`invalid agent package id: ${slug}`);
  }
  let found = false;
  await updateAgentRegistry(opts.registryPath, (registry) => {
    const before = registry.agents.length;
    registry.agents = registry.agents.filter((entry) => entry.id !== slug);
    found = registry.agents.length !== before;
  });
  if (!found) throw new Error(`Agent package not installed: ${slug}`);
  const target = resolve(opts.installRoot, slug);
  if (!isWithin(opts.installRoot, target)) {
    throw new Error(`refusing to remove outside agent install root: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
  return { agentId: slug, slug, uninstalled: true };
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function readRequiredRootFile(
  slug: string,
  zipBuffer: Buffer,
  filename: "AGENTS.md" | "plugin.json",
  packageLabel: string,
): string {
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch (err) {
    throw new Error(`invalid zip format for "${slug}": ${(err as Error).message}`);
  }
  const entry = zip.getEntry(filename);
  if (!entry || entry.isDirectory) {
    throw new Error(`${packageLabel} package "${slug}" must contain ${filename} at the archive root`);
  }
  return entry.getData().toString("utf-8");
}
