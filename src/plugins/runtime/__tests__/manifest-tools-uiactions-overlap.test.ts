/**
 * #885 v6 (#1554 lineage) — the governed-vs-bypass invariant is now enforced by
 * the pure tool-object VISIBILITY, not the old `tools[] ∩ uiActions` soft-warn
 * (which is DELETED — a dual method is one object, so the overlap shape no longer
 * exists).
 *
 *  - A legacy DUAL-declared method (in BOTH `tools[]` and `uiActions`) normalizes
 *    to ONE `Tool` with visibility `["model","app"]` — it loads fine and, being
 *    model-visible, stays on the governed executor (`isUiOnly=false`).
 *  - An AUTH tool that resolves model-visible (the pure-form analog of "leaked
 *    into tools[]") is REJECTED by the auth-visibility check (must be exactly
 *    `["app"]`) — the #1554 "auth is never model-callable" invariant, now
 *    enforced at the tool-object level rather than by a cross-surface check.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifestValidator, parsePluginJson } from "../manifest-validation.js";
import { compileLegacyToolSurface } from "../../__tests__/test-helpers.js";

describe("#885 v6 — dual-declared visibility (the #1554 governed-vs-bypass invariant)", () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "tools-visibility-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function writeManifest(extra: Record<string, unknown>): Promise<string> {
    const path = join(workDir, "plugin.json");
    const { tools, uiActions, ...restExtra } = extra as {
      tools?: string[];
      uiActions?: Record<string, { description?: string }>;
    } & Record<string, unknown>;
    // Pure v6: compile the legacy tools[]/uiActions surface into Tool[] with
    // explicit visibility (dual→[model,app], tools-only→[model], ui-only→[app]).
    await writeFile(
      path,
      JSON.stringify({
        id: "overlap-test",
        name: "Overlap Test",
        description: "x",
        version: "1.0.0",
        entry: "dist/p.js",
        publisher: "LVIS",
        ...restExtra,
        tools: compileLegacyToolSurface({ tools, uiActions }),
      }),
    );
    return path;
  }

  it("compiles a legacy dual-declared method to ONE Tool with visibility [model, app]", async () => {
    const validator = await buildManifestValidator();
    const path = await writeManifest({
      tools: ["shared_method", "t_one"],
      uiActions: {
        shared_method: { description: "dual-declared" },
        ui_only_method: {},
      },
      // deliberately NO `auth` block — this exercises the general (non-auth) case.
    });
    const manifest = await parsePluginJson(path, validator);
    // dual → ["model","app"] → model-visible → governed (never the bypass).
    expect(manifest.tools.find((t) => t.name === "shared_method")?._meta?.ui?.visibility).toEqual([
      "model",
      "app",
    ]);
    // tools[]-only → ["model"]; uiActions-only → ["app"].
    expect(manifest.tools.find((t) => t.name === "t_one")?._meta?.ui?.visibility).toEqual(["model"]);
    expect(manifest.tools.find((t) => t.name === "ui_only_method")?._meta?.ui?.visibility).toEqual([
      "app",
    ]);
  });

  it("keeps tools[]-only and uiActions-only disjoint methods on their own surfaces", async () => {
    const validator = await buildManifestValidator();
    const path = await writeManifest({
      tools: ["t_one"],
      uiActions: { ui_only_method: {} },
    });
    const manifest = await parsePluginJson(path, validator);
    expect(manifest.tools.find((t) => t.name === "t_one")?._meta?.ui?.visibility).toEqual(["model"]);
    expect(manifest.tools.find((t) => t.name === "ui_only_method")?._meta?.ui?.visibility).toEqual([
      "app",
    ]);
  });

  it("REJECTS an auth tool that resolves model-visible (the #1554 'auth never model-callable' invariant)", async () => {
    const validator = await buildManifestValidator();
    const path = await writeManifest({
      // ms_status is declared in BOTH tools[] and uiActions → dual ["model","app"];
      // an auth tool MUST be exactly ["app"], so this is rejected at load.
      tools: ["ms_status", "shared_method"],
      uiActions: {
        ms_status: {},
        ms_login: {},
        shared_method: { description: "dual-declared non-auth" },
      },
      auth: { statusTool: "ms_status", loginTool: "ms_login" },
      emittedEvents: ["overlap-test.auth.changed"],
    });
    await expect(parsePluginJson(path, validator)).rejects.toThrow(
      /must have visibility exactly \["app"\]/,
    );
  });
});
