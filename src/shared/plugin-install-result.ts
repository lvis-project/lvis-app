import type { PluginInstallResultPayload } from "../contract/app-contract.js";
import {
  IncompatibleAppVersionError,
  INCOMPATIBLE_APP_VERSION_CODE,
} from "../plugins/public-contract.js";

/** Stable English IPC code for {@link MarketplaceBackendDisabledError}. */
export const MARKETPLACE_DISABLED_CODE = "marketplace-disabled";

/**
 * Stable English IPC code for {@link PluginRevokedError}. Not exported —
 * unlike {@link MARKETPLACE_DISABLED_CODE}, no caller throws/checks this
 * error type directly today; `buildInstallFailureResult` below is the only
 * consumer. The renderer's `formatIpcError` map (`ui/renderer/format-ipc-error.ts`)
 * matches the literal `"plugin-revoked"` string rather than importing this
 * constant, matching how it already treats every other code in that map.
 */
const PLUGIN_REVOKED_CODE = "plugin-revoked";

/**
 * Install refused because the marketplace revocation registry blocks
 * this exact `slug@version` (explicit blocklist) or the version is below
 * the plugin's pinned minimum. Thrown by `assertMarketplaceNotRevoked`
 * (`plugins/plugin-artifact-store.ts`), the install-time twin of the
 * `markRevoked` LOAD-boundary gate in `plugins/runtime/index.ts`.
 *
 * A class (not an inline `new Error(...)`) for the same reason
 * {@link MarketplaceBackendDisabledError} is one: `buildInstallFailureResult`
 * needs to recognise it by type to emit the stable `plugin-revoked` code
 * instead of leaking the raw English sentence into a localized toast.
 */
export class PluginRevokedError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly pluginVersion: string,
    public readonly reasonDetail: string,
  ) {
    super(
      `plugin '${pluginId}@${pluginVersion}' is blocked by the marketplace revocation registry: ${reasonDetail}`,
    );
    this.name = "PluginRevokedError";
  }
}

/**
 * Stable English IPC code for {@link PluginNotAdmittedError}. Follows
 * {@link PLUGIN_REVOKED_CODE}: not exported, because
 * `buildInstallFailureResult` below is the only consumer and the renderer's
 * `formatIpcError` map matches the literal string.
 */
const PLUGIN_NOT_ADMITTED_CODE = "plugin-not-admitted";

/**
 * Install refused because the signed admission catalog does not authorise
 * this exact `slug@version`.
 *
 * The OPPOSITE polarity to {@link PluginRevokedError}, and that is the reason
 * this is a separate error rather than another `ruleKind` on that one.
 * Revocation is a BLOCK list: it fires because the distributor said "not this
 * one". Admission is an ALLOW list: it fires because the distributor did not
 * say anything — the catalog is unreachable, stale, or simply does not name
 * this artifact. Collapsing the two would tell a user their plugin was
 * blocked when in fact the device could not reach the catalog host, which
 * points at the wrong remedy.
 *
 * `refusalCode` carries which condition fired. The renderer keeps one string
 * for the family, so the specific code travels in the message for the log and
 * the audit trail rather than fanning out the locale table.
 */
export class PluginNotAdmittedError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly pluginVersion: string,
    public readonly refusalCode: string,
    public readonly reasonDetail: string,
  ) {
    super(
      `plugin '${pluginId}@${pluginVersion}' is not admitted by the marketplace admission catalog`
        + ` (${refusalCode}): ${reasonDetail}`,
    );
    this.name = "PluginNotAdmittedError";
  }
}

/**
 * Uninstall refused because the package is not installed (plugin, agent, skill).
 *
 * Deliberately NOT the existing `not-found` code. This condition is reached from
 * a catalog entry the user is looking at: the package exists and is listed, it
 * simply has no local installation. `not-found` renders "The requested item
 * could not be found", which is a false statement about a package the user can
 * see, and it points at the wrong remedy (search again, rather than install).
 *
 * One code for all three families rather than three: the toast already names
 * the family in its `{target}` half (`useStatusBarInstall.labelAgent` etc.), so
 * per-family codes would only duplicate that noun in every locale.
 */
export const PACKAGE_NOT_INSTALLED_CODE = "package-not-installed";

/**
 * Uninstall refused because an administrator deployed the plugin.
 *
 * Kept apart from {@link PACKAGE_NOT_INSTALLED_CODE} and from the generic
 * `managed` code because the user's next step differs: nothing they do in the
 * app will remove this plugin, so the copy has to send them to their
 * administrator rather than suggest a retry. `managed` reads "blocked by an
 * administrator policy, or an error occurred while saving" — that "or" makes a
 * permanent refusal look like it might be a transient save failure.
 */
export const ADMIN_PLUGIN_UNINSTALL_DENIED_CODE = "admin-plugin-uninstall-denied";

/**
 * The agent/skill marketplace backend is compiled out of this build, so the
 * artifact store the installer needs does not exist.
 *
 * A class rather than an inline `new Error(...)` at each site because the code
 * and the English sentence have to agree across two producers: the IPC handler
 * returns `{ error: MARKETPLACE_DISABLED_CODE }` to its caller while the
 * deep-link handler broadcasts a failure payload built from the thrown error.
 * Before this existed the deep link threw a bare `Error` and the toast rendered
 * that raw English sentence in a Korean UI.
 *
 * It lives here and not in `plugins/public-contract.ts` because that module is
 * copied mechanically into the SDK and must stay import-free of host concepts;
 * this failure is a host build-configuration fact, not part of the plugin API.
 */
export class MarketplaceBackendDisabledError extends Error {
  constructor(public readonly packageType: "agent" | "skill") {
    super(
      `${packageType === "agent" ? "Agent" : "Skill"} marketplace install is unavailable: `
        + "marketplace backend is disabled in this build.",
    );
    this.name = "MarketplaceBackendDisabledError";
  }
}

/**
 * Producer for the install/uninstall failure payload on all three package
 * families — `plugins.*`, `agents.*` and `skills.*`. Sole constructor of the
 * shape, so the code/message pairing cannot drift between the IPC handlers, the
 * dev local-install handler and the `lvis://` deep link.
 *
 * A recognised failure sends its stable English code in `error` and keeps the
 * concrete English text (which carries the version numbers) in `message`.
 * `formatIpcError(error, message)` on the renderer turns that pair into
 * localized copy; an unrecognised failure has no code, so the plain message
 * goes in `error` and the renderer's fallback surfaces it verbatim.
 *
 * This lives outside `public-contract.ts` deliberately: that module is copied
 * mechanically into the SDK and must stay import-free.
 */
export function buildInstallFailureResult(
  slug: string,
  error: unknown,
  fallbackMessage: string,
): PluginInstallResultPayload {
  const message = (error instanceof Error ? error.message : "") || fallbackMessage;
  const code = error instanceof IncompatibleAppVersionError
    ? INCOMPATIBLE_APP_VERSION_CODE
    : error instanceof MarketplaceBackendDisabledError
      ? MARKETPLACE_DISABLED_CODE
      : error instanceof PluginRevokedError
        ? PLUGIN_REVOKED_CODE
        : error instanceof PluginNotAdmittedError
          ? PLUGIN_NOT_ADMITTED_CODE
          : undefined;
  return {
    slug,
    success: false,
    error: code ?? message,
    ...(code ? { message } : {}),
  };
}
