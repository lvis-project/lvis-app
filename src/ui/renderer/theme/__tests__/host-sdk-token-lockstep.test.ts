/**
 * Host ↔ SDK invariant-token lockstep guard.
 *
 * `_INVARIANT` (private to `plugin-token-map.ts`) lists theme-invariant
 * `--lvis-*` values that apply uniformly across all bundles. The same keys
 * also appear in `@lvis/plugin-sdk/src/ui/tokens/fallback-dark.json`, the
 * SDK's offline fallback that plugin webviews use before the host's first
 * `host.theme.changed` broadcast arrives. If the two drift, plugins paint
 * one value pre-broadcast and another post-broadcast — visible jank.
 *
 * This test reads the SDK JSON via Node fs (no bundler involvement, no
 * subpath-export resolution gymnastics) and reconstructs host's invariant
 * subset by running `bundleToPluginTokens` on every registered bundle —
 * invariant tokens are by definition bundle-independent, so they must
 * match for *every* bundle.
 *
 * Drift triggers a hard failure with the offending key + both values.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleToPluginTokens, _INVARIANT_KEYS as INVARIANT_KEYS } from "../plugin-token-map.js";
import { BUNDLES } from "../bundles/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Path walk: this file at `src/ui/renderer/theme/__tests__/host-sdk-token-lockstep.test.ts`
// → 5 levels up reaches the repo root (`__tests__` → `theme` → `renderer`
// → `ui` → `src` → root), then descend into `node_modules/@lvis/plugin-sdk/`.
// node_modules layout is stable per bun.lock — bun does NOT hoist into a
// shared workspace root in this single-package repo, so this resolves
// without a `require.resolve` indirection.
const SDK_FALLBACK_JSON = join(
  __dirname,
  "../../../../..",
  "node_modules/@lvis/plugin-sdk/src/ui/tokens/fallback-dark.json",
);

// `INVARIANT_KEYS` is re-exported from `plugin-token-map.ts` as the single
// SoT for the key list — no parallel array to maintain here. Adding a key
// to `_INVARIANT` there automatically lands it in this gate too.

describe("host ↔ SDK invariant token lockstep", () => {
  const raw = readFileSync(SDK_FALLBACK_JSON, "utf8");
  const sdkJson = JSON.parse(raw) as {
    tokens: Record<string, string>;
  };
  const sdkTokens = sdkJson.tokens;

  it("SDK fallback-dark.json defines every key host considers invariant", () => {
    for (const k of INVARIANT_KEYS) {
      expect(sdkTokens[k], `SDK missing invariant key "${k}"`).toBeDefined();
    }
  });

  // For every bundle, the resulting plugin token map's invariant subset
  // must equal the SDK fallback values. If a designer edits the SDK JSON
  // without updating host's _INVARIANT (or vice versa), this fails fast.
  for (const bundle of BUNDLES) {
    it(`bundle "${bundle.id}" invariant tokens match SDK fallback`, () => {
      const tokens = bundleToPluginTokens(bundle);
      for (const k of INVARIANT_KEYS) {
        expect(
          tokens[k],
          `bundle="${bundle.id}" key="${k}" — host="${tokens[k]}" SDK="${sdkTokens[k]}"`,
        ).toBe(sdkTokens[k]);
      }
    });
  }
});
