/**
 * MCP-App per-resource permissions — single source of truth.
 *
 * The MCP Apps spec (`2026-01-26`) lets a UI resource REQUEST powerful features on
 * its `_meta.ui.permissions` (`McpUiResourcePermissions`): each key is an empty
 * object meaning "requested", and an ABSENT key means denied. This module is the one
 * place that maps a declaration to the two mechanisms that can honor it:
 *
 *   1. the `allow` attribute (Permissions Policy) on the inner app iframe, and
 *   2. Electron's session permission handlers on the card's per-server partition.
 *
 * ─── Host-computed, never app-supplied ───────────────────────────────────────
 * Exactly the same trust rule as the CSP: the declaration is MANIFEST / `resources/read`
 * data that main reads, and main COMPUTES both the allow-list string and the Electron
 * grant set from it. Neither the renderer nor the app ever hands us an `allow` string.
 * The tokens below are a closed enum, so a hostile declaration can only ever SELECT
 * from this table — it can never smuggle a token in.
 *
 * ─── Fail-closed ─────────────────────────────────────────────────────────────
 * An absent key is a DENY, and so is a missing declaration entirely.
 * {@link isElectronPermissionGranted} returns `false` for every permission it does not
 * both recognize AND find declared, so an undeclared feature is denied even when the
 * frame asks, and a brand-new Electron permission string defaults to denied.
 */
import type { McpUiResourcePermissions } from "../mcp/types.js";

/** One requestable feature: its declaration key, its Permissions-Policy token, and how Electron names it. */
export interface McpAppPermissionFeature {
  /** The `McpUiResourcePermissions` key a resource declares. */
  readonly key: keyof McpUiResourcePermissions;
  /** The Permissions-Policy token for the iframe `allow` attribute. */
  readonly allowToken: string;
  /**
   * The `permission` string Electron's session handlers receive.
   *
   * camera and microphone BOTH arrive as Electron's single `media` permission — Electron
   * tells them apart only via `details.mediaTypes`. THIS layer is where the split is
   * enforced ({@link electronMediaKind} + {@link isElectronPermissionGranted}), because —
   * measured, not assumed — the host-computed `allow` attribute does NOT gate camera vs
   * microphone for a SAME-ORIGIN inner frame: a card that declared only the microphone
   * (`allow="microphone"`) could still open the camera via `getUserMedia({video})` until
   * this handler started matching on the media kind. So the media-kind check here is the
   * real per-feature chokepoint for camera/microphone, not the `allow` attribute.
   */
  readonly electronPermission: string;
  /**
   * For features Electron collapses into its single `media` permission, WHICH kind this
   * is. `getUserMedia({video})` → `"video"`, `getUserMedia({audio})` → `"audio"`. Undefined
   * for features Electron already names uniquely (e.g. geolocation).
   */
  readonly electronMediaKind?: "video" | "audio";
}

/**
 * The features a resource may request. ORDER IS THE SERIALIZATION ORDER of the `allow`
 * attribute, so the host-computed string is deterministic and diffable.
 *
 * This table is the host's CAPABILITY claim, and it may only contain features an e2e has
 * SHOWN working end to end (`test/e2e/ui/mcp-app-permissions.spec.ts` runs the real APIs
 * in a real <webview>). Adding a key without that proof reintroduces exactly the
 * unhonored knob this design exists to prevent: a manifest could declare it, pass review,
 * and silently do nothing.
 *
 * ─── What is here, and why clipboardWrite is NOT (measured, not assumed) ─────────────
 * The inner app frame carries `allow-same-origin` (spec `apps.mdx:474-475`), so it is a
 * NON-opaque per-server origin — which is exactly what lets camera / microphone /
 * geolocation be delegated and honored. Measured in a real Electron <webview> (Electron
 * 43 / Chromium, Windows): a card that DECLARES the feature gets it (`getUserMedia`
 * resolves, `getCurrentPosition` is not permission-denied); an undeclared card is denied.
 *
 * clipboardWrite is deliberately excluded: measured, a card that declared it — with
 * `clipboard-write` delegated on the frame — STILL got `NotAllowedError: Write permission
 * denied` from `navigator.clipboard.writeText`. A script-initiated async clipboard write
 * with no transient user activation is refused by Chromium regardless of origin or
 * Permissions Policy, so the host cannot make it work; declaring it would be an unhonored
 * knob. (This also inverts the guess in the removal commit 9090c5e8, which supposed
 * clipboardWrite would be the reachable one — it is the opposite.) It remains in the
 * `McpUiResourcePermissions` TYPE because it is the spec's type and an external server may
 * send it on the wire, where it is matched by nothing here and so never granted; and it is
 * absent from the manifest schema, so a plugin declaring it FAILS validation loudly.
 */
