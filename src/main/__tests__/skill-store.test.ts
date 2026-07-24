/**
 * SkillStore — C2 traversal-rejection coverage.
 *
 * Three failure modes must be enforced before the markdown body is read:
 *   1. Filenames outside `[a-zA-Z0-9_-]+` (e.g. `..`, `/`) are rejected.
 *   2. Symlinks pointing outside the skills directory are rejected.
 *   3. Frontmatter `name:` outside the allowlist is rejected.
 *   4. Bodies larger than SKILL_MAX_BODY_BYTES are rejected.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { SkillStore, SKILL_MAX_BODY_BYTES } from "../skill-store.js";
import type { ActivePluginGeneration } from "../../plugins/plugin-generation-coordinator.js";

function pluginGeneration(pluginId: string, generationId: string, body: string): ActivePluginGeneration {
  const fingerprint = (generationId === "g1" ? "a" : "b").repeat(64);
  return {
    pluginId,
    pluginVersion: generationId === "g1" ? "1.0.0" : "2.0.0",
    generationId,
    manifestSha256: "1".repeat(64),
    receiptSha256: "2".repeat(64),
    state: {},
    contributions: [{
      ownerPluginId: pluginId,
      ownerVersion: generationId === "g1" ? "1.0.0" : "2.0.0",
      kind: "skill",
      localId: "attendance",
      path: "skills/attendance",
      fingerprint,
      files: [{
        path: "skills/attendance/SKILL.md",
        content: `---\nname: attendance\ndescription: Attendance guidance\n---\n${body}`,
        sha256: fingerprint,
      }],
    }],
  };
}

describe("SkillStore — C2 traversal & allowlist", () => {
  it("keeps same-local-id plugin Skills distinct without filesystem copies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skills-"));
    try {
      const store = new SkillStore({ userDir: dir });
      store.publishPluginGeneration(pluginGeneration("plugin-one", "g1", "one"));
      store.publishPluginGeneration(pluginGeneration("plugin-two", "g1", "two"));
      const one = await store.load("plugin:plugin-one:attendance");
      const two = await store.load("plugin:plugin-two:attendance");
      expect(one?.body).toBe("one");
      expect(two?.body).toBe("two");
      expect(one?.filePath).toBe("plugin://plugin-one/attendance/SKILL.md");
      expect(one?.approvalKey).not.toBe(two?.approvalKey);
      expect(store.listCatalogSync().map((entry) => entry.name)).toEqual([
        "plugin:plugin-one:attendance",
        "plugin:plugin-two:attendance",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("invalidates a plugin Skill cache identity on generation/content change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skills-"));
    try {
      const store = new SkillStore({ userDir: dir });
      store.publishPluginGeneration(pluginGeneration("plugin-one", "g1", "old"));
      const old = await store.load("plugin:plugin-one:attendance");
      store.publishPluginGeneration(pluginGeneration("plugin-one", "g2", "new"));
      const current = await store.load("plugin:plugin-one:attendance");
      expect(current?.body).toBe("new");
      expect(current?.approvalKey).not.toBe(old?.approvalKey);
      store.removePluginGeneration("plugin-one", "g1");
      expect(await store.load("plugin:plugin-one:attendance")).toBe(current);
      store.removePluginGeneration("plugin-one", "g2");
      expect(await store.load("plugin:plugin-one:attendance")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects symlinks pointing outside the skills directory", async () => {
    // Symlink creation on Windows requires admin/dev-mode; skip if it errors.
    const dir = mkdtempSync(join(tmpdir(), "lvis-skills-"));
    const outside = mkdtempSync(join(tmpdir(), "lvis-evil-"));
    try {
      writeFileSync(
        join(outside, "secret.md"),
        "---\nname: evil\n---\nshould-not-be-loaded",
        "utf-8",
      );
      try {
        symlinkSync(
          join(outside, "secret.md"),
          join(dir, "evil.md"),
          // Type "file" is the right kind on Windows; ignored on POSIX.
          platform() === "win32" ? ("file" as const) : undefined,
        );
      } catch {
        // Symlinks unsupported on this CI runner — pass the test as a no-op
        // rather than fail; the production code path is still exercised by
        // the other allowlist tests below.
        return;
      }
      const store = new SkillStore({ userDir: dir });
      const all = await store.list();
      // Only the BUILTIN_SKILLS should appear; the symlinked entry is dropped.
      expect(all.find((s) => s.name === "evil")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects filenames that don't match the allowlist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skills-"));
    try {
      // Filenames with `.` (other than the .md extension), spaces, etc are
      // rejected. We use a name with a leading dot so the allowlist check
      // (^[a-zA-Z0-9_-]+$) misses it.
      writeFileSync(join(dir, ".sneaky.md"), "---\nname: x\n---\nbody", "utf-8");
      writeFileSync(
        join(dir, "good-skill.md"),
        "---\nname: good-skill\n---\nbody",
        "utf-8",
      );
      const store = new SkillStore({ userDir: dir });
      const all = await store.list();
      // Built-ins + good-skill = ≥1, but no entry whose name is "x".
      expect(all.find((s) => s.name === "x")).toBeUndefined();
      expect(all.find((s) => s.name === "good-skill")).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects frontmatter `name:` outside the allowlist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skills-"));
    try {
      writeFileSync(
        join(dir, "valid-file.md"),
        "---\nname: ../../../etc/passwd\n---\nbody",
        "utf-8",
      );
      const store = new SkillStore({ userDir: dir });
      const all = await store.list();
      expect(all.find((s) => s.name.includes(".."))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects frontmatter `name:` that does not match the skill file id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skills-"));
    try {
      writeFileSync(
        join(dir, "actual-id.md"),
        "---\nname: other-id\n---\nbody",
        "utf-8",
      );
      const store = new SkillStore({ userDir: dir });
      const all = await store.list();
      expect(all.find((s) => s.name === "other-id")).toBeUndefined();
      expect(store.listCatalogSync()).toEqual([]);
      expect(await store.load("actual-id")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects bodies larger than the SKILL_MAX_BODY_BYTES cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skills-"));
    try {
      const huge = "x".repeat(SKILL_MAX_BODY_BYTES + 1);
      writeFileSync(
        join(dir, "huge.md"),
        `---\nname: huge\n---\n${huge}`,
        "utf-8",
      );
      const store = new SkillStore({ userDir: dir });
      const all = await store.list();
      expect(all.find((s) => s.name === "huge")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("packages built-in staff-perspective skills as files under resources/skills/", async () => {
    // Built-in skills are seeded as files into `~/.lvis/skills/` on first
    // boot so users can edit or remove each prompt. Loading `resources/
    // skills/` through the real SkillStore parser exercises the same path
    // a user disk would, and catches frontmatter or body-size regressions
    // before any file is shipped.
    const here = fileURLToPath(new URL(".", import.meta.url));
    const repoRoot = resolvePath(here, "../../..");
    const resourcesSkillsDir = resolvePath(repoRoot, "resources", "skills");
    const store = new SkillStore({ userDir: resourcesSkillsDir });
    const all = await store.list();
    const names = all.map((s) => s.name).sort();
    expect(names).toEqual(
      [
        "data-summary",
        "decision-record",
        "email-polish",
        "meeting-minutes",
        "report-writing",
      ].sort(),
    );
    for (const skill of all) {
      expect(skill.description.length).toBeGreaterThan(0);
      expect(
        Buffer.byteLength(skill.body, "utf-8"),
        `built-in skill '${skill.name}' body exceeds SKILL_MAX_BODY_BYTES`,
      ).toBeLessThanOrEqual(SKILL_MAX_BODY_BYTES);
    }
  });

  it("returns a lightweight catalog without exposing skill bodies", () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skills-"));
    try {
      writeFileSync(
        join(dir, "brief.md"),
        "---\nname: brief\ndescription: Short brief\n---\nSECRET BODY",
        "utf-8",
      );
      const store = new SkillStore({ userDir: dir });
      const catalog = store.listCatalogSync();
      expect(catalog).toEqual([{
        name: "brief",
        description: "Short brief",
      }]);
      expect(JSON.stringify(catalog)).not.toContain("SECRET BODY");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("catalog reads only frontmatter and keeps metadata for oversized bodies", () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skills-"));
    try {
      writeFileSync(
        join(dir, "huge.md"),
        `---\nname: huge\ndescription: Huge but discoverable\n---\n${"x".repeat(SKILL_MAX_BODY_BYTES + 1)}`,
        "utf-8",
      );
      const store = new SkillStore({ userDir: dir });
      const catalog = store.listCatalogSync();
      expect(catalog).toEqual([{ name: "huge", description: "Huge but discoverable" }]);
      expect(JSON.stringify(catalog)).not.toContain("x".repeat(100));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads agent-platform directory skills from <name>/SKILL.md", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skills-"));
    try {
      mkdirSync(join(dir, "git-release"), { recursive: true });
      writeFileSync(
        join(dir, "git-release", "SKILL.md"),
        "---\nname: git-release\ndescription: Create releases\n---\n## Release\nShip it.",
        "utf-8",
      );
      const store = new SkillStore({ userDir: dir });
      const skill = await store.load("git-release");
      expect(skill?.description).toBe("Create releases");
      expect(skill?.body).toContain("Ship it.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses ambiguous skill_load when both directory and flat-file ids exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skills-"));
    try {
      mkdirSync(join(dir, "duplicate"), { recursive: true });
      writeFileSync(
        join(dir, "duplicate", "SKILL.md"),
        "---\nname: duplicate\ndescription: directory\n---\ndirectory body",
        "utf-8",
      );
      writeFileSync(
        join(dir, "duplicate.md"),
        "---\nname: duplicate\ndescription: flat\n---\nflat body",
        "utf-8",
      );
      const store = new SkillStore({ userDir: dir });

      expect(await store.load("duplicate")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
