/**
 * seedLvisHomeDocs — first-boot seed + `.new` upgrade-marker coverage.
 *
 * Covers the unit-testable acceptance criteria of issue #1108 (follow-up to
 * PR #1104's built-in agents/skills seed):
 *   - first-boot copy of packaged resources into ~/.lvis/{AGENTS.md,agents,skills,prompts}
 *   - byte-identical re-run is a no-op (idempotent)
 *   - a byte-identical known packaged AGENTS.md predecessor is replaced in place
 *   - a user-edited AGENTS.md / skill / prompt copy survives upgrade; the new
 *     packaged version lands as `<file>.new` rather than clobbering the user's edit
 *   - user-edited agent profiles are seed-only and do not create `agents/*.md.new`
 *   - a second divergent upgrade lands a timestamped `<file>.new.<ts>` and
 *     leaves the prior `.new` untouched
 *   - an already-offered `.new` identical to the packaged copy is a no-op
 *   - seeded files are chmod 0o600 (POSIX)
 *
 * Dev-mode resolution (`app.isPackaged === false`) walks up from the module's
 * own location to the first ancestor containing `resources/skills` — a fully
 * cwd-independent anchor that also ignores `app.getAppPath()` (wrong under
 * `bun run start`, where the launcher passes a script-file arg and getAppPath
 * resolves to the script dir `dist/src/main`). The test points the
 * `LVIS_RESOURCE_ROOT` override at a temp fixtures root and `LVIS_HOME` at a
 * temp home — no real ~/.lvis or repo resources are touched.
 *
 * The packaged launch smoke verifies that resources ship and seed on real
 * first launch; this file keeps the deterministic seed/upgrade semantics.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  lstatSync,
  statSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { app } from "electron";

vi.mock("electron", () => ({ app: { isPackaged: false } }));

import {
  listLvisHomeDocUpgradeMarkers,
  seedLvisHomeDocs,
} from "../seed-lvis-home-docs.js";
import * as atomicFile from "../../lib/atomic-file.js";

let fixtures: string;
let home: string;
const prevLvisHome = process.env.LVIS_HOME;
const prevResourceRoot = process.env.LVIS_RESOURCE_ROOT;
const originalResourcesPathDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "resourcesPath",
);

function setResourcesPath(value: string | undefined): void {
  Object.defineProperty(process, "resourcesPath", {
    value,
    configurable: true,
    writable: true,
  });
}

/** Write a packaged resource fixture under <fixtures>/resources/<rel>. */
function writeRes(rel: string, content: string): void {
  const p = join(fixtures, "resources", rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

beforeEach(() => {
  fixtures = mkdtempSync(join(tmpdir(), "lvis-seed-fix-"));
  home = mkdtempSync(join(tmpdir(), "lvis-seed-home-"));
  process.env.LVIS_HOME = home;
  process.env.LVIS_RESOURCE_ROOT = fixtures;

  writeRes("AGENTS.md", "AGENTS v1\n");
  writeRes("AGENTS.md.replaceable-sha256", `${sha256("AGENTS v1\n")}\n`);
  writeRes(join("agents", "executor.md"), "executor v1\n");
  writeRes(join("skills", "report-writing.md"), "report v1\n");
  writeRes(join("prompts", "summarizer.md"), "summarizer v1\n");
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(fixtures, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  if (prevLvisHome === undefined) delete process.env.LVIS_HOME;
  else process.env.LVIS_HOME = prevLvisHome;
  if (prevResourceRoot === undefined) delete process.env.LVIS_RESOURCE_ROOT;
  else process.env.LVIS_RESOURCE_ROOT = prevResourceRoot;
  (app as { isPackaged: boolean }).isPackaged = false;
  if (originalResourcesPathDescriptor) {
    Object.defineProperty(process, "resourcesPath", originalResourcesPathDescriptor);
  } else {
    delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  }
});

describe("seedLvisHomeDocs — first boot", () => {
  it("copies AGENTS.md + agents/*.md + skills/*.md + prompts/*.md into ~/.lvis", () => {
    const r = seedLvisHomeDocs();

    expect(r.seeded).toContain("AGENTS.md");
    expect(r.seeded).toContain(join("agents", "executor.md"));
    expect(r.seeded).toContain(join("skills", "report-writing.md"));
    expect(r.seeded).toContain(join("prompts", "summarizer.md"));
    expect(r.upgraded).toEqual([]);

    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("AGENTS v1\n");
    expect(readFileSync(join(home, "agents", "executor.md"), "utf8")).toBe(
      "executor v1\n",
    );
    expect(readFileSync(join(home, "skills", "report-writing.md"), "utf8")).toBe(
      "report v1\n",
    );
    expect(readFileSync(join(home, "prompts", "summarizer.md"), "utf8")).toBe(
      "summarizer v1\n",
    );
  });

  it("resolves dev resources independent of process.cwd() (regression: chdir-before-seed)", () => {
    // ensureWorkspaceCwd() chdir()s the main process to ~/.lvis/workspace before
    // boot. Seeding must still find the repo's resources/ via the module-anchored
    // walk-up, not a cwd-relative join (and not app.getAppPath(), which points at
    // the script dir under `bun run start`).
    const originalCwd = process.cwd();
    const elsewhere = mkdtempSync(join(tmpdir(), "lvis-seed-cwd-"));
    process.chdir(elsewhere);
    try {
      const r = seedLvisHomeDocs();
      expect(r.seeded).toContain("AGENTS.md");
      expect(r.seeded).toContain(join("skills", "report-writing.md"));
      expect(readFileSync(join(home, "skills", "report-writing.md"), "utf8")).toBe(
        "report v1\n",
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("seeds files as 0o600 (POSIX)", () => {
    if (process.platform === "win32") return;
    seedLvisHomeDocs();
    expect(statSync(join(home, "AGENTS.md")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "agents", "executor.md")).mode & 0o777).toBe(
      0o600,
    );
  });

  it("is a no-op when re-run against byte-identical packaged content", () => {
    seedLvisHomeDocs();
    const r2 = seedLvisHomeDocs();
    expect(r2.seeded).toEqual([]);
    expect(r2.upgraded).toEqual([]);
    expect(existsSync(join(home, "AGENTS.md.new"))).toBe(false);
  });

  it("uses process.resourcesPath when Electron is packaged", () => {
    const resourcesPath = mkdtempSync(join(tmpdir(), "lvis-packaged-resources-"));
    try {
      (app as { isPackaged: boolean }).isPackaged = true;
      setResourcesPath(resourcesPath);
      writeFileSync(join(resourcesPath, "AGENTS.md"), "PACKAGED AGENTS\n");
      mkdirSync(join(resourcesPath, "agents"), { recursive: true });
      mkdirSync(join(resourcesPath, "skills"), { recursive: true });
      mkdirSync(join(resourcesPath, "prompts"), { recursive: true });
      writeFileSync(join(resourcesPath, "agents", "executor.md"), "packaged executor\n");
      writeFileSync(join(resourcesPath, "skills", "report-writing.md"), "packaged report\n");
      writeFileSync(join(resourcesPath, "prompts", "summarizer.md"), "packaged prompt\n");

      const r = seedLvisHomeDocs();

      expect(r.seeded).toContain("AGENTS.md");
      expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("PACKAGED AGENTS\n");
      expect(readFileSync(join(home, "skills", "report-writing.md"), "utf8")).toBe("packaged report\n");
    } finally {
      rmSync(resourcesPath, { recursive: true, force: true });
    }
  });
});

describe("seedLvisHomeDocs — upgrade markers", () => {
  it("replaces a byte-identical known packaged AGENTS.md predecessor in place", () => {
    seedLvisHomeDocs();
    writeRes("AGENTS.md", "AGENTS v2\n");

    const r = seedLvisHomeDocs();

    expect(r.upgraded).toContain("AGENTS.md");
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("AGENTS v2\n");
    expect(existsSync(join(home, "AGENTS.md.new"))).toBe(false);
  });

  it("preserves a concurrent edit detected before the atomic replacement commit", () => {
    seedLvisHomeDocs();
    writeRes("AGENTS.md", "AGENTS v2\n");
    const atomicReplace = atomicFile.replaceUtf8FileAtomicSyncIf;
    vi.spyOn(atomicFile, "replaceUtf8FileAtomicSyncIf").mockImplementationOnce(
      (target, content, precondition, mode) => {
        writeFileSync(target, "concurrent user edit\n");
        return atomicReplace(target, content, precondition, mode);
      },
    );

    const r = seedLvisHomeDocs();

    expect(r.upgraded).toContain("AGENTS.md");
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe(
      "concurrent user edit\n",
    );
    expect(readFileSync(join(home, "AGENTS.md.new"), "utf8")).toBe("AGENTS v2\n");
  });

  it("keeps the predecessor intact when atomic staging fails", () => {
    seedLvisHomeDocs();
    writeRes("AGENTS.md", "AGENTS v2\n");
    vi.spyOn(atomicFile, "replaceUtf8FileAtomicSyncIf").mockImplementationOnce(() => {
      throw Object.assign(new Error("forced staging failure"), { code: "EIO" });
    });

    const r = seedLvisHomeDocs();

    expect(r.upgraded).toContain("AGENTS.md");
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("AGENTS v1\n");
    expect(readFileSync(join(home, "AGENTS.md.new"), "utf8")).toBe("AGENTS v2\n");
  });

  it("does not follow an AGENTS.md symlink during packaged replacement", () => {
    if (process.platform === "win32") return;
    seedLvisHomeDocs();
    const external = join(fixtures, "external-agents.md");
    writeFileSync(external, "AGENTS v1\n");
    unlinkSync(join(home, "AGENTS.md"));
    symlinkSync(external, join(home, "AGENTS.md"));
    writeRes("AGENTS.md", "AGENTS v2\n");

    const r = seedLvisHomeDocs();

    expect(r.upgraded).toContain("AGENTS.md");
    expect(lstatSync(join(home, "AGENTS.md")).isSymbolicLink()).toBe(true);
    expect(readFileSync(external, "utf8")).toBe("AGENTS v1\n");
    expect(readFileSync(join(home, "AGENTS.md.new"), "utf8")).toBe("AGENTS v2\n");
  });

  it("preserves a user edit and writes the new packaged version to <file>.new", () => {
    seedLvisHomeDocs();
    writeFileSync(join(home, "AGENTS.md"), "user edited\n");
    writeRes("AGENTS.md", "AGENTS v2\n");

    const r = seedLvisHomeDocs();

    expect(r.upgraded).toContain("AGENTS.md");
    // user's edit is never clobbered
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("user edited\n");
    // upgrade content offered alongside
    expect(readFileSync(join(home, "AGENTS.md.new"), "utf8")).toBe("AGENTS v2\n");
  });

  it("lands a timestamped <file>.new.<ts> on a second divergent upgrade, keeping the prior .new", () => {
    seedLvisHomeDocs();
    writeFileSync(join(home, "AGENTS.md"), "user edited\n");
    writeRes("AGENTS.md", "AGENTS v2\n");
    seedLvisHomeDocs(); // creates AGENTS.md.new = v2

    writeRes("AGENTS.md", "AGENTS v3\n"); // packaged diverges from the existing .new
    const r = seedLvisHomeDocs();

    expect(r.upgraded).toContain("AGENTS.md");
    // prior .new is preserved (user's review work not lost)
    expect(readFileSync(join(home, "AGENTS.md.new"), "utf8")).toBe("AGENTS v2\n");
    // newer upgrade lands as a dated sibling
    const dated = readdirSync(home).filter(
      (f) => f.startsWith("AGENTS.md.new.") && f !== "AGENTS.md.new",
    );
    expect(dated).toHaveLength(1);
    expect(readFileSync(join(home, dated[0]), "utf8")).toBe("AGENTS v3\n");
  });

  it("keeps user-edited agent profiles seed-only without creating .new markers", () => {
    seedLvisHomeDocs();
    writeFileSync(join(home, "agents", "executor.md"), "user executor\n");
    writeRes(join("agents", "executor.md"), "executor v2\n");

    const r = seedLvisHomeDocs();

    expect(r.upgraded).not.toContain(join("agents", "executor.md"));
    expect(readFileSync(join(home, "agents", "executor.md"), "utf8")).toBe(
      "user executor\n",
    );
    expect(existsSync(join(home, "agents", "executor.md.new"))).toBe(false);
  });

  it("lists pending .new upgrade markers without surfacing agent profile markers", () => {
    seedLvisHomeDocs();
    writeFileSync(join(home, "AGENTS.md"), "user edited\n");
    writeFileSync(join(home, "skills", "report-writing.md"), "user report\n");
    writeFileSync(join(home, "agents", "executor.md"), "user executor\n");
    writeRes("AGENTS.md", "AGENTS v2\n");
    writeRes(join("skills", "report-writing.md"), "report v2\n");
    writeRes(join("agents", "executor.md"), "executor v2\n");

    seedLvisHomeDocs();
    writeFileSync(join(home, "agents", "legacy.md.new"), "legacy agent marker\n");

    expect(listLvisHomeDocUpgradeMarkers(home)).toEqual([
      { markerPath: "AGENTS.md.new", sourcePath: "AGENTS.md" },
      {
        markerPath: join("skills", "report-writing.md.new"),
        sourcePath: join("skills", "report-writing.md"),
      },
    ]);
  });

  it("is a no-op when the existing .new already matches the packaged content", () => {
    seedLvisHomeDocs();
    writeFileSync(join(home, "AGENTS.md"), "user edited\n");
    writeRes("AGENTS.md", "AGENTS v2\n");
    seedLvisHomeDocs(); // .new = v2

    const r = seedLvisHomeDocs(); // packaged still v2, .new still v2

    expect(r.upgraded).not.toContain("AGENTS.md");
    const dated = readdirSync(home).filter((f) =>
      f.startsWith("AGENTS.md.new."),
    );
    expect(dated).toHaveLength(0);
  });
});
