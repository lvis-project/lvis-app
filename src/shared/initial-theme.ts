/**
 * Wire format for the host's "race window = 0" theme prime — shared between:
 *  - `src/main.ts` (`initialThemeArgs()` — serializes from `lastThemePayload`)
 *  - `src/preload.ts` (`readInitialThemeArg()` — deserializes from `process.argv`)
 *  - `src/ui/renderer/theme/ThemeProvider.tsx` (`readGlobalInitialBundleId()` —
 *    reads the contextBridge-exposed `window.__lvisInitialTheme`)
 *
 * Keeping the prefix + payload shape in one module ensures the three layers
 * cannot drift apart silently. See `architecture.md` §6.7.1.
 *
 * The payload is a deliberate *narrow projection* of `SafeThemePayload`
 * (`src/ipc/domains/plugins.ts`) — only the fields that affect frame-0 paint
 * (`bundleId`, `shell`, `tokens`). Fields the renderer fully hydrates from
 * settings later (`colorScheme`, `reducedMotion`, `fonts`) are intentionally
 * omitted — keeps the argv size small and the contract explicit.
 */

export const INITIAL_THEME_ARG_PREFIX = "--lvis-initial-theme=";

/**
 * Hard ceiling on the JSON payload size embedded in `additionalArguments`.
 * The largest realistic payload (36 tokens × ~50 byte value) fits well under
 * 4 KiB. 16 KiB cap defends against future regressions where a SoT migration
 * silently widens the token allowlist and a single window-spawn cost blows
 * out per-OS argv limits (Windows ~32 KiB, Linux 128 KiB). When the cap is
 * exceeded `initialThemeArgs()` returns `[]` and the renderer falls back to
 * its async settings hydrate path — same as cold-boot.
 */
export const INITIAL_THEME_ARG_MAX_BYTES = 16_384;

export interface InitialThemePrime {
  bundleId: string;
  shell: "light" | "dark";
  tokens?: Record<string, string>;
}
