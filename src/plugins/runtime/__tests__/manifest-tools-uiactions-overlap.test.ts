/**
 * #1554 — manifest-validation must carry a GENERAL, unconditional tools[] ∩
 * uiActions overlap guard, not only the auth-tool-name overlap check nested
 * inside `if (parsed.auth)`. A plugin with no `auth` block previously had zero
 * overlap visibility.
 *
 * The guard is a SOFT WARN (not a hard fail): a dual-declared method is
 * legitimate because `plugin-tool-invocation.ts` fail-closes it to the governed
 * ToolExecutor path (never the uiActions runtime bypass). The warn documents
 * that invariant; it must NOT break the first-party plugins that legitimately
 * overlap. The logger routes warn -> console.warn, so we spy on console.warn.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifestValidator, parsePluginJson } from "../manifest-validation.js";

describe("manifest tools[] ∩ uiActions overlap — unconditional soft warn (#1554)", () => {
  let workDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "tools-uiactions-overlap-"));
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    warnSpy.mockRestore();
    await rm(workDir, { recursive: true, force: true });
  });

  async function writeManifest(extra: Record<string, unknown>): Promise<string> {
    const path = join(workDir, "plugin.json");
    await writeFile(
      path,
      JSON.stringify({
        id: "overlap-test",
        name: "Overlap Test",
        description: "x",
        version: "1.0.0",
        entry: "dist/p.js",
        publisher: "LVIS",
        ...extra,
      }),
    );
    return path;
  }

  function overlapWarned(method: string): boolean {
    return warnSpy.mock.calls.some((args) =>
      args.some(
        (a) =>
          typeof a === "string" &&
          a.includes("BOTH tools[] and uiActions") &&
          a.includes(method),
      ),
    );
  }

  it("DOES warn when a method appears in BOTH tools[] and uiActions with NO auth block", async () => {
    const validator = await buildManifestValidator();
    const path = await writeManifest({
      tools: ["shared_method", "t_one"],
      uiActions: {
        shared_method: { description: "dual-declared" },
        ui_only_method: {},
      },
      // deliberately NO `auth` block — this is the gap #1554 closes
    });
    await parsePluginJson(path, validator);
    expect(overlapWarned("shared_method")).toBe(true);
    // The purely UI-only method must NOT be reported as an overlap.
    expect(overlapWarned("ui_only_method")).toBe(false);
  });

  it("does NOT warn when tools[] and uiActions are disjoint", async () => {
    const validator = await buildManifestValidator();
    const path = await writeManifest({
      tools: ["t_one"],
      uiActions: { ui_only_method: {} },
    });
    await parsePluginJson(path, validator);
    expect(overlapWarned("ui_only_method")).toBe(false);
    expect(overlapWarned("t_one")).toBe(false);
  });
});
