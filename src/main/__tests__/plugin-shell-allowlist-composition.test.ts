/**
 * #1953 — the two allow-lists that answer "which local file may the plugin UI
 * shell load" must compose, and nothing pinned that relationship.
 *
 * A — `installPluginPartitionPolicy`'s `onBeforeRequest` filter, installed on a
 *     `persist:plugin:*` session. Exact absolute-path equality against two
 *     resolved runtime assets. It sees main-frame requests too, so it cancels
 *     what the navigation policy would have permitted: for a webview in a
 *     policy-registered plugin partition the effective allowance is A.
 * B — `shouldBlockGlobalWebviewNavigation`, applied in `will-navigate`.
 *     `relative()` containment against `dist/src`.
 *
 * Both decisions are taken here from the PRODUCTION functions, and from the
 * same `main-paths` authority the production call sites use (`runtimeAssetPath`
 * for A's two paths, `distRoot` for B's containment root) — the test cannot
 * drift onto a hand-written path that neither gate actually resolves.
 *
 * What is pinned:
 *  1. A ⊆ B — B never cancels a load A permits, so narrowing B onto A's exact
 *     set stays a safe refactor and A stays the binding gate.
 *  2. B \ A is non-empty and A cancels every member — the divergence itself.
 *     Widening A toward B's `dist/src` containment turns this RED; so does
 *     narrowing B onto A's set, which is the deliberate change the issue
 *     suggests and must be made with this expectation updated, not silently.
 *  3. The shell URL A anchors on is the same document B's frame predicate
 *     recognises. If those two ever drift apart the composition above is
 *     vacuous — B's allowance would not apply to the frame A gates.
 */
import { describe, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import { isPluginShellFrameUrl } from "../../shared/plugin-shell-frame.js";
import { installPluginPartitionPolicy } from "../html-preview-partition.js";
import { distRoot, runtimeAssetPath } from "../main-paths.js";
import { shouldBlockGlobalWebviewNavigation } from "../webview-navigation-policy.js";

const onBeforeRequest = vi.fn();
installPluginPartitionPolicy(
  "persist:plugin:allowlist-composition",
  {},
  {
    fromPartition: () =>
      ({
        webRequest: { onBeforeRequest },
        registerPreloadScript: vi.fn(),
      }) as unknown as Electron.Session,
  },
);
const requestFilter = onBeforeRequest.mock.calls[0]![0] as (
  details: { url: string },
  callback: (result: { cancel: boolean }) => void,
) => void;

/** A's verdict, from the callback the production installer registered. */
function partitionFilterAllows(url: string): boolean {
  let cancel = true;
  requestFilter({ url }, (result) => {
    cancel = result.cancel;
  });
  return !cancel;
}

const shellHtmlUrl = pathToFileURL(runtimeAssetPath("plugin-ui-shell.html")).toString();
const shellJsUrl = pathToFileURL(runtimeAssetPath("plugin-ui-shell.js")).toString();
const assetUrl = (...segments: string[]) =>
  pathToFileURL(runtimeAssetPath(...segments)).toString();

/** B's verdict for a navigation issued by the real shell frame. */
function navigationPolicyAllows(url: string): boolean {
  return !shouldBlockGlobalWebviewNavigation({
    url,
    currentUrl: shellHtmlUrl,
    distRoot,
    authOwned: false,
    linkOwned: false,
  });
}

/**
 * Members of `dist/src` that are not shell documents. Named individually rather
 * than globbed: these are the files that make B's width consequential — the
 * host preload, the main-process entry, and the renderer bundle.
 */
const NON_SHELL_DIST_SRC_URLS = [
  assetUrl("preload.cjs"),
  assetUrl("main", "main.js"),
  assetUrl("renderer.js"),
];

describe("plugin shell file allow-lists compose (#1953)", () => {
  it("anchors both gates on the same shell document", () => {
    expect(isPluginShellFrameUrl(shellHtmlUrl)).toBe(true);
    expect(partitionFilterAllows(shellHtmlUrl)).toBe(true);
    expect(navigationPolicyAllows(shellHtmlUrl)).toBe(true);
  });

  it("permits every file the partition filter permits (A ⊆ B)", () => {
    for (const url of [shellHtmlUrl, shellJsUrl]) {
      expect(partitionFilterAllows(url)).toBe(true);
      expect(navigationPolicyAllows(url)).toBe(true);
    }
  });

  it("cancels the dist/src files the navigation policy still permits (B \\ A)", () => {
    expect(NON_SHELL_DIST_SRC_URLS.length).toBeGreaterThan(0);
    for (const url of NON_SHELL_DIST_SRC_URLS) {
      expect(navigationPolicyAllows(url)).toBe(true);
      expect(partitionFilterAllows(url)).toBe(false);
    }
  });

  it("rejects files outside dist/src in both gates", () => {
    const outside = pathToFileURL(runtimeAssetPath("..", "..", "etc", "passwd")).toString();
    expect(partitionFilterAllows(outside)).toBe(false);
    expect(navigationPolicyAllows(outside)).toBe(false);
  });
});
