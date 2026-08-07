import type { PluginInstallResultPayload } from "../contract/app-contract.js";
import {
  IncompatibleAppVersionError,
  INCOMPATIBLE_APP_VERSION_CODE,
} from "../plugins/public-contract.js";

/** Stable English IPC code for {@link MarketplaceBackendDisabledError}. */
export const MARKETPLACE_DISABLED_CODE = "marketplace-disabled";

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
      : undefined;
  return {
    slug,
    success: false,
    error: code ?? message,
    ...(code ? { message } : {}),
  };
}
