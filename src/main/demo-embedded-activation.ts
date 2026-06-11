/**
 * Embedded activation key — build-time provisioned activation string.
 *
 * `scripts/build-main-esbuild.mjs` resolves an activation string at build
 * time (from `LVIS_EMBED_DEMO_ACTIVATION` env or by encrypting the
 * gitignored repo-root `.env.demo` with the shared codec) and injects it
 * into the bundle as the `__LVIS_EMBEDDED_DEMO_ACTIVATION_CODE__` define.
 * Builds produced without either source embed an empty string, and the
 * login flow keeps today's manual paste input.
 *
 * Threat model (extends `demo-activation-codec.ts`):
 *   - The codec's documented model is 2-factor delivery — binary carries
 *     the obfuscated passphrase, the activation string travels through a
 *     separate internal channel. Embedding the string collapses that to
 *     1-factor for builds produced WITH an embed source: the binary alone
 *     is sufficient to recover the demo credentials.
 *   - This is an explicit owner decision for internal-distribution builds
 *     (zero-input demo activation on fresh installs). The activation
 *     string itself never enters git: the embed source is a gitignored
 *     file or an env var on the packaging machine, and the value only
 *     exists inside the produced bundle.
 *   - Public/CI builds without an embed source are unaffected and retain
 *     the full 2-factor model.
 *
 * Why a dedicated module (not inlined in `ipc/domains/demo.ts`):
 *   - The compile-time define is bundle-shape coupling. Isolating the
 *     single `typeof` probe here keeps the IPC domain testable without
 *     esbuild and gives tests one seam (`_setEmbeddedActivationCodeForTest`)
 *     instead of a global.
 */

declare const __LVIS_EMBEDDED_DEMO_ACTIVATION_CODE__: string | undefined;

/**
 * Test seam. `undefined` (the default) means "use the compile-time
 * define"; `null` simulates a build without an embedded key; a string
 * simulates an embedded build. Mirrors the `_reset*ForTest` convention
 * used by `boot/managed-marketplace.ts`.
 */
let embeddedCodeOverrideForTest: string | null | undefined;

export function _setEmbeddedActivationCodeForTest(
  code: string | null | undefined,
): void {
  embeddedCodeOverrideForTest = code;
}

/**
 * The build-time embedded activation string, or `null` when this build
 * was produced without one. `typeof` probe (not a bare read) so contexts
 * that run the TypeScript source without the esbuild define — vitest,
 * tsc — resolve to `null` instead of throwing a ReferenceError.
 */
export function getEmbeddedActivationCode(): string | null {
  const raw =
    embeddedCodeOverrideForTest !== undefined
      ? embeddedCodeOverrideForTest
      : typeof __LVIS_EMBEDDED_DEMO_ACTIVATION_CODE__ === "string"
        ? __LVIS_EMBEDDED_DEMO_ACTIVATION_CODE__
        : null;
  if (raw === null) return null;
  const code = raw.trim();
  return code.length > 0 ? code : null;
}
