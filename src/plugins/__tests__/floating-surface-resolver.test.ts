/**
 * `PluginRuntime.resolveFloatingSurface` — the admission gate for the host's
 * always-on-top dock.
 *
 * Everything downstream of this — the slot, the clamp, the host chrome —
 * assumes it said yes for a good reason. A wrong yes here is the one that
 * matters: it puts a plugin's pixels on top of every other application on the
 * machine.
 *
 * The refusals are checked by CODE and not merely by "it did not resolve",
 * because the codes are the plugin-visible vocabulary and they are not
 * interchangeable. "You did not declare this" is a bug in the plugin; "this
 * plugin is not loaded" is a condition that may pass on its own.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

import { pureTool, TestPluginRuntime as PluginRuntime } from "./test-helpers.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

type UiEntry = {
  id: string;
  slot: string;
  kind: string;
  title: string;
  entry?: string;
  exportName?: string;
  page?: string;
};

function writePlugin(root: string, id: string, ui: UiEntry[]): string {
  const dir = join(root, id);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "card.js"), "export const Card = () => null;");
  writeFileSync(
    join(dir, "plugin.json"),
    JSON.stringify({
      id,
      name: id,
      version: "1.0.0",
      description: "Test fixture.",
      publisher: "Test fixture",
      entry: "index.mjs",
      tools: [pureTool(`${id}_noop`, ["model"])],
      ui,
    }),
  );
  writeFileSync(join(dir, "index.mjs"), "export default () => ({ handlers: {} });");
  return join(dir, "plugin.json");
}

const FLOATING: UiEntry = {
  id: "recorder",
  slot: "floating",
  kind: "embedded-module",
  title: "Recorder",
  entry: "dist/card.js",
  exportName: "Card",
};

describe("resolveFloatingSurface", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lvis-floating-"));
  });

  afterEach(async () => {
    await cleanupTmpDir(tmp);
  });

  /**
   * A FIXTURE id, not a shipped plugin's, and not one with a hyphen — the
   * fixture derives a tool name from it and the manifest schema requires
   * `^[a-zA-Z_][a-zA-Z0-9_]*$`.
   *
   * It must be an id this harness can LOAD, which means an in-process one, and
   * a made-up id is in-process by construction. Naming a real plugin here
   * bought nothing and cost a move: it was `meeting` until that id was admitted
   * to `OUT_OF_PROCESS_PLUGIN_IDS`.
   * The isolated arm spawns a confined child, and that needs the ASRT sandbox
   * initialized at boot — so every case here failed `unknown-plugin`, which
   * reads exactly like a resolver bug and is not one.
   *
   * WHAT THIS SUITE THEREFORE DOES NOT COVER, said plainly because the only
   * plugin that uses the dock is now on the other arm: `resolveFloatingSurface`
   * is exercised here against an IN-PROCESS plugin only.
   *
   * The coverage transfers because the resolver reads `this.plugins`, which
   * both arms populate through the same `plugins.set` after a successful load —
   * it never consults the routing set, and the case below pins that. What it
   * does NOT transfer is the load itself, and closing that gap means
   * initializing ASRT in this suite. That is deliberately not done: the
   * sandbox cases stand behind a live-sandbox gate that returns early where the
   * backend cannot initialize, and on the Linux runner that is always — so the
   * result would be a green suite that measured nothing on the platform it
   * looked greenest. `confined-plugin-child.test.ts` is where that gate is
   * already paid for.
   */
  async function runtimeWith(ui: UiEntry[], id = "dockfixture") {
    const runtime = new PluginRuntime({
      hostRoot: tmp,
      manifestPaths: [writePlugin(tmp, id, ui)],
    });
    await runtime.startAll();
    return runtime;
  }

  it("resolves a declared floating module surface", async () => {
    const runtime = await runtimeWith([FLOATING]);

    const resolved = runtime.resolveFloatingSurface("dockfixture", "recorder");

    expect(resolved).toMatchObject({
      pluginId: "dockfixture",
      extensionId: "recorder",
      title: "Recorder",
    });
    // Revision-stamped, so the shell's `import()` gets a fresh ESM cache key
    // after the plugin reloads. Without it a card would keep serving the
    // previous generation's module.
    expect((resolved as { entryUrl: string }).entryUrl).toMatch(/lvisRuntimeRevision=\d+/u);
  });

  it("refuses an unknown plugin", async () => {
    const runtime = await runtimeWith([FLOATING]);
    expect(runtime.resolveFloatingSurface("nope", "recorder")).toBe("unknown-plugin");
  });

  it("refuses an extension the plugin did not declare", async () => {
    const runtime = await runtimeWith([FLOATING]);
    expect(runtime.resolveFloatingSurface("dockfixture", "not-declared")).toBe("surface-not-declared");
  });

  it("refuses a sidebar surface", async () => {
    // Declaring `floating` is the plugin saying this card is meant to live on
    // top of every other window. A sidebar card never said that, and a plugin
    // must not be able to promote one by naming it here.
    const runtime = await runtimeWith([{ ...FLOATING, slot: "sidebar" }]);
    expect(runtime.resolveFloatingSurface("dockfixture", "recorder")).toBe("surface-not-floating");
  });

  it.each([
    ["embedded-page", { kind: "embedded-page", page: "dist/card.js", entry: undefined, exportName: undefined }],
    ["info-card", { kind: "info-card" }],
  ])("refuses kind=%s", async (_name, override) => {
    // Not a policy preference — it is what the surface can actually paint. The
    // dock renders through `plugin-ui-shell.html`, which resolves an entry URL
    // and `import()`s it:
    //
    //   `embedded-page` is refused everywhere already (the sidebar answers it
    //   with `legacyIframeNotSupported`), because the iframe path is gone.
    //   `info-card` is not required to declare an entry at all.
    //
    // Admitting either would produce a transparent always-on-top window with
    // nothing in it — the user would see a defect and the plugin would see
    // success.
    // Each fixture carries the fields ITS kind requires, so the manifest
    // validator lets it through and the refusal measured here is this
    // resolver's own rather than a manifest that never loaded.
    const runtime = await runtimeWith([{ ...FLOATING, ...override } as UiEntry]);
    expect(runtime.resolveFloatingSurface("dockfixture", "recorder")).toBe("surface-not-floating");
  });

  it("never sees an entry-less module surface, because the manifest is refused first", async () => {
    // `surface-has-no-entry` exists in the vocabulary and the resolver still
    // checks for it, but this is where the invariant is actually enforced:
    // `manifest-validation.ts` requires `entry` and `exportName` for
    // `embedded-module`, so a declaration without them never becomes a loaded
    // plugin. Asserting it HERE rather than pretending the resolver is the
    // gate keeps the test honest about which layer holds the line.
    const runtime = await runtimeWith([
      { id: "recorder", slot: "floating", kind: "embedded-module", title: "Recorder" },
    ]);
    expect(runtime.resolveFloatingSurface("dockfixture", "recorder")).toBe("unknown-plugin");
    expect(runtime.listPluginCards()).toHaveLength(0);
  });

  it("refuses an entry that escapes the install root", async () => {
    // A single resolve is not a list: somebody asked about exactly this
    // surface and is waiting for an answer, so the containment violation is
    // the answer rather than a silently skipped row.
    const runtime = await runtimeWith([{ ...FLOATING, entry: "../../../etc/passwd" }]);
    expect(runtime.resolveFloatingSurface("dockfixture", "recorder")).toBe("surface-entry-rejected");
  });

  it("keeps a floating surface out of the sidebar list", async () => {
    // Every consumer of `listUiExtensions` renders its entries as in-window
    // panels. A floating surface leaking into it would give the user a sidebar
    // panel the plugin never asked for, alongside the dock slot it did.
    const runtime = await runtimeWith([
      { ...FLOATING, id: "recorder", slot: "floating" },
      { ...FLOATING, id: "settings", slot: "sidebar", title: "Settings" },
    ]);

    const listed = runtime.listUiExtensions();
    expect(listed.map((row) => row.extension.id)).toEqual(["settings"]);
    // Still resolvable through its own lookup — excluded from the list, not
    // from existence.
    expect(runtime.resolveFloatingSurface("dockfixture", "recorder")).toMatchObject({
      extensionId: "recorder",
    });
  });

  it("picks the named extension out of several", async () => {
    const runtime = await runtimeWith([
      { ...FLOATING, id: "levels", title: "Levels" },
      { ...FLOATING, id: "recorder", title: "Recorder" },
    ]);

    expect(runtime.resolveFloatingSurface("dockfixture", "recorder")).toMatchObject({
      extensionId: "recorder",
      title: "Recorder",
    });
  });

  it("does not let a sidebar entry answer for a floating id of the same name", async () => {
    // Two declarations, same id, different slots. Matching on id alone and
    // then checking the slot of whichever came first would make the answer
    // depend on manifest order.
    const runtime = await runtimeWith([
      { ...FLOATING, id: "recorder", slot: "sidebar" },
      { ...FLOATING, id: "recorder", slot: "floating" },
    ]);

    expect(runtime.resolveFloatingSurface("dockfixture", "recorder")).toBe("surface-not-floating");
  });

  it("answers from the registry alone, never from the routing set", () => {
    // What makes the in-process coverage above transfer to the isolated arm,
    // and the reason it is worth an assertion rather than a sentence: the only
    // plugin that uses the dock runs out-of-process, so every other case in
    // this file exercises the arm it does not use.
    //
    // Both arms register through the same `plugins.set` after a successful
    // load, so a resolver that reads only the registry behaves identically on
    // either. One that branched on isolation would be deciding whether a
    // plugin may float based on where it runs — and would do it here, in the
    // gate that puts pixels on top of every other application.
    // Read by PATH, not through `new URL(..., import.meta.url)`. knip resolves
    // the URL form as a dependency edge, which pulls `runtime/index.ts` into
    // this test's graph and silently reclassifies two of its exported types —
    // a source-shape assertion should not move the unused-export baseline.
    const source = readFileSync(
      join(__dirname, "..", "runtime", "index.ts"),
      "utf8",
    );
    const body = source.slice(
      source.indexOf("  resolveFloatingSurface("),
      source.indexOf("  listUiExtensions("),
    );
    // A control on the slice itself: an anchor that stopped matching would
    // leave `body` empty, and every assertion below would pass on nothing.
    expect(body).toContain("return \"unknown-plugin\";");
    expect(body).toContain("this.plugins.get(pluginId)");
    for (const routing of ["isOutOfProcessPlugin", "OUT_OF_PROCESS_PLUGIN_IDS"]) {
      expect(body, `${routing} must not decide whether a surface may float`)
        .not.toContain(routing);
    }
  });
});