export const MCP_APP_PERMISSION_FEATURES: readonly McpAppPermissionFeature[] = [
  { key: "camera", allowToken: "camera", electronPermission: "media", electronMediaKind: "video" },
  { key: "microphone", allowToken: "microphone", electronPermission: "media", electronMediaKind: "audio" },
  { key: "geolocation", allowToken: "geolocation", electronPermission: "geolocation" },
];

/** The feature keys a resource actually declared (present key ⇒ requested). */
export function declaredFeatures(
  permissions?: McpUiResourcePermissions,
): McpAppPermissionFeature[] {
  if (!permissions || typeof permissions !== "object") return [];
  return MCP_APP_PERMISSION_FEATURES.filter((feature) => permissions[feature.key] !== undefined);
}

/**
 * The `allow` attribute for the inner app iframe — host-computed from the declaration.
 *
 * Empty string when nothing is declared, which is the fail-closed default: an iframe
 * with no `allow` attribute is delegated no feature at all.
 */
export function buildMcpAppAllowAttr(permissions?: McpUiResourcePermissions): string {
  return declaredFeatures(permissions)
    .map((feature) => feature.allowToken)
    .join("; ");
}

/**
 * Electron's session permission decision for a card, from that card's declaration.
 *
 * DENY-BY-DEFAULT, and that is the whole contract: a permission is granted only when the
 * declaration names a feature in the table above AND that feature is the one Electron is
 * asking about. Everything else — an undeclared feature, an absent declaration, a
 * permission string we do not model, a permission a future Electron invents — is denied.
 *
 * `mediaKinds` disambiguates the camera/microphone collision. Electron reports both as a
 * single `media` permission and names the actual kind(s) only in `details.mediaTypes`
 * (request) / `details.mediaType` (check). When kinds are given for a kind-collapsed
 * permission, EVERY requested kind must map to a declared feature — so a card that
 * declared only the microphone cannot open the camera. (Measured necessity: for a
 * same-origin inner frame the `allow` attribute does NOT enforce this, so it must be
 * enforced here.) When no kind is given, the decision falls back to the coarse
 * permission-string match; the strict per-kind check runs in the request handler, which
 * is the authoritative grant path for `getUserMedia`.
 *
 * @param permissions the RESOURCE's declaration. `undefined` ⇒ deny everything.
 * @param permission Electron's permission string.
 * @param mediaKinds the requested media kind(s), when Electron supplied them.
 */
export function isElectronPermissionGranted(
  permissions: McpUiResourcePermissions | undefined,
  permission: string,
  mediaKinds?: readonly ("video" | "audio")[],
): boolean {
  const matching = declaredFeatures(permissions).filter(
    (feature) => feature.electronPermission === permission,
  );
  if (matching.length === 0) return false;
  const kindAware = matching.some((feature) => feature.electronMediaKind !== undefined);
  if (kindAware && mediaKinds && mediaKinds.length > 0) {
    // Fail-closed: grant only if EVERY requested kind was declared.
    return mediaKinds.every((kind) =>
      matching.some((feature) => feature.electronMediaKind === kind),
    );
  }
  return true;
}
