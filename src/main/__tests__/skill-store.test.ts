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

describe("SkillStore — C2 traversal & allowlist", () => {
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
      expect(skill.triggers.length).toBeGreaterThan(0);
      expect(
        Buffer.byteLength(skill.body, "utf-8"),
        `built-in skill '${skill.name}' body exceeds SKILL_MAX_BODY_BYTES`,
      ).toBeLessThanOrEqual(SKILL_MAX_BODY_BYTES);
    }
  });

  it("loads agent-platform directory skills from <name>/SKILL.md", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skills-"));
    try {
      mkdirSync(join(dir, "git-release"), { recursive: true });
      writeFileSync(
        join(dir, "git-release", "SKILL.md"),
        "---\nname: git-release\ndescription: Create releases\ntriggers: [release, tag]\n---\n## Release\nShip it.",
        "utf-8",
      );
      const store = new SkillStore({ userDir: dir });
      const skill = await store.load("git-release");
      expect(skill?.description).toBe("Create releases");
      expect(skill?.triggers).toEqual(["release", "tag"]);
      expect(skill?.body).toContain("Ship it.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
