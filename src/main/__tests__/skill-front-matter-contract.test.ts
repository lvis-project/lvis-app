/**
 * SKILL.md front matter against the SDK component contract.
 *
 * The host used to read a skill header with a line-at-a-time parser that kept
 * `name` and `description` and discarded the other five fields
 * `$defs/skillComponent` declares — on both delivery paths. `triggers` in
 * particular was a field an author could write and nothing downstream would
 * ever see.
 *
 * What this suite pins is the join between the two repos: the fields survive
 * on both paths, the keyword hints reach the catalog and leave with the skill,
 * and the host's name rule is the schema's name rule — read out of the
 * committed snapshot rather than restated here, so a test cannot agree with a
 * host constant that has drifted from the SDK.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  SkillStore,
  SKILL_NAME_ALLOWLIST,
  SKILL_NAME_MAX_CHARS,
  isAllowedSkillName,
  parseFrontmatter,
} from "../skill-store.js";
import type { ActivePluginGeneration } from "../../plugins/plugin-generation-coordinator.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const REPO_ROOT = resolvePath(fileURLToPath(new URL("../../..", import.meta.url)));

/**
 * The committed snapshot of the SDK-owned skill package schema. Read as data:
 * the point of every assertion below is that the host constant equals what
 * this file says, so restating the pattern in the test would defeat it.
 */
const skillComponent = (
  JSON.parse(
    readFileSync(join(REPO_ROOT, "schemas/sdk/skill-package.schema.json"), "utf8"),
  ) as {
    $defs: {
      skillComponent: {
        properties: Record<string, { pattern?: string; maxLength?: number }>;
        required: string[];
      };
    };
  }
).$defs.skillComponent;

const FULL_HEADER = [
  "---",
  "name: full-header",
  "description: Every declared field, present.",
  "triggers: [alpha, beta]",
  "license: MIT",
  "compatibility: Requires network access.",
  "metadata:",
  "  author: example",
  "  locale: ko-KR",
  "allowed-tools: Read Bash(git:*)",
  "---",
  "Body text.",
].join("\n");

/**
 * A plugin skill's local id is `[a-zA-Z_][a-zA-Z0-9_]*` (the selector
 * grammar), so the bundled copy of the header names itself `full_header`.
 */
const BUNDLED_HEADER = FULL_HEADER.replace("name: full-header", "name: full_header");

function pluginGeneration(pluginId: string, skillMarkdown: string): ActivePluginGeneration {
  const fingerprint = "a".repeat(64);
  return {
    pluginId,
    pluginVersion: "1.0.0",
    generationId: "g1",
    artifactGenerationId: "3".repeat(64),
    manifestSha256: "1".repeat(64),
    receiptSha256: "2".repeat(64),
    state: {},
    contributions: [{
      ownerPluginId: pluginId,
      ownerVersion: "1.0.0",
      kind: "skill",
      localId: "full_header",
      path: "skills/full_header",
      fingerprint,
      files: [{
        path: "skills/full_header/SKILL.md",
        content: skillMarkdown,
        sha256: fingerprint,
      }],
    }],
  };
}

describe("skill front matter — the declared fields survive", () => {
  it("parses every field `skillComponent` declares", () => {
    const { fm, body } = parseFrontmatter(FULL_HEADER);
    expect(fm.name).toBe("full-header");
    expect(fm.description).toBe("Every declared field, present.");
    expect(fm.triggers).toEqual(["alpha", "beta"]);
    expect(fm.license).toBe("MIT");
    expect(fm.compatibility).toBe("Requires network access.");
    expect(fm.metadata).toEqual({ author: "example", locale: "ko-KR" });
    expect(fm.allowedTools).toBe("Read Bash(git:*)");
    expect(body.trim()).toBe("Body text.");
  });

  it("reads a `triggers` block sequence as well as an inline one", () => {
    const { fm } = parseFrontmatter(
      ["---", "name: seq", "description: d", "triggers:", "  - alpha", "  - beta", "---", "b"].join("\n"),
    );
    expect(fm.triggers).toEqual(["alpha", "beta"]);
  });

  it("keeps the fields on a skill loaded from the user directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skill-contract-"));
    try {
      mkdirSync(join(dir, "full-header"));
      writeFileSync(join(dir, "full-header", "SKILL.md"), FULL_HEADER, "utf8");
      const store = new SkillStore({ userDir: dir });
      const skill = await store.load("full-header");
      expect(skill?.triggers).toEqual(["alpha", "beta"]);
      expect(skill?.license).toBe("MIT");
      expect(skill?.compatibility).toBe("Requires network access.");
      expect(skill?.metadata).toEqual({ author: "example", locale: "ko-KR" });
      expect(skill?.allowedTools).toBe("Read Bash(git:*)");
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("keeps the same fields on a skill bundled in a plugin generation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skill-contract-"));
    try {
      const store = new SkillStore({ userDir: dir });
      store.publishPluginGeneration(pluginGeneration("plugin-one", BUNDLED_HEADER));
      const skill = await store.load("plugin:plugin-one:full_header");
      expect(skill?.triggers).toEqual(["alpha", "beta"]);
      expect(skill?.license).toBe("MIT");
      expect(skill?.compatibility).toBe("Requires network access.");
      expect(skill?.metadata).toEqual({ author: "example", locale: "ko-KR" });
      expect(skill?.allowedTools).toBe("Read Bash(git:*)");
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("leaves the optional fields absent when the header omits them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skill-contract-"));
    try {
      mkdirSync(join(dir, "bare"));
      writeFileSync(
        join(dir, "bare", "SKILL.md"),
        ["---", "name: bare", "description: d", "---", "b"].join("\n"),
        "utf8",
      );
      const store = new SkillStore({ userDir: dir });
      const skill = await store.load("bare");
      expect(skill?.triggers).toEqual([]);
      expect(skill?.license).toBeUndefined();
      expect(skill?.metadata).toBeUndefined();
      expect(skill?.allowedTools).toBeUndefined();
    } finally {
      await cleanupTmpDir(dir);
    }
  });
});

