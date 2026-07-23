import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginManifest } from "../types.js";
import {
  materializePluginContributions,
  normalizePluginContributionPath,
  PluginContributionError,
  resolvePluginContributionDeclarations,
  validatePluginContributionInventory,
} from "../plugin-contributions.js";

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "bundle-host-test",
    name: "Bundle Host Test",
    version: "1.0.0",
    entry: "dist/index.js",
    description: "fixture",
    tools: [],
    ...overrides,
  };
}

describe("plugin contribution declarations", () => {
  it("keeps contribution-free manifests compatible", () => {
    expect(resolvePluginContributionDeclarations(manifest())).toEqual([]);
  });

  it("resolves structured owner-local identities for all contribution kinds", () => {
    const resolved = resolvePluginContributionDeclarations(manifest({
      skills: [{ id: "attendance", path: "skills/attendance" }],
      hooks: [{ id: "audit", path: "hooks/audit.json" }],
      mcpServers: [{ id: "ep", path: "mcp/ep.json" }],
    }));
    expect(resolved.map(({ ownerPluginId, ownerVersion, kind, localId, path }) => ({ ownerPluginId, ownerVersion, kind, localId, path }))).toEqual([
      { ownerPluginId: "bundle-host-test", ownerVersion: "1.0.0", kind: "skill", localId: "attendance", path: "skills/attendance" },
      { ownerPluginId: "bundle-host-test", ownerVersion: "1.0.0", kind: "hook", localId: "audit", path: "hooks/audit.json" },
      { ownerPluginId: "bundle-host-test", ownerVersion: "1.0.0", kind: "mcpServer", localId: "ep", path: "mcp/ep.json" },
    ]);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it.each([
    "/absolute", "C:/drive", "//server/share", "../escape", "skills/../escape",
    "skills//attendance", "skills/./attendance", "skills\\attendance", "skills/%2e%2e/escape",
  ])("rejects unsafe or ambiguous path %s", (path) => {
    expect(() => normalizePluginContributionPath("bundle-host-test", "skill:x", path)).toThrow(PluginContributionError);
  });

  it("rejects duplicate ids and cross-kind path containment collisions", () => {
    expect(() => resolvePluginContributionDeclarations(manifest({
      hooks: [{ id: "same", path: "hooks/a.json" }, { id: "same", path: "hooks/b.json" }],
    }))).toThrow(/duplicate_local_id/);
    expect(() => resolvePluginContributionDeclarations(manifest({
      skills: [{ id: "skill", path: "bundle" }],
      hooks: [{ id: "hook", path: "bundle/hook.json" }],
    }))).toThrow(/path_collision/);
  });
});

describe("plugin contribution inventory", () => {
  const full = manifest({
    skills: [{ id: "attendance", path: "skills/attendance" }],
    hooks: [{ id: "audit", path: "hooks/audit.json" }],
    mcpServers: [{ id: "ep", path: "mcp/ep.json" }],
  });

  it("requires the expected member kind and SKILL.md entry", () => {
    expect(validatePluginContributionInventory(full, [
      { path: "skills/attendance/SKILL.md", kind: "file" },
      { path: "skills/attendance/references/policy.md", kind: "file" },
      { path: "hooks/audit.json", kind: "file" },
      { path: "mcp/ep.json", kind: "file" },
    ])).toHaveLength(3);

    expect(() => validatePluginContributionInventory(full, [
      { path: "skills/attendance/readme.md", kind: "file" },
      { path: "hooks/audit.json", kind: "file" },
      { path: "mcp/ep.json", kind: "file" },
    ])).toThrow(/skill_entry_missing/);
  });

  it.each(["symlink", "hardlink", "device", "other"] as const)("rejects %s archive members", (kind) => {
    expect(() => validatePluginContributionInventory(manifest(), [{ path: "payload", kind }])).toThrow(/unsupported_member_kind/);
  });

  it("rejects case or Unicode-normalized member collisions", () => {
    expect(() => validatePluginContributionInventory(manifest(), [
      { path: "Hooks/A.json", kind: "file" },
      { path: "hooks/a.json", kind: "file" },
    ])).toThrow(/member_collision/);
  });
});

describe("materializePluginContributions", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it("captures immutable verified bytes and fingerprints", async () => {
    const root = await mkdtemp(join(tmpdir(), "lvis-contributions-"));
    roots.push(root);
    await mkdir(join(root, "skills", "attendance", "references"), { recursive: true });
    await writeFile(join(root, "skills", "attendance", "SKILL.md"), "# Attendance\n");
    await writeFile(join(root, "skills", "attendance", "references", "policy.md"), "read before write\n");
    const result = await materializePluginContributions(root, manifest({
      skills: [{ id: "attendance", path: "skills/attendance" }],
    }));
    expect(result).toHaveLength(1);
    expect(result[0].files.map((file) => file.path)).toEqual([
      "skills/attendance/SKILL.md",
      "skills/attendance/references/policy.md",
    ]);
    expect(result[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result[0].files)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("rejects installed symlinks before reading contribution bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "lvis-contributions-link-"));
    roots.push(root);
    await mkdir(join(root, "skills", "attendance"), { recursive: true });
    await symlink("/tmp", join(root, "skills", "attendance", "escape"), "dir");
    await writeFile(join(root, "skills", "attendance", "SKILL.md"), "# Attendance\n");
    await expect(materializePluginContributions(root, manifest({
      skills: [{ id: "attendance", path: "skills/attendance" }],
    }))).rejects.toThrow(/unsupported_member_kind/);
  });
});
