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
import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  SkillStore,
  MAX_SKILL_TRIGGERS,
  MAX_SKILL_TRIGGER_CHARS,
  SKILL_NAME_ALLOWLIST,
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

/** A generation contributing two skills, so one bad header can be contained. */
function twoSkillGeneration(
  pluginId: string,
  brokenMarkdown: string,
  goodMarkdown: string,
): ActivePluginGeneration {
  const fingerprint = "b".repeat(64);
  const contribution = (localId: string, content: string) => ({
    ownerPluginId: pluginId,
    ownerVersion: "1.0.0",
    kind: "skill" as const,
    localId,
    path: `skills/${localId}`,
    fingerprint,
    files: [{ path: `skills/${localId}/SKILL.md`, content, sha256: fingerprint }],
  });
  return {
    pluginId,
    pluginVersion: "1.0.0",
    generationId: "g1",
    artifactGenerationId: "3".repeat(64),
    manifestSha256: "1".repeat(64),
    receiptSha256: "2".repeat(64),
    state: {},
    contributions: [contribution("broken", brokenMarkdown), contribution("good", goodMarkdown)],
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

describe("skill front matter — a header that reads short, and one that does not read", () => {
  it("reports a value an unquoted '#' truncated, and keeps the YAML reading", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { fm } = parseFrontmatter(
        ["---", "name: hashed", "description: cost #1 priority", "---", "b"].join("\n"),
      );
      // YAML is right and the value really is short — the point is that the
      // loss is announced rather than silent.
      expect(fm.description).toBe("cost");
      const said = warn.mock.calls.map((call) => String(call[0])).join("\n");
      expect(said).toContain("description");
      expect(said).toContain("hashed");
      expect(said).toContain("cost #1 priority");
    } finally {
      warn.mockRestore();
    }
  });

  it("says nothing when a quoted value legitimately differs from its raw line", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { fm } = parseFrontmatter(
        ["---", "name: quoted", 'description: "cost #1 priority"', "---", "b"].join("\n"),
      );
      expect(fm.description).toBe("cost #1 priority");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses exactly the header shapes the loading policy documents", () => {
    // The migration note in docs/development/skill-loading-policy.md tells an
    // author which headers stop loading and how to quote them. It is only
    // useful if it is accurate, so the shapes are checked here rather than
    // trusted — the first draft of that table claimed an unquoted `3:1`
    // breaks, and it does not.
    const header = (description: string) =>
      ["---", "name: probe", `description: ${description}`, "---", "b"].join("\n");
    for (const description of ["@mention first", "[draft] notes", "use when: deploying"]) {
      expect(() => parseFrontmatter(header(description)), description).toThrow();
    }
    expect(() => parseFrontmatter(header("ratio 3:1"))).not.toThrow();
    expect(parseFrontmatter(header("ratio 3:1")).fm.description).toBe("ratio 3:1");
    expect(() =>
      parseFrontmatter(
        ["---", "name: probe", "description: d", "metadata:", "\tauthor: y", "---", "b"].join("\n"),
      ),
    ).toThrow();
  });

  it("drops only the unreadable skill from a plugin, leaving the plugin active", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skill-contract-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = new SkillStore({ userDir: dir });
      // Tab indentation is a YAML syntax error, so this header does not parse.
      const broken = ["---", "name: broken", "description: d", "metadata:", "\tauthor: x", "---", "b"].join("\n");
      const good = ["---", "name: good", "description: Still here", "---", "b"].join("\n");
      store.publishPluginGeneration(twoSkillGeneration("plugin-one", broken, good));

      // The plugin activated and its readable skill is available.
      expect((await store.load("plugin:plugin-one:good"))?.description).toBe("Still here");
      expect(await store.load("plugin:plugin-one:broken")).toBeNull();
      expect(store.listCatalogSync().map((entry) => entry.name)).toEqual([
        "plugin:plugin-one:good",
      ]);
      const said = warn.mock.calls.map((call) => String(call[0])).join("\n");
      expect(said).toContain("plugin-one:broken");
    } finally {
      warn.mockRestore();
      await cleanupTmpDir(dir);
    }
  });
});

