/**
 * Which renderer surfaces may leave their pane.
 *
 * The workbench draws every surface about ONE conversation inside that
 * conversation's tile, and every surface about the WINDOW once, in flow, in
 * the window's own chrome (DESIGN.md "Workbench model"; tiled-chat-groups.md
 * "Every other surface a session raises"). `position: fixed` breaks both: a
 * fixed box resolves against the viewport, so it covers the tiles beside its
 * pane and the title bar, at a width the pane never agreed to. The audit log
 * used to do exactly that from inside the Permissions tab.
 *
 * So `fixed` is allowed only where the surface IS about the window and needs
 * viewport coordinates. That set is listed here with the reason each entry is
 * in it; a new `fixed` outside the list fails this test until its reason is
 * written down beside the others. The shared dialog/sheet primitives under
 * `src/components/ui` are Radix portals and sit outside the scanned tree.
 *
 * The same scan holds the stacking ladder (DESIGN.md "Stacking"): floating
 * overlays share the `z-50` band and order themselves by mount order; an
 * arbitrary `z-[N]` or a numeric `zIndex` is drift, listed only where the
 * surface has to sit above every product overlay at once.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RENDERER_DIR = resolve(fileURLToPath(import.meta.url), "../..");

/** Files that may position a box against the viewport, and why. */
const FIXED_POSITIONING_ALLOWED: Record<string, string> = {
  "components/SpotlightTour.tsx":
    "first-boot tour: a backdrop over the whole window, and the anchorless fallback card that centres itself in it; the ring is carried by the anchor and the anchored card by the shared popover",
  "components/McpAppFullscreenPanel.tsx":
    "an MCP app card's fullscreen mount covers the window by design; the card left its tile for it",
  "components/McpAppPipPanel.tsx":
    "the picture-in-picture mount is a window-level slot that follows the viewport, not any one pane",
  "components/InlineSlashMenu.tsx":
    "portaled composer menu anchored to the caret in viewport coordinates, so the pane's overflow clipping cannot cut it",
  "components/ResourceMentionMenu.tsx":
    "portaled composer menu anchored to the caret in viewport coordinates, so the pane's overflow clipping cannot cut it",
  "components/DevToolsPanel.tsx":
    "developer chrome behind LVIS_DEV that inspects the window; not a product surface",
  "components/DevComponentLabels.tsx":
    "developer overlay behind LVIS_DEV that measures the window; it never participates in layout",
};

/** Files that may step off the z ladder with an arbitrary value, and why. */
const Z_LADDER_ESCAPE_ALLOWED: Record<string, string> = {
  "components/DevComponentLabels.tsx":
    "developer measuring overlay that has to label every product surface, the z-50 band included",
};

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** A `fixed` class token in a className, or a `position: "fixed"` style. */
const FIXED_IN_CLASS = /className=\{?["'`](?:[^"'`]*\s)?fixed(?:\s|["'`])/;
const FIXED_IN_STYLE = /position:\s*["']fixed["']/;
const Z_ESCAPE = /\bz-\[\d+\]|zIndex:\s*\d/;

function offenders(pattern: RegExp[]): string[] {
  const hits = new Set<string>();
  for (const file of listSourceFiles(RENDERER_DIR)) {
    const source = readFileSync(file, "utf8");
    for (const line of source.split("\n")) {
      if (pattern.some((re) => re.test(line))) hits.add(relative(RENDERER_DIR, file));
    }
  }
  return [...hits].sort();
}

describe("renderer surfaces stay inside their pane", () => {
  it("uses fixed positioning only in the window-level surfaces listed with a reason", () => {
    const fixed = offenders([FIXED_IN_CLASS, FIXED_IN_STYLE]);
    const unlisted = fixed.filter((file) => !(file in FIXED_POSITIONING_ALLOWED));
    expect(unlisted, "fixed positioning outside the allow-list — a surface escaping its pane").toEqual([]);
    // The list is a residual, not a registry: an entry whose file no longer
    // positions against the viewport comes off it.
    const stale = Object.keys(FIXED_POSITIONING_ALLOWED).filter((file) => !fixed.includes(file));
    expect(stale, "allow-list entries that no longer use fixed positioning").toEqual([]);
  });

  it("keeps every overlay on the documented z ladder", () => {
    const escapes = offenders([Z_ESCAPE]);
    const unlisted = escapes.filter((file) => !(file in Z_LADDER_ESCAPE_ALLOWED));
    expect(unlisted, "arbitrary z-index outside the ladder").toEqual([]);
    const stale = Object.keys(Z_LADDER_ESCAPE_ALLOWED).filter((file) => !escapes.includes(file));
    expect(stale, "allow-list entries that no longer escape the ladder").toEqual([]);
  });
});
