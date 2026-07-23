import { rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { PluginArtifactStore } from "../plugins/plugin-artifact-store.js";
import type { MarketplaceFetcher } from "../plugins/marketplace-fetcher.js";
import type { InstallerProgressEvent } from "../plugins/marketplace-installer.js";
import { parseFrontmatter, SKILL_NAME_ALLOWLIST } from "../main/skill-store.js";
import { updateSkillRegistry } from "./skill-registry.js";

const MAX_ASSISTANT_PACKAGE_ROOT_TEXT_BYTES = 1024 * 1024;

export interface InstallSkillPackageOptions {
  fetcher: MarketplaceFetcher;
  store: PluginArtifactStore;
  registryPath: string;
  onProgress?: (event: InstallerProgressEvent) => void;
  signal?: AbortSignal;
}

export interface InstallSkillPackageResult {
  skillId: string;
  slug: string;
  version: string;
  installed: true;
}

export async function installSkillPackageFromMarketplace(
  slug: string,
  opts: InstallSkillPackageOptions,
): Promise<InstallSkillPackageResult> {
  if (!SKILL_NAME_ALLOWLIST.test(slug)) {
    throw new Error(`skill package slug is not discoverable as a skill: ${slug}`);
  }
  const detail = await opts.fetcher.getPluginDetail(slug);
  if (!detail) throw new Error(`marketplace catalog has no entry for slug "${slug}"`);
  if (detail.pluginType !== "skill") {
    throw new Error(`slug "${slug}" is a ${detail.pluginType ?? "plugin"} entry, not a skill package`);
  }
  const version = detail.version;
  if (!version) throw new Error(`marketplace entry "${slug}" has no published version`);

  return opts.store.withVerifiedArtifactTransaction(
    detail,
    version,
    opts.onProgress,
    async (verified) => {
      const rootFiles = opts.store.readRequiredRootTextFiles(slug, verified.zipBuffer, [
        {
          filename: "SKILL.md",
          maxBytes: MAX_ASSISTANT_PACKAGE_ROOT_TEXT_BYTES,
          packageLabel: "skill",
        },
        {
          filename: "plugin.json",
          maxBytes: MAX_ASSISTANT_PACKAGE_ROOT_TEXT_BYTES,
          packageLabel: "skill",
        },
      ]);
      const { fm, body } = parseFrontmatter(rootFiles["SKILL.md"]);
      const skillId = fm.name || slug;
      if (!SKILL_NAME_ALLOWLIST.test(skillId)) {
        throw new Error(`skill package "${slug}" declares invalid skill name "${skillId}"`);
      }
      if (skillId !== slug) {
        throw new Error(
          `skill package "${slug}" declares skill name "${skillId}", which must match the package slug`,
        );
      }
      if (body.trim().length === 0) {
        throw new Error(`skill package "${slug}" has an empty SKILL.md body`);
      }
      throwIfMarketplaceInstallAborted(opts.signal, slug);

      const files = await opts.store.extractZip(slug, verified.zipBuffer);
      const installDir = opts.store.installDirFor(slug);
      const skillPath = resolve(installDir, "SKILL.md");
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

      await updateSkillRegistry(opts.registryPath, (registry) => {
        const entry = {
          id: slug,
          version,
          source: "marketplace" as const,
          manifestPath,
          skillPath,
          installedAt: new Date().toISOString(),
          enabled: true,
          artifactSha256: verified.artifactSha256,
          signerKeyId: verified.signerKeyId,
        };
        const idx = registry.skills.findIndex((item) => item.id === slug);
        if (idx >= 0) registry.skills[idx] = entry;
        else registry.skills.push(entry);
      });

      return { skillId, slug, version, installed: true };
    },
    opts.signal,
  );
}

export async function uninstallSkillPackage(
  slug: string,
  opts: { installRoot: string; registryPath: string },
): Promise<{ skillId: string; slug: string; uninstalled: true }> {
  if (!SKILL_NAME_ALLOWLIST.test(slug)) {
    throw new Error(`invalid skill package id: ${slug}`);
  }
  let found = false;
  await updateSkillRegistry(opts.registryPath, (registry) => {
    const before = registry.skills.length;
    registry.skills = registry.skills.filter((entry) => entry.id !== slug);
    found = registry.skills.length !== before;
  });
  if (!found) throw new Error(`Skill package not installed: ${slug}`);
  const target = resolve(opts.installRoot, slug);
  if (!isWithin(opts.installRoot, target)) {
    throw new Error(`refusing to remove outside skill install root: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
  return { skillId: slug, slug, uninstalled: true };
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function throwIfMarketplaceInstallAborted(signal: AbortSignal | undefined, slug: string): void {
  if (!signal?.aborted) return;
  const error = new Error(`skill package install aborted before promotion: ${slug}`);
  error.name = "AbortError";
  throw error;
}
