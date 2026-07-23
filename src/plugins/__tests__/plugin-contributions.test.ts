import { createHash } from "node:crypto";
import { link, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginManifest } from "../types.js";
import {
  materializePluginContributions,
  materializePluginGenerationRoot,
  normalizePluginContributionPath,
  PluginContributionError,
  resolvePluginContributionDeclarations,
  validatePluginContributionInventory,
} from "../plugin-contributions.js";
import { makeTestTreeWritable } from "./test-helpers.js";

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

  it("keeps plugin, tool, event, and each contribution kind in independent namespaces", () => {
    const resolved = resolvePluginContributionDeclarations(manifest({
      id: "shared",
      tools: [{ name: "shared" }],
      emittedEvents: ["shared"],
      skills: [{ id: "shared", path: "skills/shared" }],
      hooks: [{ id: "shared", path: "hooks/shared.json" }],
      mcpServers: [{ id: "shared", path: "mcp/shared.json" }],
    }));
    expect(resolved.map(({ kind, localId }) => ({ kind, localId }))).toEqual([
      { kind: "skill", localId: "shared" },
      { kind: "hook", localId: "shared" },
      { kind: "mcpServer", localId: "shared" },
    ]);
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

  it("rejects wrong member kinds and children below exact single-file contributions", () => {
    expect(() => validatePluginContributionInventory(manifest({
      skills: [{ id: "attendance", path: "skills/attendance" }],
    }), [{ path: "skills/attendance", kind: "file" }])).toThrow(/declared_directory_wrong_kind/);
    expect(() => validatePluginContributionInventory(manifest({
      hooks: [{ id: "audit", path: "hooks/audit.json" }],
    }), [{ path: "hooks/audit.json", kind: "directory" }])).toThrow(/declared_file_wrong_kind/);
    expect(() => validatePluginContributionInventory(manifest({
      hooks: [{ id: "audit", path: "hooks/audit.json" }],
    }), [
      { path: "hooks/audit.json", kind: "file" },
      { path: "hooks/audit.json/extra", kind: "file" },
    ])).toThrow(/undeclared_contribution_file/);
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
  afterEach(async () => Promise.all(roots.splice(0).map(async (root) => {
    await makeTestTreeWritable(root);
    await rm(root, { recursive: true, force: true });
  })));

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

  it("fingerprints reference assets from exact bytes rather than decoded text", async () => {
    const root = await mkdtemp(join(tmpdir(), "lvis-contributions-bytes-"));
    roots.push(root);
    const skillPath = "skills/attendance/SKILL.md";
    const assetPath = "skills/attendance/assets/icon.bin";
    const skillBytes = Buffer.from("# Attendance\n", "utf8");
    const assetBytes = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
    await mkdir(join(root, "skills", "attendance", "assets"), { recursive: true });
    await writeFile(join(root, skillPath), skillBytes);
    await writeFile(join(root, assetPath), assetBytes);

    const [contribution] = await materializePluginContributions(root, manifest({
      skills: [{ id: "attendance", path: "skills/attendance" }],
    }));
    const expectedFiles = [
      { path: skillPath, sha256: createHash("sha256").update(skillBytes).digest("hex") },
      { path: assetPath, sha256: createHash("sha256").update(assetBytes).digest("hex") },
    ];
    const expectedFingerprint = createHash("sha256")
      .update(expectedFiles.map((file) => `${file.path}\0${file.sha256}`).join("\n"))
      .digest("hex");

    expect(contribution.files.map(({ path, sha256 }) => ({ path, sha256 }))).toEqual(expectedFiles);
    expect(contribution.fingerprint).toBe(expectedFingerprint);
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

  it.skipIf(process.platform === "win32")("rejects a hard-linked source before retained-generation copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "lvis-contributions-hardlink-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "lvis-contributions-cache-"));
    roots.push(root, cacheRoot);
    await writeFile(join(root, "plugin.json"), "{}");
    await link(join(root, "plugin.json"), join(root, "linked.json"));
    const sha256 = createHash("sha256").update("{}").digest("hex");
    const receiptRaw = JSON.stringify({
      schemaVersion: 2,
      pluginId: "bundle-host-test",
      version: "1.0.0",
      installSource: "local-dev",
      artifactSha256: null,
      signerKeyId: null,
      installedAt: new Date(0).toISOString(),
      files: [
        { path: "plugin.json", sha256 },
        { path: "linked.json", sha256 },
      ],
    });

    await expect(materializePluginGenerationRoot(
      root,
      cacheRoot,
      "bundle-host-test",
      "a".repeat(64),
      receiptRaw,
    )).rejects.toThrow(/not a regular unlinked file/);
  });

  it.skipIf(process.platform === "win32")("seals verified generations and still removes them safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "lvis-contributions-seal-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "lvis-contributions-cache-"));
    roots.push(root, cacheRoot);
    const body = "sealed bytes";
    await writeFile(join(root, "plugin.json"), body);
    const receiptRaw = JSON.stringify({
      schemaVersion: 2,
      pluginId: "bundle-host-test",
      version: "1.0.0",
      installSource: "local-dev",
      artifactSha256: null,
      signerKeyId: null,
      installedAt: new Date(0).toISOString(),
      files: [{ path: "plugin.json", sha256: createHash("sha256").update(body).digest("hex") }],
    });
    const generationId = "b".repeat(64);
    const payloadRoot = await materializePluginGenerationRoot(
      root,
      cacheRoot,
      "bundle-host-test",
      generationId,
      receiptRaw,
    );

    expect((await stat(payloadRoot)).mode & 0o777).toBe(0o500);
    expect((await stat(join(payloadRoot, "plugin.json"))).mode & 0o777).toBe(0o500);
    await expect(writeFile(join(payloadRoot, "plugin.json"), "mutated")).rejects.toMatchObject({ code: "EACCES" });
    expect(await readFile(join(payloadRoot, "plugin.json"), "utf8")).toBe(body);

    const { removeRetainedPluginGeneration } = await import("../plugin-contributions.js");
    await expect(removeRetainedPluginGeneration(cacheRoot, "bundle-host-test", generationId)).resolves.toBeUndefined();
    await expect(stat(payloadRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
