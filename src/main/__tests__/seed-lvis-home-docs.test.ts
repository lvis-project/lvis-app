/**
 * seedLvisHomeDocs — first-boot seed + `.new` upgrade-marker coverage.
 *
 * Covers the unit-testable acceptance criteria of issue #1108 (follow-up to
 * PR #1104's built-in agents/skills seed):
 *   - first-boot copy of packaged resources into ~/.lvis/{AGENTS.md,agents,skills,prompts}
 *   - byte-identical re-run is a no-op (idempotent)
 *   - a user-edited copy survives upgrade; the new packaged version lands as
 *     `<file>.new` rather than clobbering the user's edit
 *   - a second divergent upgrade lands a timestamped `<file>.new.<ts>` and
 *     leaves the prior `.new` untouched
 *   - an already-offered `.new` identical to the packaged copy is a no-op
 *   - seeded files are chmod 0o600 (POSIX)
 *
 * Dev-mode resolution (`app.isPackaged === false`) reads packaged resources
 * from `join(process.cwd(), "resources", …)`, so the test points `process.cwd`
 * at a temp fixtures root and `LVIS_HOME` at a temp home — no real ~/.lvis or
 * repo resources are touched.
 *
 * The platform-installer smoke (resources actually ship in the DMG/NSIS/AppImage
 * and seed on real first launch) remains a manual/CI step — see issue #1108.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

vi.mock("electron", () => ({ app: { isPackaged: false } }));

import { seedLvisHomeDocs } from "../seed-lvis-home-docs.js";

let fixtures: string;
let home: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;
const prevLvisHome = process.env.LVIS_HOME;

/** Write a packaged resource fixture under <fixtures>/resources/<rel>. */
function writeRes(rel: string, content: string): void {
  const p = join(fixtures, "resources", rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

beforeEach(() => {
  fixtures = mkdtempSync(join(tmpdir(), "lvis-seed-fix-"));
  home = mkdtempSync(join(tmpdir(), "lvis-seed-home-"));
  process.env.LVIS_HOME = home;
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(fixtures);

  writeRes("AGENTS.md", "AGENTS v1\n");
  writeRes(join("agents", "executor.md"), "executor v1\n");
  writeRes(join("skills", "report-writing.md"), "report v1\n");
  writeRes(join("prompts", "summarizer.md"), "summarizer v1\n");
});

afterEach(() => {
  cwdSpy.mockRestore();
  rmSync(fixtures, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  if (prevLvisHome === undefined) delete process.env.LVIS_HOME;
  else process.env.LVIS_HOME = prevLvisHome;
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
});

describe("seedLvisHomeDocs — upgrade markers", () => {
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
