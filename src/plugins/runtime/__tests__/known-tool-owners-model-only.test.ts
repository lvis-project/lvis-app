/**
 * #885 v6 (§2.4a) — `knownToolOwners` is MODEL-ONLY (access-control non-widening).
 *
 * The ownership map is the pre-runtime `??` fallback in `resolveToolOwner`
 * (`methodMap.get(m)?.pluginId ?? knownToolOwners.get(m)`), which feeds
 * plugin-to-plugin access control (`assertPluginToolAccess`) and the "plugin
 * still installing" guard (`throwIfToolOwnerNotReady`). Today's `tools`(string[])
 * was model-facing only, so the map must contain ONLY model-visible names
 * (model-only + dual) — NEVER the app-only auth trio. A naive `.map(t => t.name)`
 * (all names) would silently add the auth trio to the access-control map — a
 * membership widening.
 *
 * This asserts the property at the BOUNDARY (public `resolveToolOwner` + the
 * not-ready guard), not by reading the private map. A future all-names `.map`
 * that re-adds the auth trio flips BOTH assertions → fails closed.
 */
import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginRuntime } from "../../runtime.js";
import { normalizeManifest } from "../../types.js";

const HOST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PLUGIN_ID = "auth-plugin";

// Pure v6 manifest normalized (visibility materialized):
//   ap_list             — ["model"]         (model-only)
//   ap_toggle           — ["model","app"]   (dual)
//   ap_status / ap_login — ["app"]          (app-only auth trio)
const MANIFEST = normalizeManifest({
  id: PLUGIN_ID,
  name: "Auth Plugin",
  version: "1.0.0",
  entry: "dist/index.js",
  description: "x",
  tools: [
    { name: "ap_list", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model"] } } },
    { name: "ap_toggle", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } },
    { name: "ap_status", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] } } },
    { name: "ap_login", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] } } },
  ],
  auth: { statusTool: "ap_status", loginTool: "ap_login" },
});

const MODEL_VISIBLE = ["ap_list", "ap_toggle"]; // today's exact ownership set
const AUTH_TRIO = ["ap_status", "ap_login"]; // app-only — must NEVER own

function runtimeWithOwners(): PluginRuntime {
  const rt = new PluginRuntime({ hostRoot: HOST_ROOT, manifestPaths: [] });
  // Populate the ownership snapshot through the REAL setter (the one carrying the
  // MODEL-ONLY `.filter(isModelVisible)`). methodMap stays empty, so
  // `resolveToolOwner` reflects the pre-runtime snapshot exactly.
  (rt as unknown as {
    rememberPluginManifest(id: string, m: typeof MANIFEST, a: undefined): void;
  }).rememberPluginManifest(PLUGIN_ID, MANIFEST, undefined);
  return rt;
}

describe("knownToolOwners — MODEL-ONLY access-control non-widening (#885 §2.4a)", () => {
  it("the pre-runtime snapshot resolves ONLY the model-visible names (auth trio excluded)", () => {
    const rt = runtimeWithOwners();
    // model-only + dual resolve to the owner...
    for (const name of MODEL_VISIBLE) {
      expect(rt.resolveToolOwner(name)).toBe(PLUGIN_ID);
    }
    // ...the app-only auth trio does NOT (a naive all-names `.map` would flip these).
    for (const name of AUTH_TRIO) {
      expect(rt.resolveToolOwner(name)).toBeUndefined();
    }
    // The resolved owner set == EXACTLY today's model-visible set.
    const owned = [...MODEL_VISIBLE, ...AUTH_TRIO].filter(
      (n) => rt.resolveToolOwner(n) === PLUGIN_ID,
    );
    expect(owned.sort()).toEqual([...MODEL_VISIBLE].sort());
  });

  it("the 'plugin still installing' guard fires for a model-visible owner but early-returns for the app-only auth trio", () => {
    const rt = runtimeWithOwners();
    const internals = rt as unknown as {
      preparation: { preparingPluginIds: Set<string> };
      throwIfToolOwnerNotReady(toolName: string): void;
    };
    // Enter the pre-runtime "preparing" window so the not-ready guard is live.
    internals.preparation.preparingPluginIds.add(PLUGIN_ID);
    // A model-visible name IS in the snapshot → the guard throws "still installing".
    expect(() => internals.throwIfToolOwnerNotReady("ap_list")).toThrow(/still installing/);
    // The auth trio is NOT in the snapshot → the guard early-returns (no throw). A
    // leaked auth name (in the ownership map) would make these throw → fails closed.
    for (const name of AUTH_TRIO) {
      expect(() => internals.throwIfToolOwnerNotReady(name)).not.toThrow();
    }
  });
});