describe("skill front matter — triggers are bounded where the record is built", () => {
  it("caps the declared hints in count and length", () => {
    const many = Array.from({ length: 30 }, (_, i) => `trigger-${i}-${"x".repeat(80)}`);
    const { fm } = parseFrontmatter(
      ["---", "name: many", "description: d", `triggers: [${many.join(", ")}]`, "---", "b"].join("\n"),
    );
    expect(fm.triggers).toHaveLength(30); // the parse keeps what the author wrote
    const dir = mkdtempSync(join(tmpdir(), "lvis-skill-contract-"));
    return (async () => {
      try {
        mkdirSync(join(dir, "many"));
        writeFileSync(
          join(dir, "many", "SKILL.md"),
          ["---", "name: many", "description: d", `triggers: [${many.join(", ")}]`, "---", "b"].join("\n"),
          "utf8",
        );
        const store = new SkillStore({ userDir: dir });
        const skill = await store.load("many");
        // The record is where the bound lands, so every consumer inherits it.
        expect(skill?.triggers).toHaveLength(MAX_SKILL_TRIGGERS);
        for (const trigger of skill?.triggers ?? []) {
          expect(trigger.length).toBeLessThanOrEqual(MAX_SKILL_TRIGGER_CHARS);
        }
        expect(store.listCatalogSync()[0].triggers).toHaveLength(MAX_SKILL_TRIGGERS);
      } finally {
        await cleanupTmpDir(dir);
      }
    })();
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

describe("skill name rule — one charset, and it is the schema's", () => {
  it("the host's charset is the pattern the SDK schema carries", () => {
    // Read, never restated: a literal here would pass against a host constant
    // that had drifted away from the SDK, which is the whole failure this
    // guards.
    expect(SKILL_NAME_ALLOWLIST.source).toBe(skillComponent.properties.name.pattern);
  });

  it("the host enforces no length of its own; the ceiling is an admission rule", () => {
    // The schema bounds a name at 64 characters and the marketplace refuses a
    // longer one at publication. The host does not re-police that: a name is
    // the author's, and a long directory name is not a safety property. If
    // this ever starts failing, the host has grown a length check that the
    // SDK's description says it does not have.
    const ceiling = skillComponent.properties.name.maxLength;
    expect(ceiling).toBeGreaterThan(0);
    expect(SKILL_NAME_ALLOWLIST.test("a".repeat((ceiling as number) + 1))).toBe(true);
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
    for (const name of ["My_Skill", "UPPER", "ab", "-lead", "trail-"]) {
      expect(SKILL_NAME_ALLOWLIST.test(name), name).toBe(true);
    }
    for (const name of ["", "has space", "dot.name", "../escape"]) {
      expect(SKILL_NAME_ALLOWLIST.test(name), name).toBe(false);
    }
  });
});

describe("the SDK schema snapshot", () => {
  it("is the file `sources.json` recorded", () => {
    // The offline half of the drift gate, run on every pull request: the bytes
    // on disk are the bytes whose hash was recorded when the snapshot was
    // taken. It catches the edit-the-copy mistake — a rule "fixed" here
    // instead of in the SDK. The other half (are these still the SDK's bytes?)
    // needs the network and runs in `.github/workflows/sdk-schema-drift.yml`.
    const sources = JSON.parse(
      readFileSync(join(REPO_ROOT, "schemas/sdk/sources.json"), "utf8"),
    ) as { ref: string; repository: string; files: Record<string, { sha256: string }> };
    const raw = readFileSync(join(REPO_ROOT, "schemas/sdk/skill-package.schema.json"), "utf8");
    expect(sources.repository).toBe("lvis-project/lvis-plugin-sdk");
    expect(sources.ref).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(createHash("sha256").update(raw, "utf8").digest("hex")).toBe(
      sources.files["skill-package.schema.json"].sha256,
    );
  });
});
