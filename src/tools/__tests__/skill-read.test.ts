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
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
      await cleanupTmpDir(dir);
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
      await cleanupTmpDir(dir);
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
      await cleanupTmpDir(dir);
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
      await cleanupTmpDir(dir);
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
      await cleanupTmpDir(dir);
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
      await cleanupTmpDir(dir);
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
      await cleanupTmpDir(dir);
    }
  });
});

describe("skill_load — approval covers the bundled manifest", () => {
  it("re-prompts when a bundle gains a file even though SKILL.md is unchanged", async () => {
    const { createSkillLoadTool } = await import("../skill-load.js");
    const dir = mkdtempSync(join(tmpdir(), "lvis-skills-"));
    try {
      const skillDir = userSkillDir(dir, "guide");
      const store = new SkillStore({ userDir: dir });
      const approved = new Map<string, string>();
      const approvals = {
        isApproved: async (key: string, material: string) => approved.get(key) === material,
        approve: async (key: string, material: string) => { approved.set(key, material); },
      };
      let prompts = 0;
      const tool = createSkillLoadTool({
        store,
        overlay: new SkillOverlay(),
        approvals: approvals as never,
        approvalGate: ({
          requestAndWait: async () => { prompts += 1; return { choice: "allow" }; },
        }) as never,
        emit: () => {},
      });

      const first = await tool.execute({ skillName: "guide" }, ctx());
      expect(first.isError).toBe(false);
      expect(prompts).toBe(1);

      // Same body, second load: still approved, no new prompt.
      const second = await tool.execute({ skillName: "guide" }, ctx());
      expect(second.isError).toBe(false);
      expect(prompts).toBe(1);

      // A NEW bundled file changes what renders in the trusted fence, so the
      // approval must no longer match.
      writeFileSync(join(skillDir, "references", "extra.md"), "EXTRA");
      const third = await tool.execute({ skillName: "guide" }, ctx());
      expect(third.isError).toBe(false);
      expect(prompts).toBe(2);
    } finally {
      await cleanupTmpDir(dir);
    }
  });
});

describe("skill_read — manifest fidelity", () => {
  it("serves a filename containing '&' exactly as the overlay renders it", async () => {
    // Regression: escaping the manifest line rewrote `Q&A.md` to `Q&amp;A.md`,
    // so the model echoed a name the authorized set never contained.
    const dir = mkdtempSync(join(tmpdir(), "lvis-skills-"));
    try {
      const skillDir = userSkillDir(dir, "guide");
      writeFileSync(join(skillDir, "references", "Q&A.md"), "QA DOC");
      const store = new SkillStore({ userDir: dir });
      const overlay = new SkillOverlay();
      overlay.register("session-x", (await store.load("guide"))!);
      const rendered = overlay.buildSection("session-x");
      expect(rendered).toContain("references/Q&A.md");
      expect(rendered).not.toContain("Q&amp;A.md");
      const tool = createSkillReadTool({ store, overlay });
      const r = await tool.execute({ skillName: "guide", resourcePath: "references/Q&A.md" }, ctx());
      expect(r.isError).toBe(false);
      expect(JSON.parse(r.output).content).toBe("QA DOC");
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("keeps a resource-less skill's approval material byte-identical to its body", async () => {
    const { createSkillLoadTool } = await import("../skill-load.js");
    const dir = mkdtempSync(join(tmpdir(), "lvis-skills-"));
    try {
      // Flat skill => no bundle => the hashed material must stay the bare body,
      // so approvals recorded before stage-3 remain valid (no mass re-prompt).
      writeFileSync(join(dir, "flat.md"), "---\nname: flat\ndescription: d\n---\nFLAT BODY");
      const store = new SkillStore({ userDir: dir });
      const seen: string[] = [];
      let prompts = 0;
      const tool = createSkillLoadTool({
        store,
        overlay: new SkillOverlay(),
        approvals: {
          // Pre-seeded with the PRE-stage-3 material (the bare body).
          isApproved: async (_key: string, material: string) => {
            seen.push(material);
            return material === "FLAT BODY";
          },
          approve: async () => {},
        } as never,
        approvalGate: ({
          requestAndWait: async () => { prompts += 1; return { choice: "allow" }; },
        }) as never,
        emit: () => {},
      });
      const r = await tool.execute({ skillName: "flat" }, ctx());
      expect(r.isError).toBe(false);
      expect(seen).toEqual(["FLAT BODY"]);
      expect(prompts).toBe(0); // existing approval still honored
    } finally {
      await cleanupTmpDir(dir);
    }
  });
});

describe("skill_load — approval key domains", () => {
  it("stores a bundled skill's approval under a separate key from a flat one", async () => {
    const { createSkillLoadTool } = await import("../skill-load.js");
    const dir = mkdtempSync(join(tmpdir(), "lvis-skills-"));
    try {
      userSkillDir(dir, "guide"); // directory skill WITH a bundled file
      writeFileSync(join(dir, "flat.md"), "---\nname: flat\ndescription: d\n---\nFLAT BODY");
      const store = new SkillStore({ userDir: dir });
      const keys: string[] = [];
      // BOTH sides are recorded. An earlier round of this feature applied the
      // namespacing to `approve` but not `isApproved`, which stores an approval
      // under one key and looks it up under another — the user re-approves every
      // single load and nothing looks broken. Asserting only the read side would
      // not have caught it.
      const approvedKeys: string[] = [];
      const approvedMaterial: string[] = [];
      const tool = createSkillLoadTool({
        store,
        overlay: new SkillOverlay(),
        approvals: {
          isApproved: async (key: string) => { keys.push(key); return false; },
          approve: async (key: string, material: string) => {
            approvedKeys.push(key);
            approvedMaterial.push(material);
          },
        } as never,
        approvalGate: ({ requestAndWait: async () => ({ choice: "allow" }) }) as never,
        emit: () => {},
      });
      await tool.execute({ skillName: "flat" }, ctx());
      await tool.execute({ skillName: "guide" }, ctx());
      // Flat keeps the legacy key; the bundle-bearing skill is namespaced, so
      // the two material encodings can never share a record.
      expect(keys).toEqual(["flat", "guide#bundled"]);
      // …and the write side uses the SAME keys, in the same order.
      expect(approvedKeys).toEqual(keys);
      // The material differs in kind, which is why the namespaces exist: a flat
      // skill binds its body verbatim, a bundled one binds a digest pair.
      expect(approvedMaterial[0]).toContain("FLAT BODY");
      expect(approvedMaterial[1]).toMatch(/^[0-9a-f]{64}\|[0-9a-f]{64}$/);
    } finally {
      await cleanupTmpDir(dir);
    }
  });
});
