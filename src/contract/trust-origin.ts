/**
 * TrustOrigin — the ORIGIN axis of an inbound request to the app's public wire
 * contract. (#1409 contract SOT.)
 *
 * This is DISTINCT from the 5-second user-keyboard gesture token
 * (`hasUserKeyboardIntent` / `requireUserKeyboardIntent` in the permissions
 * layer — see `src/shared/chat-origin.ts` and `src/ipc/domains/permissions.ts`).
 * They answer different questions and are orthogonal:
 *
 *   - ORIGIN answers "WHO is calling" — the first-party host renderer, a local
 *     API / CLI companion bound to loopback, or a sandboxed plugin webview frame.
 *   - the GESTURE token answers "did a human physically act in the last ~5 s".
 *
 * Gesture ≠ origin:
 *
 *   - A `renderer` origin call can still LACK a fresh gesture (e.g. a synthetic
 *     submission from a compromised frame) — so gesture-gated mutating channels
 *     reject it even though the origin is trusted.
 *   - Conversely, a fresh gesture never UPGRADES a non-renderer origin's trust.
 *
 * Therefore, the invariant the contract encodes: **mutating gesture-gated
 * channels (the permission / policy / sandbox-install family) require the
 * user-keyboard gesture REGARDLESS of origin.** Origin alone never satisfies a
 * gesture requirement, and gesture alone never satisfies an origin requirement.
 *
 * Grounding for the seam: `validateSender` in `src/ipc/gated.ts` accepts
 * `file://` (packaged renderer) AND `http://localhost` / `http://127.0.0.1`
 * (dev server) frames. A future local API bound to loopback would therefore
 * inherit renderer-equivalent frame trust at the transport layer. Tagging that
 * path `"local-api"` — rather than conflating it with `"renderer"` — keeps the
 * origin axis explicit for the C12 wiring that will consume this type.
 *
 * No behavior is wired to this type yet — it is consumed in C12.
 */
export type TrustOrigin = "renderer" | "local-api" | "cli" | "plugin-frame";

/**
 * Origins that are NOT the first-party in-process host renderer. A future
 * external-surface gate (local API / CLI / SDK) applies stricter defaults to
 * these than to the renderer. Frozen so it cannot be mutated at runtime.
 */
export const EXTERNAL_ORIGINS = ["local-api", "cli", "plugin-frame"] as const;

/** The non-renderer origins, as a type. */
export type ExternalOrigin = (typeof EXTERNAL_ORIGINS)[number];

/** Narrowing helper: is this origin external to the host renderer? */
export function isExternalOrigin(origin: TrustOrigin): origin is ExternalOrigin {
  return (EXTERNAL_ORIGINS as readonly TrustOrigin[]).includes(origin);
}
