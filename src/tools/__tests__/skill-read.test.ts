/**
 * `skill_read` — tool-level security contract.
 *
 * The store owns containment; this file owns the ACCESS decision, which lives
 * entirely in the tool:
 *   - a skill that is not in the current turn's overlay is unreadable
 *     (overlay membership ⇒ it passed `skill_load`'s approval gate),
 *   - only paths listed in the manifest captured at load time are served,
 *   - a plugin read refuses when the live generation drifted from the approved
 *     one, and always releases its lease,
 *   - no session id ⇒ refuse.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createSkillReadTool } from "../skill-read.js";
import { SkillStore } from "../../main/skill-store.js";
import { SkillOverlay } from "../../main/skill-overlay.js";
import type { ToolExecutionContext } from "../base.js";
import type { ActivePluginGeneration } from "../../plugins/plugin-generation-coordinator.js";

function ctx(sessionId = "session-x"): ToolExecutionContext {
  return {
    cwd: process.cwd(),
    extraAllowedDirectories: [],
    metadata: { sessionId },
  } as ToolExecutionContext;
}

/** Context with no session attribution — `skill_read` must refuse outright. */
function ctxWithoutSession(): ToolExecutionContext {
  return {
    cwd: process.cwd(),
    extraAllowedDirectories: [],
    metadata: {},
  } as ToolExecutionContext;
}

function userSkillDir(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody`);
  mkdirSync(join(dir, "references"), { recursive: true });
  writeFileSync(join(dir, "references", "api.md"), "API DOC");
  return dir;
}

function pluginGeneration(generationId: string, pluginVersion: string): ActivePluginGeneration {
  const fingerprint = "f".repeat(64);
  return {
    pluginId: "plugin-one",
    pluginVersion,
    generationId,
    manifestSha256: "1".repeat(64),
    receiptSha256: "2".repeat(64),
    state: {},
    contributions: [
      {
        ownerPluginId: "plugin-one",
        ownerVersion: pluginVersion,
        kind: "skill",
        localId: "attendance",
        path: "skills/attendance",
        fingerprint,
        files: [
          {
            path: "skills/attendance/SKILL.md",
            content: "---\nname: attendance\ndescription: d\n---\nbody",
            sha256: fingerprint,
          },
          {
            path: "skills/attendance/references/policy.md",
            content: "POLICY",
            sha256: "c".repeat(64),
          },
        ],
      },
    ],
  } as unknown as ActivePluginGeneration;
}

describe("skill_read — access control", () => {
  it("refuses a skill that is not loaded in the current turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skills-"));
    try {
      userSkillDir(dir, "guide");
      const store = new SkillStore({ userDir: dir });
      const tool = createSkillReadTool({ store, overlay: new SkillOverlay() });
      const r = await tool.execute({ skillName: "guide", resourcePath: "references/api.md" }, ctx());
      expect(r.isError).toBe(true);
      expect(r.output).toContain("skill not loaded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves a listed resource of a loaded skill", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skills-"));
    try {
      userSkillDir(dir, "guide");
      const store = new SkillStore({ userDir: dir });
      const overlay = new SkillOverlay();
      overlay.register("session-x", (await store.load("guide"))!);
      const tool = createSkillReadTool({ store, overlay });
      const r = await tool.execute({ skillName: "guide", resourcePath: "references/api.md" }, ctx());
      expect(r.isError).toBe(false);
      expect(JSON.parse(r.output).content).toBe("API DOC");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a path that is not in the manifest captured at load time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skills-"));
    try {
      const skillDir = userSkillDir(dir, "guide");
      const store = new SkillStore({ userDir: dir });
      const overlay = new SkillOverlay();
      overlay.register("session-x", (await store.load("guide"))!);
      // Planted AFTER load: it exists on disk and is contained, but it was
      // never listed to the model, so it is not authorized.
      writeFileSync(join(skillDir, "references", "later.md"), "LATER");
      const tool = createSkillReadTool({ store, overlay });
      const r = await tool.execute({ skillName: "guide", resourcePath: "references/later.md" }, ctx());
      expect(r.isError).toBe(true);
      expect(r.output).toContain("not listed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an invalid selector and a missing session id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skills-"));
    try {
      const store = new SkillStore({ userDir: dir });
      const tool = createSkillReadTool({ store, overlay: new SkillOverlay() });
      const bad = await tool.execute({ skillName: "../evil", resourcePath: "x.md" }, ctx());
      expect(bad.isError).toBe(true);
      const noSession = await tool.execute(
        { skillName: "guide", resourcePath: "x.md" },
        ctxWithoutSession(),
      );
      expect(noSession.isError).toBe(true);
      expect(noSession.output).toContain("sessionId");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("skill_read — plugin generation binding", () => {
  it("serves a plugin resource and releases the lease", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skills-"));
    try {
      const generation = pluginGeneration("g1", "1.0.0");
      const store = new SkillStore({ userDir: dir });
      store.publishPluginGeneration(generation);
      const overlay = new SkillOverlay();
      overlay.register(
        "session-x",
        store.loadPluginGeneration(generation, "plugin:plugin-one:attendance")!,
      );
      let released = 0;
      const tool = createSkillReadTool({
        store,
        overlay,
        acquirePluginGeneration: async () => ({ generation, release: () => { released += 1; } }),
      });
      const r = await tool.execute(
        { skillName: "plugin:plugin-one:attendance", resourcePath: "references/policy.md" },
        ctx(),
      );
      expect(r.isError).toBe(false);
      expect(JSON.parse(r.output).content).toBe("POLICY");
      expect(released).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses when the live generation drifted from the approved one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skills-"));
    try {
      const approved = pluginGeneration("g1", "1.0.0");
      const live = pluginGeneration("g2", "2.0.0");
      const store = new SkillStore({ userDir: dir });
      store.publishPluginGeneration(approved);
      const overlay = new SkillOverlay();
      overlay.register(
        "session-x",
        store.loadPluginGeneration(approved, "plugin:plugin-one:attendance")!,
      );
      let released = 0;
      const tool = createSkillReadTool({
        store,
        overlay,
        acquirePluginGeneration: async () => ({ generation: live, release: () => { released += 1; } }),
      });
      const r = await tool.execute(
        { skillName: "plugin:plugin-one:attendance", resourcePath: "references/policy.md" },
        ctx(),
      );
      expect(r.isError).toBe(true);
      expect(r.output).toContain("generation changed");
      expect(released).toBe(1); // lease released even on refusal
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a plugin read when no generation accessor is wired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skills-"));
    try {
      const generation = pluginGeneration("g1", "1.0.0");
      const store = new SkillStore({ userDir: dir });
      store.publishPluginGeneration(generation);
      const overlay = new SkillOverlay();
      overlay.register(
        "session-x",
        store.loadPluginGeneration(generation, "plugin:plugin-one:attendance")!,
      );
      const tool = createSkillReadTool({ store, overlay });
      const r = await tool.execute(
        { skillName: "plugin:plugin-one:attendance", resourcePath: "references/policy.md" },
        ctx(),
      );
      expect(r.isError).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
