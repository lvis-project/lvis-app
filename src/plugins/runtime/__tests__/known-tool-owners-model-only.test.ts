/**
 * #885 v6 (§2.4a) — `knownToolOwners` is MODEL-ONLY (access-control non-widening).
 *
 * The ownership map is the pre-runtime `??` fallback in `resolveToolOwner`
 * (`methodMap.get(m)?.pluginId ?? knownToolOwners.get(m)`), which feeds
 * plugin-to-plugin access control (`assertPluginToolAccess`) and the "plugin
 * still installing" guard (`throwIfToolOwnerNotReady`). Today's `tools`(string[])
 * was model-facing only, so the map must contain ONLY model-visible names
 * (model-only + dual) — NEVER app-only names. A naive `.map(t => t.name)`
 * (all names) would silently add them to the access-control map — a membership
 * widening.
 *
 * WHY THIS IS NOW THE SHARP EDGE. App-only tools became §6.4 registry `Tool`s (so a
 * card's call to one runs under the gate) and are subtracted from the model's tool
 * list at the registry's model-exposure boundary. Three concerns that used to travel
 * together — may-execute / is-shown-to-the-model / owns-the-name — are now three
 * separate answers, and THIS map is the third one. It does not follow the registry.
 * The tempting "app-only tools are real tools now, so let the ownership map see them"
 * is exactly the widening §2.4a ratified against: it would hand the app-only auth
 * trio a plugin-to-plugin access-control identity it has never had.
 *
 * This asserts the property at the BOUNDARY (public `resolveToolOwner` + the
 * not-ready guard), not by reading the private map. A future all-names `.map`
 * that re-adds app-only names flips BOTH assertions → fails closed.
 */
import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginRuntime } from "../../runtime.js";
import type { PluginManifest } from "../../types.js";

const HOST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PLUGIN_ID = "auth-plugin";

// Pure v6 manifest normalized (visibility materialized):
//   ap_list              — ["model"]         (model-only)
//   ap_toggle            — ["model","app"]   (dual)
//   ap_status / ap_login — ["app"]           (app-only auth trio)
//   ap_ui_rows           — ["app"]           (app-only card-serving tool — a
//                                             GOVERNED registry Tool, and still not
//                                             an owner)
const MANIFEST: PluginManifest = {
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
    { name: "ap_ui_rows", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] } } },
  ],
  auth: { statusTool: "ap_status", loginTool: "ap_login" },
};

const MODEL_VISIBLE = ["ap_list", "ap_toggle"]; // today's exact ownership set
const APP_ONLY = ["ap_status", "ap_login", "ap_ui_rows"]; // must NEVER own
const AUTH_TRIO = ["ap_status", "ap_login"];

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
  it("the pre-runtime snapshot resolves ONLY the model-visible names (every app-only name excluded)", () => {
    const rt = runtimeWithOwners();
    // model-only + dual resolve to the owner...
    for (const name of MODEL_VISIBLE) {
      expect(rt.resolveToolOwner(name)).toBe(PLUGIN_ID);
    }
    // ...no app-only name does — not the auth trio, and not the card-serving tool
    // either, even though it is now a governed registry `Tool`. (A naive all-names
    // `.map`, or "the registry has them now, so should this map", flips these.)
    for (const name of APP_ONLY) {
      expect(rt.resolveToolOwner(name)).toBeUndefined();
    }
    // The resolved owner set == EXACTLY today's model-visible set.
    const owned = [...MODEL_VISIBLE, ...APP_ONLY].filter(
      (n) => rt.resolveToolOwner(n) === PLUGIN_ID,
    );
    expect(owned.sort()).toEqual([...MODEL_VISIBLE].sort());
  });

  it("PINS THE MAP'S CONTENTS: knownToolOwners holds the model-visible names and nothing else", () => {
    // The boundary assertions above prove the OBSERVABLE property; this one pins the
    // map itself, so a change that widens membership fails here loudly and by name
    // instead of being caught (or not) downstream. Exact set equality — a future
    // `.filter(isAppVisible)` / all-names `.map` cannot slip an app-only name in.
    const rt = runtimeWithOwners();
    const map = (rt as unknown as { knownToolOwners: Map<string, string> }).knownToolOwners;

    expect([...map.keys()].sort()).toEqual([...MODEL_VISIBLE].sort());
    expect([...map.values()]).toEqual(MODEL_VISIBLE.map(() => PLUGIN_ID));
    for (const name of APP_ONLY) expect(map.has(name)).toBe(false);
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