describe("skill front matter — triggers reach the catalog and leave with the skill", () => {
  it("registers and unregisters a user skill's triggers with the skill itself", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skill-contract-"));
    try {
      mkdirSync(join(dir, "full-header"));
      writeFileSync(join(dir, "full-header", "SKILL.md"), FULL_HEADER, "utf8");
      const store = new SkillStore({ userDir: dir });
      expect(store.listCatalogSync()).toContainEqual({
        name: "full-header",
        description: "Every declared field, present.",
        triggers: ["alpha", "beta"],
      });

      rmSync(join(dir, "full-header"), { recursive: true, force: true });
      expect(store.listCatalogSync().map((entry) => entry.name)).not.toContain("full-header");
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("registers and unregisters a plugin skill's triggers with its generation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skill-contract-"));
    try {
      const store = new SkillStore({ userDir: dir });
      store.publishPluginGeneration(pluginGeneration("plugin-one", BUNDLED_HEADER));
      expect(store.listCatalogSync()).toContainEqual({
        name: "plugin:plugin-one:full_header",
        description: "Every declared field, present.",
        triggers: ["alpha", "beta"],
        pluginOwner: expect.objectContaining({ pluginId: "plugin-one" }),
      });

      store.removePlugin("plugin-one");
      expect(store.listCatalogSync()).toEqual([]);
    } finally {
      await cleanupTmpDir(dir);
    }
  });
});

describe("skill name rule — one rule, and it is the schema's", () => {
  it("the host's charset is the pattern the SDK schema carries", () => {
    // Read, never restated: a literal here would pass against a host constant
    // that had drifted away from the SDK, which is the whole failure this
    // guards.
    expect(SKILL_NAME_ALLOWLIST.source).toBe(skillComponent.properties.name.pattern);
    expect(SKILL_NAME_MAX_CHARS).toBe(skillComponent.properties.name.maxLength);
  });

  it("the record carries exactly the fields the schema declares", () => {
    // `allowed-tools` is camel-cased on the record because the hyphen is not
    // addressable in TypeScript; every other name is carried verbatim.
    const parsed = parseFrontmatter(FULL_HEADER).fm;
    const declared = Object.keys(skillComponent.properties).map((field) =>
      field === "allowed-tools" ? "allowedTools" : field,
    );
    expect(Object.keys(parsed).sort()).toEqual(declared.sort());
    expect(skillComponent.required).toEqual(["name", "description"]);
  });

  it("admits the spellings the schema admits and refuses the ones it refuses", () => {
    for (const name of ["My_Skill", "UPPER", "ab", "-lead", "trail-", "a".repeat(SKILL_NAME_MAX_CHARS)]) {
      expect(isAllowedSkillName(name), name).toBe(true);
    }
    for (const name of ["", "has space", "dot.name", "../escape", "a".repeat(SKILL_NAME_MAX_CHARS + 1)]) {
      expect(isAllowedSkillName(name), name).toBe(false);
    }
  });

  it("refuses a name over the ceiling at load, not just at install", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skill-contract-"));
    try {
      const overlong = "a".repeat(SKILL_NAME_MAX_CHARS + 1);
      mkdirSync(join(dir, overlong));
      writeFileSync(
        join(dir, overlong, "SKILL.md"),
        ["---", `name: ${overlong}`, "description: d", "---", "b"].join("\n"),
        "utf8",
      );
      const store = new SkillStore({ userDir: dir });
      expect(await store.load(overlong)).toBeNull();
      expect(store.listCatalogSync()).toEqual([]);
    } finally {
      await cleanupTmpDir(dir);
    }
  });
});
